/**
 * 验证 7 · 完整运行时重启（零 token，真实落盘）
 *
 * 与验证 6 的区别：
 *   验证 6 手工调用 persistEvents / replayMemory / hydrateStore，
 *   证明的是**机制**成立。
 *
 *   本验证走**真实运行时路径**：
 *     · JsonlEventStore 自动落盘（EventLog 挂端口，产生事件即写）
 *     · bootstrap() 一次调用完成「读盘 → 重放 → 注入 → 检查点」
 *     · 三个 store（记忆 / 产出物 / 操作记忆）全部重建
 *
 *   ——它证明的是"**接到运行时**"这件事成立，而不只是机制可用。
 *
 * 通过条件：
 *   ① EventLog 挂上端口后事件自动落盘（不手工调用）
 *   ② 截断（检查点回退）会同步落盘侧
 *   ③ bootstrap 一次调用重建全部状态
 *   ④ 三类状态逐字段一致
 *   ⑤ 检查点由事件流派生（无需单独持久化）
 *   ⑥ 重启后**继续产生事件**，事件文件正确追加（不翻倍）
 *
 * 运行：pnpm validate:7
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlEventStore, loadEvents } from '../adapters/storage/jsonlEvents.js';
import { FixedClock, SeededRandom } from '../core/ports/clock.js';
import { bootstrap, renderRestoreSummary } from '../core/runtime/bootstrap.js';
import { diffStores } from '../core/memory/replay.js';
import { diffArtifacts } from '../core/artifact/replay.js';
import { diffOperations } from '../core/memory/operationReplay.js';

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

const USER = 'u_validate7';
const butler = { kind: 'butler', userId: USER } as const;
const T0 = new Date(2026, 9, 13, 14, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  line();
  line('╔' + '═'.repeat(70) + '╗');
  line('║  验证 7 · 完整运行时重启（零 token，真实落盘）' + ' '.repeat(21) + '║');
  line('╚' + '═'.repeat(70) + '╝');

  const dir = await mkdtemp(join(tmpdir(), 'butler-validate7-'));
  const eventFile = join(dir, 'events.jsonl');
  line(`  事件文件：${eventFile}`);

  try {
    // ═══════════════════════════════════════════════════════
    hr('第一次运行：产生状态（EventLog 自动落盘）');
    // ═══════════════════════════════════════════════════════

    const store1 = new JsonlEventStore({ file: eventFile, flushIntervalMs: 0 });

    /**
     * ⚠️ 这里**不能**自己 new EventLog ——
     *    ootstrap() 会新建一个 EventLog 并返回。
     *    我第一版建了个游离的 log1 往里 append 一条，
     *    于是磁盘上出现两条 seq=1（游离 log 的与 bootstrap log 的），
     *    验证 7 直接抓到（读回时被按 seq 去重，历史少了一条）。
     *
     *    正确做法：**一切事件都通过 bootstrap 返回的 log 产生。**
     */
    const first = bootstrap({
      sessionId: 's_main',
      userId: USER,
      clock: new FixedClock(T0),
      random: new SeededRandom(7),
      historicalEvents: [],
      persistence: store1,
    });

    const { memory, artifacts, operations } = first;
    const log = first.log;

    // ── 造状态 ──
    memory.create(butler, {
      id: 'm_allergy', memClass: 'global_constraint', kind: 'fact',
      content: '你对花生严重过敏', confidence: 0.98, evidence: ['e1'], lifecycle: 'active',
    });
    memory.create(butler, {
      id: 'm_tone', memClass: 'global_shared', kind: 'preference',
      content: '你偏好先结论后细节', confidence: 0.85, evidence: ['e2'], lifecycle: 'active',
    });
    memory.create(butler, {
      id: 'm_p', memClass: 'global_shared', kind: 'principle',
      content: '推荐餐厅前先确认同行人忌口', confidence: 0.88, evidence: ['e3'], lifecycle: 'active',
    });
    memory.setPrincipleDetail('m_p', {
      condition: '推荐餐厅或安排聚餐时',
      action: '先问清同行人的饮食禁忌再给方案',
    });
    memory.setEffectiveness('m_p', { applied: 7, succeeded: 6, lastAppliedAt: T0 - DAY });

    // 产出物（含两个版本 —— 验证"回退后仍可对比"）
    artifacts.create({
      id: 'art_menu', label: '采购清单', kind: 'list',
      content: '', items: ['糙米 300g', '北豆腐 2 盒'],
      producedByStep: 's1', author: 'servant', authorId: 'life', reason: '初次产出',
    });
    artifacts.revise({
      artifactId: 'art_menu', content: '', items: ['糙米 500g', '北豆腐 2 盒', '西兰花 1 颗'],
      author: 'servant', authorId: 'life', reason: '按健康仆人意见调整分量',
    });

    // 操作记忆（"第 1 次试 UI 失败、改用 COM 成功"）
    operations.recordAttempt({
      task: '给 Excel 加一列', app: 'excel', path: 'uia',
      success: false, durationMs: 3200, failureReason: '找不到"插入列"按钮',
    });
    operations.recordAttempt({
      task: '给 Excel 加一列', app: 'excel', path: 'api',
      success: true, durationMs: 210, method: '用 COM 的 Columns.Add()',
    });

    // ⚠️ 先 flush 再取快照 —— 否则 ventCount 与磁盘可能差最后几条
    //    （实测踩过：磁盘 13 行、内存记 12 条，重启读回 12 条）
    await log.flushPersistence();

    const before = {
      memories: memory.all(),
      artifacts: artifacts.all(),
      operations: operations.all(),
      eventCount: log.length,
    };
    const fileAfterFirst = await readFile(eventFile, 'utf8');
    const diskLines = fileAfterFirst.split('\n').filter((l) => l.trim().length > 0);
    line('  磁盘内容（seq → 类型）：');
    for (const rawLine of diskLines) {
      const parsed = JSON.parse(rawLine) as { seq: number; type: string };
      line(`    ${String(parsed.seq).padStart(3)}  ${parsed.type}`);
    }
    line(`  内存 ${log.length} 条 · 磁盘 ${diskLines.length} 行`);

    line(`  记忆 ${before.memories.length} 条 · 产出物 ${before.artifacts.length} 个 · 操作记忆 ${before.operations.length} 条`);
    line(`  事件 ${before.eventCount} 条 · 文件 ${fileAfterFirst.length} 字节`);

    check('① 事件自动落盘（未手工调用 persistEvents）', fileAfterFirst.length > 0);
    check(
      '① 落盘条数与内存一致',
      fileAfterFirst.split('\n').filter((l) => l.trim().length > 0).length === before.eventCount,
      `${fileAfterFirst.split('\n').filter((l) => l.trim().length > 0).length} / ${before.eventCount}`,
    );
    check('① 产出物有两个版本（供"回退后仍可对比"）', artifacts.revisions('art_menu').length === 2);

    // ═══════════════════════════════════════════════════════
    hr('② 模拟重启：读盘 → bootstrap 一次调用重建');
    // ═══════════════════════════════════════════════════════

    line('  —— 以下全部是"新进程"里发生的事 ——');

    const loaded = await loadEvents(eventFile);
    line(`  读回 ${loaded.events.length} 条事件（坏行 ${loaded.badLines} 条）`);

    const store2 = new JsonlEventStore({ file: eventFile, flushIntervalMs: 0 });
    const second = bootstrap({
      sessionId: 's_main',
      userId: USER,
      clock: new FixedClock(T0 + DAY),
      random: new SeededRandom(7),
      historicalEvents: loaded.events,
      badLines: loaded.badLines,
      persistence: store2,
    });

    line();
    for (const l of renderRestoreSummary(second).split('\n')) line(`  ${l}`);

    check('② 恢复成功', second.resumed);
    check('② 事件读回完整', loaded.events.length === before.eventCount, `${loaded.events.length} / ${before.eventCount}`);

    // ═══════════════════════════════════════════════════════
    hr('③ 三类状态逐字段核对');
    // ═══════════════════════════════════════════════════════

    const memDiff = diffStores(before.memories, second.memory.all());
    line(`  记忆：只在旧 ${memDiff.onlyInA.length} · 只在新 ${memDiff.onlyInB.length} · 字段差异 ${memDiff.differing.length}`);
    if (memDiff.differing.length > 0) line(`      ${JSON.stringify(memDiff.differing)}`);
    check('③ ★ 记忆逐字段一致', memDiff.identical);

    const artDiff = diffArtifacts(before.artifacts, second.artifacts.all());
    line(`  产出物：${artDiff.identical ? '一致' : `差异 ${artDiff.differing.join(', ')}`}`);
    check('③ ★ 产出物一致', artDiff.identical);

    const opDiff = diffOperations(before.operations, second.operations.all());
    line(`  操作记忆：${opDiff.identical ? '一致' : `差异 ${opDiff.differing.join(', ')}`}`);
    check('③ ★ 操作记忆一致', opDiff.identical);

    // 具体内容
    const menu = second.artifacts.get('art_menu');
    const v2 = second.artifacts.revision('art_menu', 2);
    line();
    line(`  产出物「${menu?.label ?? '?'}」当前版本 v${menu?.currentVersion ?? '?'}，共 ${second.artifacts.revisions('art_menu').length} 个版本`);
    line(`    v2 内容：${(v2?.items ?? []).join(' / ')}`);
    check('③ ★ 产出物版本历史存活（"回退后仍可对比"的前提）', second.artifacts.revisions('art_menu').length === 2);
    check('③ 产出物内容存活（不是空壳）', (v2?.items ?? []).length === 3);

    const p = second.memory.get('m_p');
    line(`  原则效果：应用 ${p?.effectiveness?.applied ?? '?'} 次 / 奏效 ${p?.effectiveness?.succeeded ?? '?'} 次`);

    // ★ 操作记忆：这是"越做越快越准"的验收点
    line();
    line('  ★ 操作记忆（"第 1 次试 UI 失败、改用 COM 成功"，重启后还在吗）：');
    for (const m of second.operations.all()) {
      const eff = m.effectiveness;
      line(`    · ${m.taskLabel} → ${m.path}（${eff?.succeeded ?? 0}/${eff?.attempts ?? 0} 成功）`);
      if (eff?.lastFailure !== undefined) line(`        上次失败：${eff.lastFailure}`);
    }
    const rec = second.operations.recommend({ task: '给 Excel 加一列', app: 'excel' });
    line(`    重启后的推荐路径：${rec.ranked[0]?.path}（${rec.ranked[0]?.why.slice(0, 40)}…）`);
    check('③ ★★ 重启后直接推荐 COM（"越做越快越准"成立）', rec.ranked[0]?.path === 'api');

    // ═══════════════════════════════════════════════════════
    hr('④ 检查点由事件流派生');
    // ═══════════════════════════════════════════════════════

    line(`  重建检查点 ${second.restored.checkpoints} 个`);
    line(`  （检查点不单独持久化 —— sync() 扫一遍事件流即可重建，`);
    line(`    这是"事件是唯一真相源"的直接好处）`);
    check('④ 检查点由事件流派生', second.checkpoints.all().length > 0);

    // ═══════════════════════════════════════════════════════
    hr('⑤ 重启后继续产生事件（不翻倍）');
    // ═══════════════════════════════════════════════════════

    second.memory.create(butler, {
      id: 'm_new', memClass: 'global_shared', kind: 'fact',
      content: '你在用 Windows', confidence: 0.9, evidence: ['e9'], lifecycle: 'active',
    });
    await second.log.flushPersistence();

    const loaded2 = await loadEvents(eventFile);
    const knownSeq = new Set(loaded.events.map((e) => e.seq));
    const addedInRestart = loaded2.events.filter((e) => !knownSeq.has(e.seq));

    line(`  重启时历史 ${loaded.events.length} 条 → 之后新增 ${addedInRestart.length} 条 → 文件中 ${loaded2.events.length} 条`);
    line('  重启后新增的事件：');
    for (const e of addedInRestart) line(`    ${String(e.seq).padStart(3)}  ${e.type}`);

    /**
     * ★ 关键：不能因为"历史被重放"而把历史又写一遍。
     *
     * ⚠️ 期望值是 **2** 而不是 1：建档本来就产生**两条**事件 ——
     *    `memory.approved`（语义：回答"这条记忆是怎么来的"）
     *    `memory.created`（状态：供重放重建）
     *    这是有意的双事件设计，不是重复。
     *
     *    真正要防的是"重启时把历史重写一遍"—— 那会让条数随
     *    重启次数线性增长。
     */
    check(
      '⑤ ★★ 重启只产生新事件，不重写历史',
      addedInRestart.length === 2,
      `新增 ${addedInRestart.length} 条：${addedInRestart.map((e) => e.type).join(', ')}`,
    );
    check(
      '⑤ 新增的正好是建档的两条（语义 + 状态）',
      addedInRestart.some((e) => e.type === 'memory.created') &&
        addedInRestart.some((e) => e.type === 'memory.approved'),
    );
    check('⑤ seq 连续无重复', new Set(loaded2.events.map((e) => e.seq)).size === loaded2.events.length);

    // ═══════════════════════════════════════════════════════
    hr('⑥ 截断（检查点回退）同步到落盘');
    // ═══════════════════════════════════════════════════════

    const keepSeq = second.log.length - 1;
    const discarded = second.log.truncateTo({
      sessionId: 's_main',
      seq: keepSeq,
      reason: '验证截断是否同步到落盘',
    });
    await second.log.flushPersistence();

    const loaded3 = await loadEvents(eventFile);
    line(`  截断到 seq ${keepSeq}，丢弃 ${discarded.length} 条`);
    line(`  磁盘上现在 ${loaded3.events.length} 条（应当也是 ${keepSeq}）`);

    check('⑥ ★★ 截断同步到落盘（否则重启会把回退掉的历史装回来）',
      loaded3.events.length === keepSeq, `${loaded3.events.length} vs ${keepSeq}`);

    // ═══════════════════════════════════════════════════════
    hr('结果汇总');
    // ═══════════════════════════════════════════════════════

    const passed = checks.filter((c) => c.pass).length;
    for (const c of checks) {
      line(`  ${c.pass ? '✓' : '✗'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
    }
    line();
    line(`  通过 ${passed}/${checks.length}`);
    line();
    line('  ★ 本验证零 token，且走的是**真实运行时路径**：');
    line('    · EventLog 挂端口 → 产生事件即自动落盘（无手工调用）');
    line('    · bootstrap() 一次调用完成「读盘 → 重放 → 注入 → 检查点」');
    line('    · 三类状态（记忆 / 产出物 / 操作记忆）全部重建');
    line();

    const allPass = passed === checks.length;
    line(allPass ? '  ▶ 验证 7 通过：完整运行时重启成立' : '  ▶ 验证 7 未通过：见上方 ✗ 项');
    line();

    await rm(dir, { recursive: true, force: true });
    process.exit(allPass ? 0 : 1);
  } catch (err) {
    line();
    line(`  ✗ 执行失败：${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) line(err.stack.split('\n').slice(1, 6).join('\n'));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  line(`致命错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
