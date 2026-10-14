/**
 * 验证 1 · 真实模型能否驱动管家-仆人编排
 *
 * 目的：**排除最高风险假设**——如果真实 LLM 无法稳定输出结构化路由决策、
 *       任务分解与汇报，整个方案的编排部分就不成立。
 *       这个假设无法靠推理确认，必须实测。
 *
 * 通过条件（四条，全部可判定）：
 *   ① 真实模型能输出结构化路由决策（通过 Zod 校验）
 *   ② 能输出结构化任务分解（含依赖关系且引用合法）
 *   ③ 仆人能按 findings 格式结构化汇报
 *   ④ 全程事件通过四条不变量校验（append 时不抛错即通过）
 *
 * 运行：pnpm validate:1
 */

import { deepSeekConfigFromEnv, DeepSeekModel } from '../adapters/model/deepseek.js';
import { SystemClock } from '../adapters/clock/system.js';
import { runSession } from '../core/runtime/orchestrator.js';
import type { RecallResult } from '../core/butler/dispatch.js';
import type { MemoryEntry } from '../core/memory/types.js';

// ═══════════════════════════════════════════════════════════
// 场景数据：等价于"已积累一段时间的记忆库"
// ═══════════════════════════════════════════════════════════

const T = 1_760_000_000_000;
const mem = (
  id: string,
  memClass: MemoryEntry['memClass'],
  content: string,
  confidence: number,
): MemoryEntry => ({
  id,
  owner: { kind: 'butler', userId: 'u_demo' },
  memClass,
  kind: 'fact',
  content,
  confidence,
  evidence: [`evt_seed_${id}`],
  fitness: confidence,
  lifecycle: 'active',
  lastHitAt: T,
  hitCount: 3,
  revivedCount: 0,
  scope: memClass === 'domain' ? 'domain' : 'global',
  version: 1,
  createdAt: T - 86_400_000,
  updatedAt: T - 86_400_000,
  useCount: 3,
});

const SCENARIO = {
  userGoal: '周末想请小李来我家里吃饭（在家做，不去外面吃），他最近在健身。帮我安排一下。',
  recalled: [
    { memory: mem('m_allergy', 'global_constraint', '你对花生严重过敏', 0.98), relevance: 0.94 },
    { memory: mem('m_li', 'global_shared', '小李是你的朋友，素食者', 0.95), relevance: 0.91 },
    { memory: mem('m_fat', 'global_shared', '你正在减脂期，需控制高油高盐', 0.88), relevance: 0.83 },
    { memory: mem('m_pref', 'domain', '你偏好离家 3 公里内的餐厅', 0.79), relevance: 0.72 },
  ] as RecallResult[],
};

// ═══════════════════════════════════════════════════════════
// 执行与断言
// ═══════════════════════════════════════════════════════════

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  checks.push({ name, pass, detail });
};

const line = (s = ''): void => console.log(s);
const hr = (t: string): void => {
  line();
  line('─'.repeat(72));
  line(`  ${t}`);
  line('─'.repeat(72));
};

