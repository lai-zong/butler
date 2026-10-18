/**
 * 验证 6 · 记忆跨重启存活（零 token，纯确定性）
 *
 * ★ 这个验证回答一个具体问题：
 *   **把程序关掉再打开，AI 还记得你吗？**
 *
 *   在此之前答案是"不记得" —— 记忆库在内存 Map 里，
 *   且建档不落足以重放的事件。
 *
 * 通过条件：
 *   ① 建档落的事件**足以重建**（含 fitness / createdAt / version 等）
 *   ② ★★ 写入磁盘 → 模拟重启 → 读盘重放 → 状态**逐字段一致**
 *   ③ 适应度、生命周期（休眠/归档）、效果跟踪都恢复
 *   ④ 领域归属恢复（生活领域的记忆不会跑到健康领域名下）
 *   ⑤ 硬约束恢复（安全约束绝不能丢）
 *   ⑥ 分级自主生效的记录也在（"它自己学的"重启后还在）
 *   ⑦ 重放不产生新事件（否则每次启动事件流翻倍）
 *
 * 运行：pnpm validate:6
 */

import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLog } from '../core/events/log.js';
import { FixedClock } from '../core/ports/clock.js';
import { MemoryStore } from '../core/memory/store.js';
import { diffStores, hydrateStore, replayMemory } from '../core/memory/replay.js';
import {
  admitAutonomously,
  revocationRates,
  revoke,
} from '../core/memory/admission.js';
import { snapshotOf } from '../core/memory/snapshot.js';
import { EvolutionEngine } from '../core/memory/evolution.js';
import { SeededRandom } from '../core/ports/clock.js';
import type { SessionEvent } from '../core/events/types.js';

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

const USER = 'u_validate6';
const butler = { kind: 'butler', userId: USER } as const;
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 9, 13, 14, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

/**
 * 事件流落盘 / 读盘。
 *
 * ★ 用 **JSONL**（一行一条）而不是单个 JSON 数组：
 *   · 追加写不必重写整个文件（长驻进程每秒都可能写）
 *   · 单行损坏不影响其它行（可跳过并报告）
 *   · 与"事件流是追加的"这一本质一致
 */
async function persistEvents(file: string, events: readonly SessionEvent[]): Promise<void> {
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  await writeFile(file, lines + (lines.length > 0 ? '\n' : ''), 'utf8');
}

async function appendEvents(file: string, events: readonly SessionEvent[]): Promise<void> {
  if (events.length === 0) return;
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  if (existsSync(file)) await appendFile(file, text, 'utf8');
  else await writeFile(file, text, 'utf8');
}

async function loadEvents(file: string): Promise<{ events: SessionEvent[]; badLines: number }> {
  const raw = await readFile(file, 'utf8');
  const events: SessionEvent[] = [];
  let badLines = 0;
  for (const l of raw.split('\n')) {
    const t = l.trim();
    if (t.length === 0) continue;
    try {
      events.push(JSON.parse(t) as SessionEvent);
    } catch {
      // ⚠️ 单行损坏**跳过并计数**，不让整个历史读不出来
      badLines += 1;
    }
  }
  return { events, badLines };
}

/** 把事件灌回一个新的 EventLog（重放要用的"重建后的日志"）。 */
function logFrom(sessionId: string, events: readonly SessionEvent[]): EventLog {
  const log = new EventLog(sessionId);
  log.appendMany(
    events.map((e) => ({
      type: e.type,
      actor: e.actor,
      payload: e.payload,
      createdAt: e.createdAt,
      ...(e.servantId !== undefined ? { servantId: e.servantId } : {}),
      ...(e.parentEventId !== undefined ? { parentEventId: e.parentEventId } : {}),
    })),
  );
  return log;
}

