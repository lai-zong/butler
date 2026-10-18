/**
 * 验证 12：管家自己干（v7 · B6）
 *
 * ★ 本验证要证明三件事（都是架构改造的核心主张）：
 *   ① **没有仆人，管家也能产出结构化结果** —— 不再需要"派发"这一步
 *   ② **工具循环照常工作** —— 去掉按领域的工具白名单后，管家仍能读写文件
 *   ③ **契约与产出对得上** —— 判据里要求的，产出里真的有
 *
 * ⚠️ 判据先说清（避免事后找理由）：
 *   · 有工具时：必须真调用过工具（`traces` 非空），且产出非空
 *   · 无工具时：必须产出结构化汇报，`status` 合法
 *   · `reply` 必须是**自然语言给用户的话**，不是结构说明
 *   · 契约的硬约束必须在产出里被遵守
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deepSeekConfigFromEnv, DeepSeekModel } from '../adapters/model/deepseek.js';
import { DeepSeekStream } from '../adapters/model/deepseekStream.js';
import { NodeFileSystem } from '../adapters/fs/node.js';
import { EventLog } from '../core/events/log.js';
import { FixedClock } from '../core/ports/clock.js';
import { writeContract } from '../core/butler/contract.js';
import { runButler } from '../core/butler/execute.js';
import { ToolFramework } from '../core/tools/framework.js';
import { fileTools } from '../core/tools/builtin/file.js';
import type { ActionTier, PermissionPolicy } from '../core/tools/types.js';
import type { ScoredMemory } from '../core/memory/recall.js';
import type { MemoryEntry } from '../core/memory/types.js';
import type { InjectedConstraint } from '../core/execution/types.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  }
}
function hr(t: string): void {
  console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);
}

const T0 = 1_760_000_000_000;

function mem(id: string, content: string, memClass: string): ScoredMemory {
  return {
    memory: {
      id,
      memClass,
      kind: 'fact',
      content,
      confidence: 0.9,
      evidence: [],
      owner: { kind: 'butler', userId: 'u' },
    } as unknown as MemoryEntry,
    score: 0.9,
    relevance: 0.9,
    fitness: 0.8,
    confidence: 0.9,
    exploratory: false,
    why: '',
  } as ScoredMemory;
}

async function main(): Promise<void> {
  const cfg = deepSeekConfigFromEnv();
  const model = new DeepSeekModel(cfg);
  const streamModel = new DeepSeekStream(cfg);
  const clock = new FixedClock(T0);

  console.log('\n▶ 验证 12：管家自己干（无仆人）\n');
  console.log(`  模型：${cfg.model}`);

  // ═══ 场景 A：无工具（纯推理）═══
  hr('场景 A：无工具 —— 管家能否独立产出结构化结果');

  const logA = new EventLog('v12a');
  const recalledA = [
    mem('m1', '用户对花生严重过敏', 'global_constraint'),
    mem('m2', '用户正在减脂期', 'global_shared'),
  ];

  const cA = await writeContract({
    model,
    log: logA,
    sessionId: 'v12a',
    userGoal: '帮我安排今晚吃什么，我花生过敏，最近在减脂',
    recalled: recalledA,
    now: clock.now(),
  });

  const constraintsA: InjectedConstraint[] = cA.constraints.map((c) => ({
    memoryId: c.memoryId,
    content: c.content,
    source: c.source,
    negotiable: c.negotiable,
  }));

  const t0 = Date.now();
  const rA = await runButler({
    model,
    log: logA,
    clock,
    taskId: 't_a',
    contract: cA.contract,
    injectedConstraints: constraintsA,
    userGoal: '帮我安排今晚吃什么，我花生过敏，最近在减脂',
    now: clock.now(),
  });
  console.log(`  耗时 ${Date.now() - t0}ms · ${rA.usage.inputTokens}→${rA.usage.outputTokens} token\n`);

  console.log(`  状态：${rA.report.status}`);
  console.log(`  回复（${rA.report.reply.length} 字）：`);
  console.log(`    ${rA.report.reply.slice(0, 260).replace(/\n/g, '\n    ')}`);
  console.log(`  产出物：${rA.report.artifacts.length} 项 · 发现：${(rA.report.findings ?? []).length} 条 · 不确定：${rA.report.uncertainties.length} 条`);

  check('★★ 无仆人也能跑完（status 合法）', ['done', 'failed', 'blocked'].includes(rA.report.status), rA.report.status);
  check('★ 产出非空', rA.report.artifacts.length > 0 || rA.report.reply.length > 50, `${rA.report.artifacts.length} 项产出`);
  check(
    '★ reply 是自然语言（不是结构说明）',
    rA.report.reply.length > 30 && !rA.report.reply.includes('"status"'),
    `${rA.report.reply.length} 字`,
  );
  check(
    '★★ 契约的硬约束被遵守（产出里没推荐花生）',
    !/推荐.{0,10}花生(?!过敏)/.test(rA.report.reply) &&
      !rA.report.artifacts.some((a) => /宫保鸡丁|花生米/.test(JSON.stringify(a))),
    '未出现含花生菜品',
  );
  check('★ 落了 butler.executed 事件（可审计）', logA.byType('butler.executed').length === 1);

  // ═══ 场景 B：有工具（真读写文件）═══
  hr('场景 B：有工具 —— 管家能否自己查证而不是凭印象');

  const dir = mkdtempSync(join(tmpdir(), 'butler-v12-'));
  writeFileSync(join(dir, '冰箱.txt'), '鸡蛋 5 个\n北豆腐 1 盒\n西兰花 1 颗\n花生酱 1 瓶（花生过敏，禁止使用）\n', 'utf8');

  const logB = new EventLog('v12b');
  const goalB = `看一下 ${dir} 目录里的文件，告诉我冰箱里有什么、哪些不能吃`;

  const cB = await writeContract({
    model,
    log: logB,
    sessionId: 'v12b',
    userGoal: goalB,
    recalled: [mem('m3', '用户对花生严重过敏', 'global_constraint')],
    now: clock.now(),
  });

  /**
   * 权限策略 —— 照 validate:03 的 `AutoApprovePolicy`（它已验证可用）。
   * ⚠️ 本验证要验的是"管家能不能自己查证"，不是权限闸门，所以一律放行。
   *    但 **dangerous 仍然关闭** —— 验证不该有删库的能力。
   */
  const policy: PermissionPolicy = {
    isRemembered: () => false,
    isTierEnabled: (t: ActionTier) => t !== 'dangerous',
    ask: () => Promise.resolve('allow'),
    authorize: () => 'allow',
  } as unknown as PermissionPolicy;
  const fsPort = new NodeFileSystem({ root: dir });
  const tools = new ToolFramework({ log: logB, clock, policy });
  tools.registerAll(fileTools(fsPort));

  const streamPort = { stream: (c: Parameters<typeof streamModel.stream>[0]) => streamModel.stream(c) };

  const t1 = Date.now();
  const rB = await runButler({
    model,
    log: logB,
    clock,
    taskId: 't_b',
    contract: cB.contract,
    injectedConstraints: [],
    userGoal: goalB,
    tools,
    streamPort: streamPort as never,
    now: clock.now(),
  });
  const msB = Date.now() - t1;
  console.log(`  耗时 ${msB}ms · ${rB.usage.inputTokens}→${rB.usage.outputTokens} token\n`);

  console.log(`  状态：${rB.report.status}`);
  console.log(`  回复（${rB.report.reply.length} 字）：`);
  console.log(`    ${rB.report.reply.slice(0, 300).replace(/\n/g, '\n    ')}`);

  const traceLines = logB.all().filter((e) => e.type === 'tool.call');
  console.log(`  工具调用：${traceLines.length} 次`);
  for (const e of traceLines.slice(0, 5)) {
    const p = e.payload as Record<string, unknown>;
    console.log(`    · ${String(p['tool'] ?? p['name'] ?? '?')}`);
  }

  check('★★ 真调用了工具（不是凭印象答）', traceLines.length > 0, `${traceLines.length} 次`);
  check(
    '★★ 真读到了文件内容（产出里出现"花生酱"或"西兰花"）',
    /花生酱|西兰花|北豆腐/.test(rB.report.reply) || rB.report.artifacts.some((a) => /花生酱|西兰花/.test(JSON.stringify(a))),
    '读到了实际内容',
  );
  check(
    '★★ 识别出花生酱不能吃（约束 + 文件标注）',
    /花生/.test(rB.report.reply),
    '提到了花生',
  );

  rmSync(dir, { recursive: true, force: true });

  // ═══ 结果 ═══
  hr('结果');
  console.log(`  通过 ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.log(`  ✗ 失败 ${failed} 项`);
    console.log('\n▶ 验证 12 未通过\n');
    process.exit(1);
  }
  console.log('\n▶ 验证 12 通过：管家无需仆人即可独立完成（含工具循环）\n');
}

await main();