async function main(): Promise<void> {
  line();
  line('╔' + '═'.repeat(70) + '╗');
  line('║  验证 1 · 真实模型驱动管家-仆人编排' + ' '.repeat(33) + '║');
  line('╚' + '═'.repeat(70) + '╝');

  const model = new DeepSeekModel(deepSeekConfigFromEnv());
  const clock = new SystemClock();
  line(`  模型：${model.describe().provider} / ${model.describe().model}`);
  line(`  目标：${SCENARIO.userGoal}`);
  line(`  召回：${SCENARIO.recalled.length} 条记忆（含 1 条硬约束）`);

  hr('执行中…');
  const t0 = Date.now();
  const result = await runSession({
    model,
    clock,
    sessionId: 's_validate_01',
    userGoal: SCENARIO.userGoal,
    recalled: SCENARIO.recalled,
  });
  const elapsed = Date.now() - t0;

  // ── 条件 ① 路由 ──
  hr('① 结构化路由决策');
  line(`  仆人      : ${result.routing.servant}`);
  line(`  置信度    : ${result.routing.confidence}`);
  line(`  理由      : ${result.routing.reason}`);
  check(
    '① 路由决策结构合法',
    typeof result.routing.servant === 'string' && result.routing.confidence >= 0,
    `${result.routing.servant} @ ${result.routing.confidence}`,
  );
  check('① 置信度达到阈值', result.confident, result.confident ? '可继续派发' : '转入澄清');

  // ── 条件 ② 任务分解 ──
  hr('② 结构化任务分解');
  check('② 分解出步骤', result.steps.length > 0, `${result.steps.length} 步`);
  for (const s of result.steps) {
    line(
      `  ${s.stepId.padEnd(7)} [${String(s.servant).padEnd(7)}] ${s.instruction.slice(0, 40)}` +
        (s.dependsOn.length ? `  ← 依赖 ${s.dependsOn.join(',')}` : ''),
    );
  }
  const allDepsValid = result.steps.every((s) => {
    const known = new Set(result.steps.map((x) => x.stepId));
    return s.dependsOn.every((d) => known.has(d) && d !== s.stepId);
  });
  check('② 依赖引用合法', allDepsValid, allDepsValid ? '无悬空/自引用' : '存在非法依赖');

  // ── 条件 ②b 约束注入 ──
  const injectedEvents = result.log.byType('constraint.injected');
  const totalInjected = result.steps.reduce((n, s) => n + s.injectedConstraints.length, 0);
  hr('②b 约束注入（可审计）');
  line(`  注入事件  : ${injectedEvents.length} 条`);
  for (const s of result.steps) {
    for (const c of s.injectedConstraints) {
      line(`  ${s.stepId} ← ${c.negotiable ? '⚠️ 可协商' : '🔒 不可覆盖'}  ${c.content}`);
    }
  }
  check('②b 硬约束被注入到相关步骤', totalInjected > 0, `${totalInjected} 条约束`);
  const hardInjected = result.steps.some((s) =>
    s.injectedConstraints.some((c) => !c.negotiable && c.content.includes('花生')),
  );
  check('②b 花生过敏（硬约束）已送达', hardInjected, hardInjected ? '不可覆盖' : '未送达');

  // ── 条件 ③ 仆人汇报 ──
  hr('③ 仆人结构化汇报');
  check('③ 收到仆人汇报', result.reports.length > 0, `${result.reports.length} 份`);
  let findingCount = 0;
  let uncertaintyCount = 0;
  for (const rep of result.reports) {
    line(`  [${rep.servant}] status=${rep.status}  产出物=${rep.artifacts.length}`);
    for (const a of rep.artifacts) {
      const text = Array.isArray(a.content) ? a.content.join('；') : String(a.content);
      line(`     · ${a.kind}: ${text.slice(0, 60)}`);
    }
    for (const f of rep.findings ?? []) {
      findingCount += 1;
      line(`     ⚑ [${f.kind}] ${f.statement.slice(0, 50)}`);
    }
    for (const u of rep.uncertainties) {
      uncertaintyCount += 1;
      line(`     ? ${u.slice(0, 55)}`);
    }
    const findingsWellFormed = (rep.findings ?? []).every(
      (f) => typeof f.statement === 'string' && Array.isArray(f.evidence),
    );
    check(`③ ${rep.servant} 的 findings 结构合法`, findingsWellFormed);
  }
  line(`  合计 findings ${findingCount} 条 · uncertainties ${uncertaintyCount} 条`);

  // ── 条件 ④ 事件不变量 ──
  hr('④ 事件不变量');
  const events = result.log.all();
  const seqOk = events.every((e, i) => e.seq === i + 1);
  const parentsOk = events.every((e) => {
    if (!e.parentEventId) return true;
    const p = events.find((x) => x.id === e.parentEventId);
    return p !== undefined && p.seq < e.seq;
  });
  const servantActorOk = events.every((e) => e.actor !== 'servant' || !!e.servantId);
  line(`  事件总数  : ${events.length}`);
  line(`  I1 seq    : ${seqOk ? '✓ 单调无空洞' : '✗ 异常'}`);
  line(`  I2 因果链 : ${parentsOk ? '✓ 合法' : '✗ 异常'}`);
  line(`  I4 actor  : ${servantActorOk ? '✓ servant 均带 servantId' : '✗ 异常'}`);
  check('④ I1 seq 单调无空洞', seqOk, `${events.length} 条`);
  check('④ I2 因果链合法', parentsOk);
  check('④ I4 servant 均带 servantId', servantActorOk);

  // 事件类型分布
  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  line('');
  line('  事件类型分布：');
  for (const [type, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    line(`    ${type.padEnd(24)} ${n}`);
  }

  // ── 条件 ⑤ 硬约束机械校验（确定性）──
  hr('⑤ 硬约束机械校验（确定性，不依赖模型）');
  if (result.hardConstraints.verdicts.length === 0) {
    line('  （本次无硬约束）');
  }
  for (const v of result.hardConstraints.verdicts) {
    line(`  ${v.satisfied ? '✓' : '⛔'} ${v.content}`);
    if (!v.satisfied) {
      line(`      未处理者：${v.unhandledBy.join(', ')}`);
      line(`      → 已写入 constraint.hardBlocked 事件（机械拦截）`);
    } else {
      line(`      所有产出方均已处理`);
    }
  }
  const deterministicBlocks = result.log
    .byType('constraint.hardBlocked')
    .filter((e) => (e.payload as { deterministic?: boolean })?.deterministic === true);
  line(`  确定性拦截事件：${deterministicBlocks.length} 条`);
  check(
    '⑤ 硬约束机械校验已执行',
    result.hardConstraints.verdicts.length > 0,
    `${result.hardConstraints.verdicts.length} 条硬约束受检`,
  );

  // ── 条件 ⑥ LLM 监督 ──
  hr('⑥ 管家监督校验（LLM：软约束与跨领域矛盾）');
  line(`  结论：${result.supervision.summary}`);
  for (const c of result.supervision.conflicts) {
    const icon = c.severity === 'block' ? '⛔' : c.severity === 'warn' ? '⚠️' : 'ℹ️';
    line(`  ${icon} [${c.severity}/${c.kind}] ${c.message.slice(0, 62)}`);
    if (c.parties.length) line(`      涉及：${c.parties.join(', ')}`);
  }
  check('⑥ 监督完成并给出结论', result.supervision.summary.length > 0);

  // ── 汇总 ──
  hr('结果汇总');
  const passed = checks.filter((c) => c.pass).length;
  for (const c of checks) {
    line(`  ${c.pass ? '✓' : '✗'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  line();
  line(`  通过 ${passed}/${checks.length}`);
  line(`  耗时 ${elapsed} ms`);
  line(
    `  用量 输入 ${result.totalUsage.inputTokens} tok / 输出 ${result.totalUsage.outputTokens} tok`,
  );
  line(`  提示词版本：${result.log.byType('route.decided')[0]?.payload !== undefined ? '已记录于事件' : '未记录'}`);

  const allPass = passed === checks.length;
  line();
  line(allPass ? '  ▶ 验证 1 通过：真实模型可以驱动本编排' : '  ▶ 验证 1 未通过：见上方 ✗ 项');
  line();

  process.exit(allPass ? 0 : 1);
}

main().catch((err: unknown) => {
  line();
  line('  ✗ 执行失败：');
  line(`    ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    line();
    line(err.stack.split('\n').slice(1, 6).join('\n'));
  }
  process.exit(1);
});
