/**
 * 验证 2 · 记忆治理全链路闭环
 *
 * 目的：证明**四个创新点串起来真的成立**，而不只是各自有测试。
 *
 * 这条链路是：
 *   ① 召回（分权过滤 + 适应度加权）
 *   ② 编排（路由 → 分解 → 派发 → 硬约束机械校验）
 *   ③ 检查点（时间轴 → 预览 → 回退，**保留前置成果**）
 *   ④ 反思（分层 + 隔离）→ 候选落库 → 用户审核
 *   ⑤ 效果验证 → 适应度演化 → 休眠/唤醒
 *
 * 通过条件（全部可判定）：
 *   A. 回退保留前置成果：s1 的产出在回退后仍然存在
 *   B. 级联失效：删除被引用的记忆后，相关检查点不可回退
 *   C. 确定性：同一事件流重放两次状态哈希一致
 *   D. 反思隔离：仆人反思材料不含他域/敏感/全局内容
 *   E. 候选不直接生效：反思产出进候选池，需审核才进召回
 *   F. 演化闭环：效果反馈改变适应度，低适应度会休眠，再命中会唤醒
 *
 * 运行：pnpm validate:2
 * ⚠️ 本验证**不调用真实模型** —— 用 MockModel 保证确定性与零 token 消耗。
 *    真实模型的能力验证在验证 1（pnpm validate:1）。
 */

import { MockModel } from '../adapters/model/mock.js';
import { CheckpointManager } from '../core/checkpoint/manager.js';
import { replay, stateHashOf } from '../core/checkpoint/replay.js';
import { EventLog } from '../core/events/log.js';
import { EvolutionEngine } from '../core/memory/evolution.js';
import { recall } from '../core/memory/recall.js';
import { sinkCandidates } from '../core/memory/sink.js';
import { MemoryStore } from '../core/memory/store.js';
import type { MemoryCandidate } from '../core/reflection/reflect.js';
import { buildServantReflectionInput, reflectButler, reflectServant } from '../core/reflection/reflect.js';
import { FixedClock, SeededRandom } from '../core/ports/clock.js';
import type { ServantId, ServantReport } from '../core/servants/types.js';

const T0 = 1_760_000_000_000;
const DAY = 86_400_000;
const USER = 'u_demo';

// ── 输出工具 ──
const line = (s = ''): void => console.log(s);
const hr = (t: string): void => {
  line();
  line('─'.repeat(72));
  line(`  ${t}`);
  line('─'.repeat(72));
};

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  checks.push({ name, pass, detail });
};

// ═══════════════════════════════════════════════════════════
// 场景
// ═══════════════════════════════════════════════════════════

const USER_GOAL = '周末想请小李来我家里吃饭（在家做），他最近在健身。帮我安排一下。';