async function main(): Promise<void> {
  line();
  line('╔' + '═'.repeat(70) + '╗');
  line('║  验证 6 · 记忆跨重启存活（零 token）' + ' '.repeat(33) + '║');
  line('╚' + '═'.repeat(70) + '╝');

  const dir = await mkdtemp(join(tmpdir(), 'butler-validate6-'));
  const eventFile = join(dir, 'events.jsonl');
  line(`  工作目录：${dir}`);

  try {
    // ═══════════════════════════════════════════════════════
    hr('第一次运行（模拟"会话 1—50 的积累"）');
    // ═══════════════════════════════════════════════════════

    const log1 = new EventLog('s_main');
    const clock1 = new FixedClock(T0);
    const store1 = new MemoryStore(log1, clock1, USER);

    // ① 硬约束
    store1.create(butler, {
      id: 'm_allergy',
      memClass: 'global_constraint',
      kind: 'fact',
      content: '你对花生严重过敏',
      confidence: 0.98,
      evidence: ['用户说：我对花生过敏'],
      lifecycle: 'active',
    });

    // ② 普通事实与偏好
    store1.create(butler, {
      id: 'm_city', memClass: 'global_shared', kind: 'fact',
      content: '你住在杭州', confidence: 0.9, evidence: ['e_city'], lifecycle: 'active',
    });
    store1.create(butler, {
      id: 'm_tone', memClass: 'global_shared', kind: 'preference',
      content: '你偏好先结论后细节', confidence: 0.85, evidence: ['e_tone'], lifecycle: 'active',
    });

    // ③ 领域记忆（生活领域）
    store1.create(butler, {
      id: 'm_light', memClass: 'domain', kind: 'preference',
      content: '你偏好清淡口味', confidence: 0.8, evidence: ['e_light'],
      lifecycle: 'active', domain: 'life',
    });

    // ④ 原则（带条件、动作、效果跟踪）
    store1.create(butler, {
      id: 'm_principle', memClass: 'global_shared', kind: 'principle',
      content: '推荐餐厅前先确认同行人忌口', confidence: 0.88, evidence: ['e_p'], lifecycle: 'active',
    });
    store1.setPrincipleDetail('m_principle', {
      condition: '推荐餐厅或安排聚餐时',
      action: '先问清同行人的饮食禁忌再给方案',
    });
    store1.setEffectiveness('m_principle', { applied: 7, succeeded: 6, lastAppliedAt: T0 - DAY });

    // ⑤ 一条候选 —— 走**分级自主**生效（不是用户审核）
    store1.create(butler, {
      id: 'm_auto', memClass: 'global_shared', kind: 'fact',
      content: '你工作日在公司', confidence: 0.85, evidence: ['用户说：我平时都在公司'], lifecycle: 'candidate',
    });
    admitAutonomously({
      log: log1,
      store: store1,
      clock: clock1,
      id: 'm_auto',
      source: 'userStated',
      reason: '用户所述，自主生效',
    });

    // ⑥ 一条 AI 推断的、被用户撤销的（用于验证撤销率统计也存活）
    store1.create(butler, {
      id: 'm_wrong', memClass: 'global_shared', kind: 'preference',
      content: '你偏好命令行而非图形界面', confidence: 0.75, evidence: ['activity 聚合'], lifecycle: 'candidate',
    });
    admitAutonomously({
      log: log1, store: store1, clock: clock1, id: 'm_wrong',
      source: 'observed', reason: '行为观察',
    });
    revoke({ log: log1, store: store1, clock: clock1, id: 'm_wrong', reason: '不是我的偏好' });

    // ⑦ 走一轮演化：让一条记忆休眠、一条归档
    const evolution = new EvolutionEngine({
      log: log1,
      store: store1,
      clock: new FixedClock(T0 + 200 * DAY),
      random: new SeededRandom(7),
      userId: USER,
    });
    // 把 m_light 的适应度压低，让它进休眠
    store1.setFitness('m_light', 0.15);
    // 补一条带快照的 fitness 事件（setFitness 本身不落事件，演化引擎会落）
    log1.append({
      type: 'fitness.updated',
      actor: 'system',
      payload: { memoryId: 'm_light', note: '手动压低以演示休眠', snapshot: snapshotOf(store1.get('m_light')) },
      createdAt: T0 + 200 * DAY,
    });
    const pass = evolution.runPass();
    line(`  演化一轮：休眠 ${pass.dormant.length} 条、归档 ${pass.archived.length} 条`);

    const before = store1.all();
    line(`  当前记忆 ${before.length} 条，事件 ${log1.length} 条`);

    // ═══════════════════════════════════════════════════════
    hr('① 持久化到磁盘');
    // ═══════════════════════════════════════════════════════

    await persistEvents(eventFile, log1.all());
    const fileInfo = await readFile(eventFile, 'utf8');
    const fileLines = fileInfo.split('\n').filter((l) => l.trim().length > 0).length;
    line(`  写入 ${eventFile}`);
    line(`  文件 ${fileInfo.length} 字节 / ${fileLines} 行（JSONL，一行一条事件）`);
    check('① 事件已落盘', fileLines === log1.length, `${fileLines} / ${log1.length}`);

    // 追加写测试
    const extraFile = join(dir, 'append.jsonl');
    await appendEvents(extraFile, log1.all().slice(0, 3));
    await appendEvents(extraFile, log1.all().slice(3, 5));
    const appended = await loadEvents(extraFile);
    check('① 追加写可用（长驻进程不必重写整个文件）', appended.events.length === 5, String(appended.events.length));

    // ═══════════════════════════════════════════════════════
    hr('② ★★ 模拟重启：读盘 → 重放 → 重建状态');
    // ═══════════════════════════════════════════════════════

    line('  —— 以下全部是"新进程"里发生的事 ——');
    line('  （旧 EventLog / MemoryStore 不再使用）');

    const loaded = await loadEvents(eventFile);
    line(`  读回 ${loaded.events.length} 条事件（坏行 ${loaded.badLines} 条）`);
    check('② 事件读回完整', loaded.events.length === log1.length, String(loaded.events.length));
    check('② 无坏行', loaded.badLines === 0, String(loaded.badLines));

    const log2 = logFrom('s_main', loaded.events);
    const clock2 = new FixedClock(T0 + 201 * DAY);
    const store2 = new MemoryStore(log2, clock2, USER);

    const replayed = replayMemory(loaded.events);
    line(`  重放：处理 ${replayed.consumedEvents} 条状态事件 → 重建 ${replayed.entries.length} 条记忆`);
    if (replayed.skippedEvents.length > 0) {
      line(`  ⚠️ 跳过 ${replayed.skippedEvents.length} 条（信息不足）：`);
      for (const s of replayed.skippedEvents.slice(0, 5)) {
        line(`      seq ${s.seq} ${s.type}：${s.why}`);
      }
    }

    const hydrated = hydrateStore({ store: store2, result: replayed });
    line(`  注入：${hydrated.ok ? '✓' : `✗ ${hydrated.reason ?? ''}`}（${hydrated.hydrated} 条）`);
    check('② 重建成功', hydrated.ok, hydrated.reason ?? '');

    const diff = diffStores(before, store2.all());
    line();
    line(`  逐字段比较：`);
    line(`    只在旧状态：${diff.onlyInA.length === 0 ? '（无）' : diff.onlyInA.join(', ')}`);
    line(`    只在新状态：${diff.onlyInB.length === 0 ? '（无）' : diff.onlyInB.join(', ')}`);
    line(`    字段有差异：${diff.differing.length === 0 ? '（无）' : JSON.stringify(diff.differing)}`);

    check('② ★★ 重放状态与真实状态逐字段一致', diff.identical);
    check('② 条数一致', store2.all().length === before.length, `${store2.all().length} / ${before.length}`);

    // ═══════════════════════════════════════════════════════
    hr('③ 具体内容核对（"它还记得你吗"）');
    // ═══════════════════════════════════════════════════════

    const allergy = store2.get('m_allergy');
    line(`  · 硬约束：「${allergy?.content ?? '（丢了）'}」`);
    line(`    类别 ${allergy?.memClass ?? '?'} · 生命周期 ${allergy?.lifecycle ?? '?'}`);
    check('③ ★ 硬约束存活', allergy?.memClass === 'global_constraint' && allergy.content.includes('花生'));

    const principle = store2.get('m_principle');
    line(`  · 原则：「${principle?.content ?? '（丢了）'}」`);
    line(`    条件：${principle?.principle?.condition ?? '（丢了）'}`);
    line(`    动作：${principle?.principle?.action ?? '（丢了）'}`);
    line(`    效果：应用 ${principle?.effectiveness?.applied ?? '?'} 次 / 奏效 ${principle?.effectiveness?.succeeded ?? '?'} 次`);
    check('③ ★ 原则的条件与动作存活（注入的依据）', principle?.principle?.condition !== undefined);
    check('③ ★ 效果跟踪存活（"学过的东西真的在用"）', principle?.effectiveness?.applied === 7);

    const light = store2.get('m_light');
    line(`  · 领域记忆：「${light?.content ?? '（丢了）'}」`);
    line(`    领域标签 ${light?.domain ?? '?'} · 生命周期 ${light?.lifecycle ?? '?'} · 适应度 ${light?.fitness ?? '?'}`);
    check('③ ★ 领域标签存活（重启后仍在 —— A1 曾漏加 snapshot/replay）',
      light?.domain === 'life');

    // 休眠状态
    const dormant = store2.all().filter((e) => e.lifecycle === 'dormant');
    const archived = store2.all().filter((e) => e.lifecycle === 'archived');
    line(`  · 生命周期分布：活跃 ${store2.all().filter((e) => e.lifecycle === 'active').length} · 休眠 ${dormant.length} · 归档 ${archived.length}`);
    check('③ ★ 生命周期状态存活（休眠的还在休眠）',
      dormant.length === before.filter((e) => e.lifecycle === 'dormant').length);

    // ④ 分级自主生效的记录
    const auto = store2.get('m_auto');
    line(`  · 自主生效的记忆：「${auto?.content ?? '（丢了）'}」→ ${auto?.lifecycle ?? '（丢了）'}`);
    // ⚠️ 这里**不**检查 `lifecycle === 'active'` ——
    //    这条记忆经过了 200 天演化，适应度衰减后**正确地**进入了休眠。
    //    该验证的是"它活着 + 自主生效的审计信息还在"，
    //    而不是"它必须是 active"（那是演化该决定的事）。
    check('③ ★ 系统自主生效的记忆存活（内容还在）', auto?.content === '你工作日在公司');
    check(
      '③ ★ 自主生效的审计信息存活（能查证"这是系统自己记的"）',
      log2
        .byType('memory.approved')
        .some(
          (e) =>
            (e.payload as { memoryId?: string }).memoryId === 'm_auto' &&
            (e.payload as { decidedBy?: string }).decidedBy === 'system',
        ),
    );

    // ⑤ 撤销率统计也存活（它来自事件，不是内存）
    const rates = revocationRates(log2);
    line(`  · 撤销率统计：observed = ${((rates.observed ?? 0) * 100).toFixed(0)}%`);
    check('③ ★ 撤销率统计存活（来自事件而非内存）', (rates.observed ?? 0) > 0);

    // ═══════════════════════════════════════════════════════
    hr('④ 重放不污染事件流');
    // ═══════════════════════════════════════════════════════

    const lengthBeforeReplay = log2.length;
    const replayed2 = replayMemory(log2.all());
    const store3 = new MemoryStore(new EventLog('s_x'), clock2, USER);
    hydrateStore({ store: store3, result: replayed2 });

    line(`  重放前事件 ${lengthBeforeReplay} 条 → 重放后 ${log2.length} 条`);
    check('④ ★★ 重放不产生新事件（否则每次启动翻倍）', log2.length === lengthBeforeReplay);
    check('④ 重放幂等（两次结果相同）', diffStores(replayed.entries, replayed2.entries).identical);

    // ═══════════════════════════════════════════════════════
    hr('⑤ 损坏行容错');
    // ═══════════════════════════════════════════════════════

    const brokenFile = join(dir, 'broken.jsonl');
    const good = JSON.stringify(log1.all()[0]);
    await writeFile(brokenFile, `${good}\n{这行坏了\n${JSON.stringify(log1.all()[1])}\n`, 'utf8');
    const broken = await loadEvents(brokenFile);
    line(`  3 行里坏 1 行 → 读回 ${broken.events.length} 条，报告坏行 ${broken.badLines} 条`);
    check('⑤ ★ 单行损坏不影响其它行', broken.events.length === 2 && broken.badLines === 1);

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
    line('  ★ 本验证零 token。');
    line('    关键结论：**关掉程序再打开，记忆、原则、效果跟踪、生命周期');
    line('    与自主生效的记录都还在** —— "渐进式记忆演化"的"渐进"成立了。');
    line();

    const allPass = passed === checks.length;
    line(allPass ? '  ▶ 验证 6 通过：记忆跨重启存活' : '  ▶ 验证 6 未通过：见上方 ✗ 项');
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

void HOUR;
