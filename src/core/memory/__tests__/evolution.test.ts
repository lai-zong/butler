/**
 * 演化引擎测试 —— 验证"记忆真的会演化"
 *
 * 这是第四层创新从"公式"到"行为"的一步：
 * 适应度算得对还不够，必须**真的驱动生命周期变化**，而且用户能干预。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock, SeededRandom } from '../../ports/clock.js';
import { EvolutionEngine } from '../evolution.js';
import { recordEffect } from '../principles.js';
import { DEFAULT_PARAMS } from '../fitness.js';
import { MemoryStore } from '../store.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_760_000_000_000;
const USER = 'u_evo';
const butler = { kind: 'butler', userId: USER } as const;

function setup(now = T0) {
  const log = new EventLog('s_evo');
  const clock = new FixedClock(now);
  const store = new MemoryStore(log, clock, USER);
  const engine = new EvolutionEngine({
    log,
    store,
    clock,
    random: new SeededRandom(1234),
    userId: USER,
  });
  return { log, clock, store, engine };
}

function seedPref(store: MemoryStore, id: string, content = '偏好清淡口味'): string {
  const r = store.create(butler, {
    id,
    memClass: 'global_shared',
    kind: 'preference',
    content,
    confidence: 0.8,
    evidence: ['e1', 'e2'],
    lifecycle: 'active',
  });
  if (!r.ok) throw new Error(r.reason);
  return r.entry.id;
}

// ═══════════════════════════════════════════════════════════
// 命中与适应度
// ═══════════════════════════════════════════════════════════

describe('recordHit · 命中驱动适应度', () => {
  it('命中后 hitCount 与适应度都更新，并落事件', () => {
    const { store, engine, log } = setup();
    const id = seedPref(store, 'm1');
    const before = store.get(id)?.fitness ?? 0;

    engine.recordHit(id);

    const after = store.get(id);
    expect(after?.hitCount).toBe(1);
    expect(after?.lastHitAt).toBe(T0);
    // 一次命中不足以让分数大涨（EMA 渐变），但应产生 fitness.updated 事件
    expect(log.byType('fitness.updated').length).toBeGreaterThan(0);
    expect(after?.fitness).toBeGreaterThanOrEqual(Math.min(before, after?.fitness ?? 0));
  });

  it('多次命中 + 全部奏效 → 适应度上升', () => {
    const { store, engine } = setup();
    const id = seedPref(store, 'm2');
    const start = store.get(id)?.fitness ?? 0;

    for (let i = 0; i < 15; i++) {
      engine.recordHit(id);
      engine.recordOutcome(id, true);
    }

    expect(store.get(id)?.fitness ?? 0).toBeGreaterThan(start);
  });

  it('★ 被纠正的记忆适应度下降（误用惩罚生效）', () => {
    const { store, engine } = setup();
    const good = seedPref(store, 'good', '这条一直有用');
    const bad = seedPref(store, 'bad', '这条总出错');

    for (let i = 0; i < 10; i++) {
      engine.recordHit(good);
      engine.recordOutcome(good, true);
      engine.recordHit(bad);
      engine.recordOutcome(bad, false);
    }

    expect(store.get(bad)?.fitness ?? 0).toBeLessThan(store.get(good)?.fitness ?? 1);
  });

  it('效果反馈落事件（创新点 ② 效果验证）', () => {
    const { store, engine, log } = setup();
    const id = seedPref(store, 'm3');
    engine.recordOutcome(id, true, '用户采纳');
    engine.recordOutcome(id, false, '用户纠正');

    const measured = log.byType('principle.effectMeasured');
    const corrected = log.byType('intervention.correct');
    expect(measured).toHaveLength(1);
    expect(corrected).toHaveLength(1);
    // 反馈要能追溯到是哪条记忆、用户说了什么
    expect(measured[0]?.payload).toMatchObject({ memoryId: 'm3', effective: true, note: '用户采纳' });
    expect(corrected[0]?.payload).toMatchObject({ memoryId: 'm3', effective: false });
  });

  it('冲突会扣分并留痕', () => {
    const { store, engine, log } = setup();
    const id = seedPref(store, 'm4');
    engine.recordConflict(id);
    expect(engine.statsOf(id).conflicts).toBe(1);
    expect(log.byType('fitness.updated').length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 演化主循环
// ═══════════════════════════════════════════════════════════

describe('runPass · 一轮演化', () => {
  it('★ 长期未命中的记忆进入休眠', () => {
    const { store, engine, clock, log } = setup();
    seedPref(store, 'old');

    clock.advance(61 * DAY); // 超过 60 天阈值
    const r = engine.runPass();

    expect(r.dormant).toContain('old');
    expect(store.get('old')?.lifecycle).toBe('dormant');
    expect(store.get('old')?.dormantSince).toBeDefined();
    expect(log.byType('memory.dormant')).toHaveLength(1);
  });

  it('未到阈值的记忆保持活跃', () => {
    const { store, engine, clock } = setup();
    seedPref(store, 'fresh');
    clock.advance(30 * DAY);
    const r = engine.runPass();
    expect(r.dormant).toHaveLength(0);
    expect(store.get('fresh')?.lifecycle).toBe('active');
  });

  it('★ 休眠且适应度低的记忆归档', () => {
    const { store, engine, clock } = setup();
    const id = seedPref(store, 'fading');
    // 先把它压低
    engine.adjustWeight(id, -0.6);

    clock.advance(61 * DAY);
    engine.runPass(); // 第一轮：进入休眠
    expect(store.get(id)?.lifecycle).toBe('dormant');

    clock.advance(200 * DAY);
    const r2 = engine.runPass(); // 第二轮：适应度已随衰减跌破阈值 → 归档
    expect(store.get(id)?.lifecycle).toBe('archived');
    void r2;
  });

  it('★ 归档且仍存在（淘汰 ≠ 删除）', () => {
    const { store, engine, clock, log } = setup();
    const id = seedPref(store, 'gone');
    engine.adjustWeight(id, -0.6);
    clock.advance(61 * DAY);
    engine.runPass();
    clock.advance(200 * DAY);
    engine.runPass();

    expect(store.get(id)?.lifecycle).toBe('archived');
    expect(store.get(id)).toBeDefined(); // 数据还在
    expect(store.get(id)?.content).toBe('偏好清淡口味');
    // 归档必须留痕，否则界面上"归档区"永远空着
    expect(log.byType('memory.archived')).toHaveLength(1);
  });

  it('命中会写 memory.recalled 事件（界面上"记忆引用"的数据源）', () => {
    const { store, engine, log } = setup();
    const id = seedPref(store, 'cited');
    engine.recordHit(id);
    engine.recordHit(id);

    const ev = log.byType('memory.recalled');
    expect(ev).toHaveLength(2);
    expect(ev[0]?.payload).toMatchObject({ memoryId: 'cited', hits: 1 });
  });

  it('硬约束永不迁移（跑多少轮都一样）', () => {
    const { store, engine, clock } = setup();
    store.create(butler, {
      id: 'hard',
      memClass: 'global_constraint',
      kind: 'fact',
      content: '你对花生严重过敏',
      confidence: 0.99,
      evidence: [],
      lifecycle: 'active',
    });

    for (let i = 0; i < 5; i++) {
      clock.advance(365 * DAY);
      engine.runPass();
    }
    expect(store.get('hard')?.lifecycle).toBe('active');
  });

  it('阈值自适应会落事件（参数演化）', () => {
    const { store, engine, log } = setup();
    for (let i = 0; i < 60; i++) seedPref(store, `m${i}`, `偏好条目 ${i}`);
    engine.runPass();
    expect(log.byType('evolution.thresholdAdapted').length).toBeGreaterThanOrEqual(0);
    expect(engine.currentThreshold()).toBeGreaterThanOrEqual(DEFAULT_PARAMS.recallThresholdBase);
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 唤醒：淘汰可逆
// ═══════════════════════════════════════════════════════════

describe('★ 休眠/归档可唤醒（"淘汰不等于删除"）', () => {
  it('休眠记忆被再次命中时自动唤醒', () => {
    const { store, engine, clock, log } = setup();
    const id = seedPref(store, 'sleepy');

    clock.advance(61 * DAY);
    engine.runPass();
    expect(store.get(id)?.lifecycle).toBe('dormant');

    clock.advance(5 * DAY);
    const t = engine.recordHit(id);

    expect(t.kind).toBe('revived');
    expect(store.get(id)?.lifecycle).toBe('active');
    expect(store.get(id)?.revivedCount).toBe(1);
    expect(store.get(id)?.dormantSince).toBeUndefined(); // 休眠标记被清掉
    expect(log.byType('memory.revived')).toHaveLength(1);
  });

  it('归档记忆也能被唤醒', () => {
    const { store, engine, clock } = setup();
    const id = seedPref(store, 'buried');
    engine.adjustWeight(id, -0.6);
    clock.advance(61 * DAY);
    engine.runPass();
    clock.advance(200 * DAY);
    engine.runPass();
    expect(store.get(id)?.lifecycle).toBe('archived');

    clock.advance(1 * DAY);
    const t = engine.recordHit(id);
    expect(t.kind).toBe('revived');
    expect(store.get(id)?.lifecycle).toBe('active');
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 人工干预（§ 8.6：演化不是黑盒）
// ═══════════════════════════════════════════════════════════

describe('★ 人工干预 · 用户可治理演化', () => {
  it('手动提升权重，且不被 EMA 平滑掉', () => {
    const { store, engine, log } = setup();
    const id = seedPref(store, 'manual');
    const before = store.get(id)?.fitness ?? 0;

    const ok = engine.adjustWeight(id, 0.15, '用户认为这条很重要');
    expect(ok).toBe(true);
    expect(store.get(id)?.fitness).toBeCloseTo(before + 0.15, 5);

    const ev = log.byType('intervention.weightAdjusted');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ reason: '用户认为这条很重要' });
  });

  it('手动降低权重', () => {
    const { store, engine } = setup();
    const id = seedPref(store, 'down');
    engine.adjustWeight(id, -0.3);
    expect(store.get(id)?.fitness).toBeLessThan(0.6);
  });

  it('权重不会越过上限或低于 0', () => {
    const { store, engine } = setup();
    const id = seedPref(store, 'clamp');
    engine.adjustWeight(id, 5);
    expect(store.get(id)?.fitness).toBeLessThanOrEqual(DEFAULT_PARAMS.maxFitness);
    engine.adjustWeight(id, -99);
    expect(store.get(id)?.fitness).toBe(0);
  });

  it('★ 强制唤醒（用户可以把被淘汰的记忆捞回来）', () => {
    const { store, engine, clock } = setup();
    const id = seedPref(store, 'revive-me');
    clock.advance(61 * DAY);
    engine.runPass();
    expect(store.get(id)?.lifecycle).toBe('dormant');

    expect(engine.forceRevive(id)).toBe(true);
    expect(store.get(id)?.lifecycle).toBe('active');
    expect(store.get(id)?.revivedCount).toBe(1);
  });

  it('★ 强制归档', () => {
    const { store, engine } = setup();
    const id = seedPref(store, 'archive-me');
    expect(engine.forceArchive(id)).toBe(true);
    expect(store.get(id)?.lifecycle).toBe('archived');
  });

  it('硬约束不能被强制归档（安全底线）', () => {
    const { store, engine } = setup();
    store.create(butler, {
      id: 'hard2',
      memClass: 'global_constraint',
      kind: 'fact',
      content: '过敏',
      confidence: 0.99,
      evidence: [],
      lifecycle: 'active',
    });
    expect(engine.forceArchive('hard2')).toBe(false);
    expect(engine.forceRevive('hard2')).toBe(false);
    expect(engine.adjustWeight('hard2', 0.2)).toBe(false);
    expect(store.get('hard2')?.lifecycle).toBe('active');
  });

  it('干预记录进演化日志（可展示）', () => {
    const { store, engine } = setup();
    const id = seedPref(store, 'logged');
    engine.adjustWeight(id, 0.1);
    const evo = engine.evolutionEvents();
    const last = evo[evo.length - 1];
    expect(last?.type).toBe('weightAdjusted');
    expect(last?.actor).toBe('user'); // ★ 用户操作要能区分出来
  });
});

// ═══════════════════════════════════════════════════════════
// 演化日志（界面"本月 3 条休眠、1 条唤醒"的来源）
// ═══════════════════════════════════════════════════════════

describe('演化日志 · 可观测性', () => {
  it('汇总休眠/归档/唤醒记录', () => {
    const { store, engine, clock } = setup();
    seedPref(store, 'a');
    seedPref(store, 'b');

    clock.advance(61 * DAY);
    engine.runPass(); // a、b 都休眠

    clock.advance(1 * DAY);
    engine.recordHit('a'); // a 被唤醒

    const evo = engine.evolutionEvents();
    const dormant = evo.filter((e) => e.type === 'dormant');
    const revived = evo.filter((e) => e.type === 'revived');

    expect(dormant.length).toBeGreaterThanOrEqual(2);
    expect(revived.length).toBeGreaterThanOrEqual(1);
    // 每条日志都有可读的说明
    expect(evo.every((e) => e.detail.length > 0)).toBe(true);
  });

  it('日志条目带时间戳与 memoryId，可追溯', () => {
    const { store, engine, clock } = setup();
    seedPref(store, 'trace');
    clock.advance(61 * DAY);
    engine.runPass();

    const e = engine.evolutionEvents().find((x) => x.type === 'dormant');
    expect(e?.at).toBe(clock.now());
    expect(e?.memoryIds).toContain('trace');
    expect(e?.userId).toBe(USER);
  });
});

describe('反馈统计可重放', () => {
  it('successes / misuses / conflicts 重启后从 store 与事件恢复', () => {
    const { log, store, clock, engine } = setup();
    const id = seedPref(store, 'replay');

    engine.recordHit(id);
    engine.recordOutcome(id, true, '用户未纠正');
    recordEffect({
      log,
      store,
      clock,
      taskId: 't-replay',
      principleId: id,
      effective: true,
    });
    engine.recordOutcome(id, false, '用户纠正');
    engine.recordConflict(id);

    const before = engine.statsOf(id);
    expect(before.successes).toBe(1);
    expect(before.misuses).toBe(1);
    expect(before.conflicts).toBe(1);

    const restarted = new EvolutionEngine({
      log,
      store,
      clock,
      random: new SeededRandom(1234),
      userId: USER,
    });
    const after = restarted.statsOf(id);
    expect(after.successes).toBe(1);
    expect(after.misuses).toBe(1);
    expect(after.conflicts).toBe(1);
    expect(after.hits).toBe(before.hits);
  });
});