async function main(): Promise<void> {
  line();
  line('╔' + '═'.repeat(70) + '╗');
  line('║  验证 2 · 记忆治理全链路闭环' + ' '.repeat(41) + '║');
  line('╚' + '═'.repeat(70) + '╝');

  const clock = new FixedClock(T0);
  const log = new EventLog('s_validate_02');
  const store = new MemoryStore(log, clock, USER);
  const random = new SeededRandom(20261014);
  const engine = new EvolutionEngine({ log, store, clock, random, userId: USER });
  const mgr = new CheckpointManager({ log, clock });

  const butler = { kind: 'butler', userId: USER } as const;
  const user = { kind: 'user', userId: USER } as const;

  // ── 铺一份"已积累一段时间"的记忆库 ──
  hr('准备：等价于已积累一段时间的记忆库');
  const seed = (
    memClass: Parameters<typeof store.create>[1]['memClass'],
    kind: Parameters<typeof store.create>[1]['kind'],
    content: string,
    confidence: number,
    domainOwner?: ServantId,
  ): string => {
    const r = store.create(butler, {
      memClass,
      kind,
      content,
      confidence,
      evidence: ['evt_seed'],
      lifecycle: 'active',
      ...(domainOwner !== undefined ? { domainOwner } : {}),
    });
    if (!r.ok) throw new Error(`seed 失败：${r.reason}`);
    return r.entry.id;
  };

  const mAllergy = seed('global_constraint', 'fact', '你对花生严重过敏', 0.98);
  const mLi = seed('global_shared', 'fact', '小李是你的朋友，素食者', 0.95);
  const mFat = seed('global_shared', 'preference', '你正在减脂期，需控制高油高盐', 0.88);
  const mDist = seed('domain', 'preference', '你偏好离家 3 公里内的餐厅', 0.79, 'life');
  // ⚠️ 这条特意归到「代码仆人」域 —— 用来验证"他域记忆不会被生活仆人看到"。
  //    我一度把归属写成 'life' 却按"他域"断言，导致验证自己前后矛盾。
  const mCom = seed('domain', 'preference', 'Excel 批量处理优先走 COM 接口', 0.91, 'code');
  const mPsych = seed('global_shared', 'fact', '心理咨询：近期压力较大', 0.9);

  // 把它改成敏感域（模拟用户把某条信息划为敏感）
  store.forget(user, mPsych);
  const mSensitive = store.create(butler, {
    memClass: 'sensitive',
    kind: 'fact',
    content: '心理咨询：近期压力较大',
    confidence: 0.9,
    evidence: ['evt_seed'],
    lifecycle: 'active',
  });
  const sensitiveId = mSensitive.ok ? mSensitive.entry.id : '';

  line(`  记忆库规模：${store.size()} 条`);
  line(`  其中硬约束 ${store.list({ memClass: 'global_constraint' }).length} 条 · 敏感域 ${store.list({ memClass: 'sensitive' }).length} 条`);

  // ═══════════════════════════════════════════════════════
  // ① 召回
  // ═══════════════════════════════════════════════════════

  hr('① 召回（分权过滤 + 适应度加权 + 硬约束恒召回）');

  const lifeVisible = store.visibleTo({ kind: 'butler', userId: USER });
  const lifeRecall = recall({
    query: USER_GOAL,
    candidates: lifeVisible,
    limit: 6,
    now: clock.now(),
    random,
    favoredServant: 'life',
  });

  line(`  单执行者可见 ${lifeVisible.length} 条（敏感域仍被隔离）`);
  for (const s of lifeRecall.selected) {
    line(`    · ${s.memory.content.slice(0, 34)}  [${s.score.toFixed(2)}]${s.exploratory ? ' 🔍探索' : ''}`);
  }

  check('① 硬约束被召回', lifeRecall.selected.some((s) => s.memory.id === mAllergy), '花生过敏');
  check(
    '① 敏感域未进入可见集合（安全底线）',
    !lifeVisible.some((m) => m.id === sensitiveId),
    '心理咨询内容被隔离',
  );
  /**
   * ⚠️ v7（A2）：这条检查的**语义变了**。
   *
   * 旧：「他域记忆未进入可见集合」—— 领域是权限边界
   * 新：「领域标签被正确保留，但**不构成**隔离」
   *
   *   ★ 不能简单删掉这条检查 —— 它会失去"领域标签有没有被正确记录"的覆盖。
   *     改为断言相反方向：他域记忆**看得见**，且标签正确。
   */
  check(
    '① 领域标签保留但不构成隔离（v7：领域已降级为标签）',
    lifeVisible.some((m) => m.id === mCom) &&
      lifeVisible.find((m) => m.id === mCom)?.domain === 'code',
    'COM 接口偏好属代码域，标签正确且可见',
  );
  line(`  召回阈值 ${lifeRecall.threshold.toFixed(2)}（随库规模自适应）`);

  // ═══════════════════════════════════════════════════════
  // ② 编排（用确定脚本，不调真实模型）
  // ═══════════════════════════════════════════════════════

  hr('② 编排（路由 → 分解 → 派发 → 硬约束机械校验）');

  // 铺一条与真实模型跑出来等价的事件流
  const at = (n: number): number => T0 + n * 1000;
  log.append({ type: 'thought.done', actor: 'butler', payload: { stage: 'understand', userGoal: USER_GOAL }, createdAt: at(0) });
  log.append({ type: 'memory.recalled', actor: 'butler', payload: { count: lifeRecall.selected.length }, createdAt: at(1) });
  engine.recordHit(mAllergy);
  engine.recordHit(mLi);
  log.append({ type: 'route.decided', actor: 'butler', payload: { servant: 'life', confidence: 0.75, confident: true }, createdAt: at(2) });

  const steps = [
    { stepId: 's1', servant: 'life' },
    { stepId: 's2', servant: 'health' },
    { stepId: 's3', servant: 'work' },
  ];
  log.append({ type: 'dispatch.created', actor: 'butler', payload: { goal: USER_GOAL, steps }, createdAt: at(3) });
  log.append({ type: 'constraint.injected', actor: 'butler', payload: { stepId: 's1', memoryId: mAllergy, negotiable: false }, createdAt: at(4) });

  log.append({ type: 'dispatch.stepStarted', actor: 'butler', payload: { stepId: 's1', servant: 'life' }, createdAt: at(5) });
  const lifeReport: ServantReport = {
    taskId: 's1',
    servant: 'life',
    status: 'done',
    reply: '菜单已出：全素无花生，三菜一饭，主食杂粮饭。采购清单也列好了。',
    artifacts: [
      { kind: 'plan', content: ['全素无花生菜单', '番茄炖菜、清炒西兰花、杂粮饭', '明确排除花生油与花生酱'] },
      { kind: 'list', content: ['糙米 300g', '北豆腐 2 盒', '西兰花 2 颗'] },
    ],
    memoryRefs: [mAllergy, mLi],
    uncertainties: ['不知道聚餐人数'],
    findings: [{ kind: 'constraintRef', statement: '菜单已全程排除花生', evidence: ['逐条核对'] }],
  };
  log.append({
    type: 'servant.report',
    actor: 'servant',
    servantId: 'life',
    payload: {
      taskId: 's1',
      status: 'done',
      artifacts: lifeReport.artifacts,
      findings: lifeReport.findings,
      // ★ 必须写进 payload —— 检查点正是靠它建立「依赖了哪些记忆」
      memoryRefs: lifeReport.memoryRefs,
      usage: { inputTokens: 900, outputTokens: 500 },
    },
    createdAt: at(6),
  });
  log.append({ type: 'dispatch.stepDone', actor: 'butler', payload: { stepId: 's1', servant: 'life', status: 'done' }, createdAt: at(7) });
  log.append({ type: 'artifact.created', actor: 'butler', payload: { artifactId: 'art_menu', label: '全素无花生菜单' }, createdAt: at(8) });

  log.append({ type: 'dispatch.stepStarted', actor: 'butler', payload: { stepId: 's2', servant: 'health' }, createdAt: at(9) });
  const healthReport: ServantReport = {
    taskId: 's2',
    servant: 'health',
    status: 'done',
    reply: '12 道菜逐条核对过：无花生、无花生油、无花生酱。豆瓣酱是交叉污染的风险点，要留意。',
    artifacts: [{ kind: 'text', content: '逐条核对 12 道菜：无花生、无花生油、无花生酱。豆瓣酱为交叉污染风险点。' }],
    memoryRefs: [mAllergy, mFat],
    uncertainties: ['预包装调味料的配料表无法核实'],
    findings: [
      { kind: 'constraintRef', statement: '花生过敏硬约束已满足', evidence: ['12 道菜逐条核对'] },
      { kind: 'risk', statement: '豆瓣酱为交叉污染风险点', evidence: ['生产线共用'], constraintRef: mAllergy },
    ],
  };
  log.append({
    type: 'servant.report',
    actor: 'servant',
    servantId: 'health',
    payload: {
      taskId: 's2',
      status: 'done',
      artifacts: healthReport.artifacts,
      findings: healthReport.findings,
      memoryRefs: healthReport.memoryRefs,
      usage: { inputTokens: 1100, outputTokens: 600 },
    },
    createdAt: at(10),
  });
  log.append({ type: 'dispatch.stepDone', actor: 'butler', payload: { stepId: 's2', servant: 'health', status: 'done' }, createdAt: at(11) });

  log.append({
    type: 'conflict.detected',
    actor: 'supervisor',
    payload: { message: '单餐植物蛋白约 24g/人，处于健身下限，是否加量属软性取舍', severity: 'warn', parties: ['life', 'health'] },
    createdAt: at(12),
  });
  log.append({ type: 'conflict.resolved', actor: 'user', payload: { resolution: '加量毛豆与天贝' }, createdAt: at(13) });
  log.append({ type: 'artifact.created', actor: 'butler', payload: { artifactId: 'art_menu_v2', label: '菜单 v2（加量版）' }, createdAt: at(14) });
  log.append({ type: 'session.ended', actor: 'butler', payload: {}, createdAt: at(15) });

  const reportsForReflection = [lifeReport, healthReport];
  line(`  事件流 ${log.length} 条`);
  line(`  步骤：${steps.map((s) => `${s.stepId}(${s.servant})`).join(' → ')}`);

  check('② 事件序无空洞', log.all().every((e, i) => e.seq === i + 1), `${log.length} 条`);

  // ═══════════════════════════════════════════════════════
  // ③ 检查点与回退
  // ═══════════════════════════════════════════════════════

  hr('③ 检查点与回退（保留前置成果）');

  const added = mgr.sync();
  line(`  检查点 ${added.length} 个（事件 ${log.length} 条 → 关键决策点）：`);
  for (const c of mgr.all()) {
    line(`    seq ${String(c.seq).padStart(2)}  ${c.label}`);
  }

  const menuV1 = mgr.all().find((c) => c.label.includes('全素无花生菜单'));
  if (!menuV1) throw new Error('未找到「全素无花生菜单」检查点');

  const plan = mgr.planRollback(menuV1.id);
  line();
  line(`  ── 回退预览：至 seq ${plan.toSeq}（${plan.target.label}）──`);
  line(`     保留步骤  ${plan.keepSteps.join(', ') || '（无）'}`);
  line(`     重做步骤  ${plan.redoSteps.join(', ') || '（无）'}`);
  line(`     丢弃事件  ${plan.discardedEvents} 条`);
  for (const a of plan.artifactImpact) {
    line(`     产出物    ${a.action === 'keep' ? '✓ 保留' : '⚠ 取代'}  ${a.label}`);
  }
  const reviewMem = plan.memoryImpact.filter((m) => m.action === 'review');
  if (reviewMem.length > 0) line(`     待复核记忆 ${reviewMem.length} 条`);

  check('A 保留前置成果', plan.keepSteps.includes('s1'), plan.keepSteps.join(', '));
  check('A 重做范围正确', plan.redoSteps.includes('s2'), plan.redoSteps.join(', '));
  check(
    'A 被取代产出物不删除',
    plan.artifactImpact.some((a) => a.action === 'supersede'),
    '菜单 v2 标记为取代而非移除',
  );

  const rb = mgr.rollback(menuV1.id);
  line();
  line(`  ── 执行回退 ──`);
  line(`     seq ${rb.fromSeq} → ${rb.toSeq}`);
  line(`     丢弃 ${rb.discarded.length} 条事件（已返回供归档，非删除）`);
  line(`     取代产出物 ${rb.superseded.join(', ') || '（无）'}`);
  line(`     状态哈希 ${rb.stateHash}`);

  const replayed = replay(log.all());
  line(`     重放后已完成步骤：${replayed.state.completedSteps.join(', ') || '（无）'}`);
  check('A 回退后 s1 成果保留', replayed.state.completedSteps.includes('s1'), '只重做 s2/s3');
  check('A 回退落事件可审计', log.byType('session.rollback').length === 1);

  // ═══════════════════════════════════════════════════════
  // ④ 级联失效
  // ═══════════════════════════════════════════════════════

  hr('④ 级联失效（引用的记忆被删 → 检查点不可用）');

  // 先看检查点到底依赖了哪些记忆 —— 这是修复后的新语义：
  // 只有 `constraint.injected` 与 `servant.report.memoryRefs` 构成依赖
  line('  检查点的记忆依赖：');
  let anyDep = false;
  for (const c of mgr.all()) {
    if (c.snapshot.memories.length === 0) continue;
    anyDep = true;
    line(`    seq ${String(c.seq).padStart(2)} ${c.label} → [${c.snapshot.memories.map((m) => m.memoryId).join(', ')}]`);
  }
  if (!anyDep) line('    （无）');

  // ── 验证 ①：删掉**没有被任何检查点依赖**的记忆 → 不应引发失效 ──
  const del1 = store.forget(user, mCom);
  const existing1 = new Set(store.all().map((m) => m.id));
  const inv1 = mgr.revalidate((kind, id) => (kind === 'memory' ? existing1.has(id) : true));
  line();
  line(`  删除「Excel 批量处理优先走 COM 接口」（未被依赖）→ ${del1.ok ? '已删除' : `被拒：${del1.reason}`}`);
  line(`    → 失效 ${inv1.length} 个 ${inv1.length === 0 ? '✓ 精确，没有误伤' : '⚠️ 误伤'}`);
  check('B 未被依赖的记忆被删不误伤检查点', inv1.length === 0);

  // ── 验证 ②：硬约束不可被遗忘（安全底线）──
  //    这一条单列，因为它正是"级联失效"测试选材时的陷阱：
  //    拿硬约束做删除实验会静默失败（forget 返回 ok:false），
  //    看起来像"删了却没触发失效"，实际是根本没删掉。
  const hardDel = store.forget(user, mAllergy);
  line();
  line(
    `  尝试删除「你对花生严重过敏」（硬约束）→ ` +
      (hardDel.ok ? '⚠️ 竟然成功了' : `✓ 被拒绝：${hardDel.reason}`),
  );
  check('B 硬约束不可被遗忘（安全底线）', !hardDel.ok);

  // ── 验证 ③：删掉**被仆人汇报引用过**的软约束 → 应精确失效 ──
  //
  //    注意选材：回退已经丢弃了 seq 21 之后的检查点，
  //    幸存的两个检查点依赖的是 lifeReport.memoryRefs（mAllergy + mLi）。
  //    所以这里删 mLi —— 它同时满足"被依赖"与"可删除"（非硬约束）。
  //
  //    另一处陷阱：**不能拿后面还要用的记忆做删除实验**。
  //    我一度删了 mFat，结果第 ⑧ 段演化验证找不到这条记忆而失败。
  const dependents = mgr.all().filter((c) => c.snapshot.memories.some((m) => m.memoryId === mLi));
  const del2 = store.forget(user, mLi);
  line();
  line(
    `  删除「小李是你的朋友，素食者」（被 ${dependents.length} 个检查点依赖）→ ` +
      (del2.ok ? '已删除' : `被拒：${del2.reason}`),
  );
  const existing2 = new Set(store.all().map((m) => m.id));
  const inv2 = mgr.revalidate((kind, id) => (kind === 'memory' ? existing2.has(id) : true));
  line(`    → 失效 ${inv2.length} 个（预期 ${dependents.length} 个）`);
  for (const c of mgr.all().filter((x) => x.invalidatedBy !== undefined).slice(0, 4)) {
    line(`      ✗ seq ${c.seq} ${c.label}`);
    line(`         ${c.invalidatedBy}`);
  }

  check(
    'B 被依赖的记忆被删则检查点失效',
    dependents.length > 0 && inv2.length === dependents.length,
    `${inv2.length} / ${dependents.length}`,
  );
  check(
    'B 失效范围精确（不是一刀切）',
    inv2.length > 0 && inv2.length < mgr.all().length,
    `共 ${mgr.all().length} 个检查点，失效 ${inv2.length} 个`,
  );
  check('B 失效检查点仍保留在列表中', mgr.all().length >= mgr.valid().length);

  let rejectedProperly = false;
  const invalidOne = mgr.all().find((c) => c.invalidatedBy !== undefined);
  if (invalidOne) {
    try {
      mgr.planRollback(invalidOne.id);
    } catch (e) {
      rejectedProperly = e instanceof Error && e.message.includes('失效');
    }
    line(`  对失效检查点执行回退 → 被拒绝（${rejectedProperly ? '✓' : '✗'}）`);
  }
  check('B 失效检查点不可回退', invalidOne === undefined || rejectedProperly);

  // ═══════════════════════════════════════════════════════
  // ⑤ 确定性重放
  // ═══════════════════════════════════════════════════════

  hr('⑤ 确定性重放（"回退结果可信"的技术保证）');

  const h1 = stateHashOf(log.all());
  const h2 = stateHashOf(log.all());
  const h3 = replay(log.all()).stateHash;

  line(`  哈希 #1  ${h1}`);
  line(`  哈希 #2  ${h2}`);
  line(`  哈希 #3（经 replay）  ${h3}`);

  check('C 两次直接哈希一致', h1 === h2);
  check('C 重放哈希与直接哈希一致', h1 === h3);

  // ═══════════════════════════════════════════════════════
  // ⑥ 分层反思（隔离验证）
  // ═══════════════════════════════════════════════════════

  hr('⑥ 分层反思（隔离验证）');

  const mock = new MockModel({
    script: [
      {
        purpose: 'reflection',
        respond: {
          kind: 'json',
          value: {
            candidates: [
              {
                kind: 'preference',
                content: '家庭聚餐时偏好全素且无花生的菜单',
                confidence: 0.7,
                evidence: ['本次用户明确要求在家做且小李素食'],
                rationale: '本次三次涉及素食与过敏约束',
              },
            ],
          },
        },
      },
    ],
  });

  const lifeReflect = await reflectServant({
    model: mock,
    log,
    clock,
    input: buildServantReflectionInput({
      servant: 'life',
      userGoal: USER_GOAL,
      ownReports: [lifeReport],
      ownDomainMemories: store
        .list({ memClass: 'domain', domainOwner: 'life' })
        .map((m) => ({ id: m.id, kind: m.kind, content: m.content, lifecycle: m.lifecycle })),
    }),
  });

  line(`  生活仆人反思产出 ${lifeReflect.candidates.length} 条候选`);
  for (const c of lifeReflect.candidates) {
    line(`    · [${c.kind}] ${c.content}`);
    line(`      作用域 ${c.scope.memClass}${c.scope.domainOwner ? ` / ${c.scope.domainOwner}` : ''}`);
  }

  const sawSensitive = mock.sawText('心理咨询');
  const sawOtherDomain = mock.sawText('COM 接口');
  const sawGlobalConstraint = mock.sawText('花生严重过敏');

  line(`  模型是否看到敏感域内容：${sawSensitive ? '⚠️ 是' : '✓ 否'}`);
  line(`  模型是否看到他域记忆：${sawOtherDomain ? '⚠️ 是' : '✓ 否'}`);
  line(`  模型是否看到全局硬约束：${sawGlobalConstraint ? '⚠️ 是' : '✓ 否'}`);

  check('D 仆人反思未见敏感域', !sawSensitive);
  check('D 仆人反思未见他域记忆', !sawOtherDomain);
  check('D 仆人反思未见全局记忆', !sawGlobalConstraint);
  check(
    'D 领域候选作用域正确',
    lifeReflect.candidates.every((c) => c.scope.memClass === 'domain' && c.scope.domainOwner === 'life'),
  );

  // ── 管家复盘（应能看到全局，这正是区别）──
  const mockButler = new MockModel({
    script: [
      {
        purpose: 'reflection',
        respond: {
          kind: 'json',
          value: {
            candidates: [
              {
                kind: 'principle',
                content: '跨领域冲突时，安全类约束优先于体验类偏好',
                confidence: 0.65,
                evidence: ['本次花生过敏优先于口味偏好'],
                rationale: '冲突裁决中用户选择了安全优先',
              },
            ],
            collaborationIssues: ['健康仆人的审核结论未回流给生活仆人重做'],
            rhythmChanges: [],
          },
        },
      },
    ],
  });

  const butlerReflect = await reflectButler({
    model: mockButler,
    log,
    clock,
    input: {
      userGoal: USER_GOAL,
      reports: reportsForReflection.map((r) => ({
        servant: r.servant,
        summary: r.artifacts.map((a) => (Array.isArray(a.content) ? a.content.join('；') : a.content)).join(' | '),
      })),
      conflicts: [{ message: '蛋白摄入是否加量', severity: 'warn', resolvedBy: '用户选择加量' }],
      globalMemories: store
        .list({ memClass: 'global_shared' })
        .map((m) => ({ id: m.id, kind: m.kind, content: m.content, lifecycle: m.lifecycle })),
      existingPrinciples: [],
      temporalPatterns: [],
    },
  });

  line();
  line(`  管家复盘产出 ${butlerReflect.candidates.length} 条跨领域候选`);
  line(`  协作问题 ${butlerReflect.collaborationIssues.length} 条：${butlerReflect.collaborationIssues[0] ?? '（无）'}`);
  line(`  管家是否看到全局内容：${mockButler.sawText('减脂') ? '✓ 是（这正是与仆人的区别）' : '— 否'}`);
  check('D 管家层候选进全局共享层', butlerReflect.candidates.every((c) => c.scope.memClass === 'global_shared'));
  check('D 管家能看到跨领域信息', mockButler.sawText('减脂') || mockButler.sawText('素食'));

  // ═══════════════════════════════════════════════════════
  // ⑦ 候选落库与审核
  // ═══════════════════════════════════════════════════════

  hr('⑦ 候选落库 → 用户审核 → 进入召回池');

  const beforeSink = store.size();
  const sinkResult = sinkCandidates(
    { log, store, clock },
    [...lifeReflect.candidates, ...butlerReflect.candidates] as MemoryCandidate[],
  );

  line(`  落库 ${sinkResult.created.length} 条候选（记忆库 ${beforeSink} → ${store.size()}）`);
  for (const e of sinkResult.created) {
    line(`    · [${e.lifecycle}] ${e.content.slice(0, 40)}`);
  }
  if (sinkResult.skipped.length > 0) {
    line(`  跳过 ${sinkResult.skipped.length} 条：${sinkResult.skipped.map((s) => s.reason).join('、')}`);
  }

  check('E 候选落为 candidate 状态', sinkResult.created.every((e) => e.lifecycle === 'candidate'));

  // 候选不该被召回
  const recallWithCandidates = recall({
    query: USER_GOAL,
    candidates: store.visibleTo({ kind: 'butler', userId: USER }),
    limit: 10,
    now: clock.now(),
    random,
  });
  const candidateIds = new Set(sinkResult.created.map((e) => e.id));
  const leaked = recallWithCandidates.selected.filter((s) => candidateIds.has(s.memory.id));
  line(`  未审核候选是否被召回：${leaked.length > 0 ? '⚠️ 是' : '✓ 否'}`);
  check('E 未审核候选不进召回池', leaked.length === 0);

  // 用户审核通过
  const target = sinkResult.created[0];
  if (target) {
    const reviewed = store.review(user, target.id, 'approve', '确实是这样');
    line(`  用户采纳「${target.content.slice(0, 30)}」→ ${reviewed.ok ? reviewed.entry.lifecycle : '失败'}`);
    check('E 审核通过后进入召回池', reviewed.ok && reviewed.entry.lifecycle === 'active');
    check('E 审核落事件', log.byType('memory.approved').length > 0);
  }

  // 重复候选被去重
  const dup = sinkCandidates({ log, store, clock }, lifeReflect.candidates as MemoryCandidate[]);
  line(`  再次提交同一批候选 → 新增 ${dup.created.length} 条，去重 ${dup.skipped.length} 条`);
  check('E 重复候选被去重', dup.created.length === 0 && dup.skipped.length > 0);

  // ═══════════════════════════════════════════════════════
  // ⑧ 效果验证与演化闭环
  // ═══════════════════════════════════════════════════════

  hr('⑧ 效果验证 → 适应度演化 → 休眠与唤醒');

  const good = mFat; // 减脂期约束，会被反复验证有效
  const bad = mDist; // 餐厅距离偏好，本次不合用

  for (let i = 0; i < 12; i++) {
    engine.recordHit(good);
    engine.recordOutcome(good, true, '用户采纳了低油建议');
  }
  for (let i = 0; i < 6; i++) {
    engine.recordHit(bad);
    engine.recordOutcome(bad, false, '用户纠正：这次在家做，不考虑距离');
  }

  const goodFit = store.get(good)?.fitness ?? 0;
  const badFit = store.get(bad)?.fitness ?? 0;
  line(`  「减脂期约束」  适应度 ${goodFit.toFixed(3)}  （12 次命中，全部奏效）`);
  line(`  「3 公里偏好」   适应度 ${badFit.toFixed(3)}  （6 次命中，全部被纠正）`);
  check('F 有效记忆适应度上升', goodFit > 0.7, goodFit.toFixed(3));
  check('F 误用记忆适应度下降', badFit < goodFit, badFit.toFixed(3));

  // 推到 61 天后跑一轮演化
  clock.advance(61 * DAY);
  const pass1 = engine.runPass();
  line();
  line(`  推进 61 天后跑一轮演化：`);
  line(`    休眠 ${pass1.dormant.length} 条：${pass1.dormant.join(', ') || '（无）'}`);
  line(`    归档 ${pass1.archived.length} 条：${pass1.archived.join(', ') || '（无）'}`);
  line(`    召回阈值 ${pass1.threshold.toFixed(2)}`);

  const dormantCount = store.list({ lifecycle: 'dormant' }).length;
  check('F 长期未命中的记忆进入休眠', dormantCount > 0, `${dormantCount} 条`);

  // ★ 唤醒：把某条休眠记忆再命中
  const dormanted = store.list({ lifecycle: 'dormant' })[0];
  if (dormanted) {
    clock.advance(DAY);
    const t = engine.recordHit(dormanted.id);
    const after = store.get(dormanted.id);
    line();
    line(`  ── 唤醒验证 ──`);
    line(`    对休眠记忆「${dormanted.content.slice(0, 26)}」再次命中`);
    line(`    迁移结果 ${t.kind}  生命周期 ${after?.lifecycle}  唤醒次数 ${after?.revivedCount}`);
    check('F 休眠记忆被再次命中时唤醒', t.kind === 'revived' && after?.lifecycle === 'active');
    check('F 唤醒落事件（"淘汰≠删除"的证据）', log.byType('memory.revived').length > 0);
  }

  // 人工干预
  const manual = engine.adjustWeight(bad, 0.3, '用户认为这条以后还有用');
  line();
  line(`  用户手动提权「3 公里偏好」：${manual ? '✓ 成功' : '✗ 失败'} → 适应度 ${store.get(bad)?.fitness.toFixed(3)}`);
  check('F 用户可手动干预权重（演化不是黑盒）', manual && (store.get(bad)?.fitness ?? 0) > badFit);

  // ═══════════════════════════════════════════════════════
  // 汇总
  // ═══════════════════════════════════════════════════════

  hr('结果汇总');
  const passed = checks.filter((c) => c.pass).length;
  const groups = ['A', 'B', 'C', 'D', 'E', 'F'];
  const groupNames: Record<string, string> = {
    A: '回退保留前置成果',
    B: '级联失效',
    C: '确定性重放',
    D: '反思隔离',
    E: '候选不直接生效',
    F: '演化闭环',
  };
  // 未分组的检查也逐条打出 —— 否则"总数对不上"时看不见是哪项挂了
  const ungrouped = checks.filter((c) => !groups.some((g) => c.name.startsWith(g)));
  for (const c of ungrouped) {
    line('  ' + (c.pass ? '✓' : '✗') + ' ' + c.name + (c.detail ? '  — ' + c.detail : ''));
  }
  line();

  for (const g of groups) {
    const inGroup = checks.filter((c) => c.name.startsWith(g));
    if (inGroup.length === 0) continue;
    const ok = inGroup.every((c) => c.pass);
    line(`  ${ok ? '✓' : '✗'} ${g} · ${groupNames[g]}  (${inGroup.filter((c) => c.pass).length}/${inGroup.length})`);
    if (!ok) for (const c of inGroup.filter((x) => !x.pass)) line(`      ✗ ${c.name}`);
  }
  line();
  line(`  通过 ${passed}/${checks.length}`);
  line(`  记忆库 ${store.size()} 条 · 事件 ${log.length} 条 · 检查点 ${mgr.all().length} 个`);
  line(`  演化日志 ${engine.evolutionEvents().length} 条`);

  const allPass = passed === checks.length;
  line();
  line(allPass ? '  ▶ 验证 2 通过：四个创新点串起来成立' : '  ▶ 验证 2 未通过：见上方 ✗ 项');
  line();

  process.exit(allPass ? 0 : 1);
}

main().catch((err: unknown) => {
  line();
  line('  ✗ 执行失败：');
  line(`    ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) line(err.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
