/**
 * 记忆演化测试 —— 第四层创新的行为锁定
 *
 * 这些测试要回答一个问题：
 * **"记得越久越准"这句话，在代码层面真的成立吗？**
 *
 * 覆盖：适应度公式、EMA 渐变、按类型区分的衰减、生命周期状态机、
 *       防退化三件套（多样性 / 探索 / 权重上限）、参数自适应。
 */

import { describe, expect, it } from 'vitest';

import type { MemoryEntry } from '../types.js';
import {
  adaptThreshold,
  computeFitness,
  decayClassOf,
  decayFactor,
  DEFAULT_PARAMS,
  FITNESS_WEIGHTS,
  nextLifecycle,
  transitionToEvolutionEvent,
  type OutcomeStats,
} from '../fitness.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_760_000_000_000;

// ── 夹具 ──

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm1',
    owner: { kind: 'butler', userId: 'u' },
    memClass: 'global_shared',
    kind: 'preference',
    content: '偏好清淡',
    confidence: 0.8,
    evidence: ['e1'],
    fitness: 0.5,
    lifecycle: 'active',
    lastHitAt: null,
    hitCount: 0,
    revivedCount: 0,
    scope: 'global',
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    useCount: 0,
    ...over,
  };
}

function stats(over: Partial<OutcomeStats> = {}): OutcomeStats {
  return {
    hits: 0,
    successes: 0,
    misuses: 0,
    conflicts: 0,
    lastHitAt: null,
    createdAt: T0,
    evidenceCount: 1,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════
// 衰减档位（第三层：按记忆类型区分）
// ═══════════════════════════════════════════════════════════

describe('decayClassOf · 按类型区分衰减速率', () => {
  it('★ 硬约束永不衰减', () => {
    expect(decayClassOf({ memClass: 'global_constraint', kind: 'fact' })).toBe('none');
    // 无论内容是偏好还是原则，硬约束都不衰减
    expect(decayClassOf({ memClass: 'global_constraint', kind: 'preference' })).toBe('none');
  });

  it('事实衰减慢，偏好与原则中等', () => {
    expect(decayClassOf({ memClass: 'global_shared', kind: 'fact' })).toBe('slow');
    expect(decayClassOf({ memClass: 'domain', kind: 'preference' })).toBe('medium');
    expect(decayClassOf({ memClass: 'domain', kind: 'principle' })).toBe('medium');
  });
});

describe('decayFactor · 指数衰减', () => {
  it('不衰减档位恒为 1', () => {
    expect(decayFactor('none', 10 * 365 * DAY)).toBe(1);
  });

  it('经过一个半衰期后剩一半', () => {
    expect(decayFactor('medium', 120 * DAY)).toBeCloseTo(0.5, 6);
    expect(decayFactor('slow', 365 * DAY)).toBeCloseTo(0.5, 6);
  });

  it('时间越久衰减越多，但永不为负', () => {
    const a = decayFactor('fast', 30 * DAY);
    const b = decayFactor('fast', 90 * DAY);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 适应度公式
// ═══════════════════════════════════════════════════════════

describe('computeFitness · 公式与权重', () => {
  it('权重与方案 § 8.4 一致，正项和为 1', () => {
    const positive =
      FITNESS_WEIGHTS.w1_usage +
      FITNESS_WEIGHTS.w2_effectiveness +
      FITNESS_WEIGHTS.w3_evidence +
      FITNESS_WEIGHTS.w4_recency;
    expect(positive).toBeCloseTo(1, 6);
  });

  it('高频命中 + 全部奏效 + 证据充分 + 刚命中 → 高适应度', () => {
    const r = computeFitness({
      entry: entry(),
      stats: stats({ hits: 20, successes: 10, misuses: 0, lastHitAt: T0, evidenceCount: 5 }),
      now: T0,
      previousFitness: 0.5,
    });
    expect(r.observed).toBeGreaterThan(0.85);
  });

  it('从不命中 + 长期未用 → 低适应度', () => {
    const r = computeFitness({
      entry: entry(),
      stats: stats({ hits: 0, lastHitAt: null, createdAt: T0 - 400 * DAY }),
      now: T0,
      previousFitness: 0.5,
    });
    expect(r.observed).toBeLessThan(0.3);
  });

  it('★ 误用惩罚：被纠正过的记忆分数显著更低', () => {
    const base = stats({ hits: 8, successes: 8, misuses: 0, lastHitAt: T0 });
    const abused = stats({ hits: 8, successes: 5, misuses: 5, lastHitAt: T0 });

    const good = computeFitness({ entry: entry(), stats: base, now: T0 });
    const bad = computeFitness({ entry: entry(), stats: abused, now: T0 });

    expect(bad.observed).toBeLessThan(good.observed);
    expect(bad.components.misusePenalty).toBeGreaterThan(0);
  });

  it('★ 冲突惩罚：矛盾多的记忆被扣分', () => {
    const clean = computeFitness({ entry: entry(), stats: stats({ hits: 8, lastHitAt: T0 }), now: T0 });
    const conflicted = computeFitness({
      entry: entry(),
      stats: stats({ hits: 8, lastHitAt: T0, conflicts: 3 }),
      now: T0,
    });
    expect(conflicted.observed).toBeLessThan(clean.observed);
    expect(conflicted.components.conflictPenalty).toBe(1);
  });

  it('无反馈时效果分量为中性 0.5，不奖不罚', () => {
    const r = computeFitness({ entry: entry(), stats: stats({ hits: 3 }), now: T0 });
    expect(r.components.effectiveness).toBe(0.5);
  });

  it('结果被限制在 [0, 1]', () => {
    const hi = computeFitness({
      entry: entry(),
      stats: stats({ hits: 999, successes: 999, lastHitAt: T0, evidenceCount: 99 }),
      now: T0,
    });
    const lo = computeFitness({
      entry: entry(),
      stats: stats({ conflicts: 99, misuses: 99, createdAt: T0 - 9999 * DAY }),
      now: T0,
    });
    expect(hi.observed).toBeLessThanOrEqual(1);
    expect(lo.observed).toBeGreaterThanOrEqual(0);
  });

  it('★ 权重上限：单条记忆不会主导一切', () => {
    const r = computeFitness({
      entry: entry(),
      stats: stats({ hits: 999, successes: 999, lastHitAt: T0, evidenceCount: 99 }),
      now: T0,
      previousFitness: 1,
    });
    expect(r.smoothed).toBeLessThanOrEqual(DEFAULT_PARAMS.maxFitness);
  });
});

// ═══════════════════════════════════════════════════════════
// EMA 渐变（"进化不等于突变"）
// ═══════════════════════════════════════════════════════════

describe('EMA 平滑 · 渐变而非突变', () => {
  it('★ 单次事件不会让适应度剧烈跳变', () => {
    const prev = 0.8;
    // 一次很差的观测（observed ≈ 0）
    const r = computeFitness({
      entry: entry(),
      stats: stats({ conflicts: 3, createdAt: T0 - 9999 * DAY }),
      now: T0,
      previousFitness: prev,
    });

    const drop = prev - r.smoothed;
    // α=0.15 → 最多下降 15% × (prev − observed)
    expect(drop).toBeLessThanOrEqual(DEFAULT_PARAMS.emaAlpha * prev + 1e-9);
    expect(r.smoothed).toBeGreaterThan(0.6);
  });

  it('连续多次同向观测会逐步收敛（时间尺度：周级）', () => {
    let f = 0.9;
    const trace: number[] = [f];
    for (let i = 0; i < 20; i++) {
      const r = computeFitness({
        entry: entry({ fitness: f }),
        stats: stats({ hits: 0, createdAt: T0 - 9999 * DAY }),
        now: T0,
        previousFitness: f,
      });
      f = r.smoothed;
      trace.push(f);
    }
    // 单调下降
    expect(trace[20]).toBeLessThan(trace[0] as number);
    // 20 轮（≈ 5 周）后已从 0.9 降到 0.23 附近 ——
    // α=0.15 的 EMA 在 20 步后的残余为 (1-α)^20 ≈ 0.039，
    // 所以这不是"还没收敛"，而是**本来就该这么慢**："演化无法加速"。
    // 再加 20 步才会进入 0.15 以下的稳态区间。
    expect(trace[20]).toBeLessThan(0.25);
    expect(trace[20]).toBeGreaterThan(0.15);
  });

  it('★ 长期趋势：收敛到观测值，但需要很长时间（"演化无法加速"）', () => {
    const observed = computeFitness({
      entry: entry(),
      stats: stats({ hits: 0, createdAt: T0 - 9999 * DAY }),
      now: T0,
    }).observed;

    const run = (steps: number): { trace: number[]; final: number } => {
      let f = 0.9;
      const trace: number[] = [];
      for (let i = 0; i < steps; i++) {
        f = computeFitness({
          entry: entry({ fitness: f }),
          stats: stats({ hits: 0, createdAt: T0 - 9999 * DAY }),
          now: T0,
          previousFitness: f,
        }).smoothed;
        trace.push(f);
      }
      return { trace, final: f };
    };

    const s60 = run(60);
    const s200 = run(200);

    // 全程单调不增
    for (let i = 1; i < s60.trace.length; i++) {
      expect(s60.trace[i]).toBeLessThanOrEqual(s60.trace[i - 1] as number);
    }

    // 长期收敛到观测值附近（终态由公式决定，不是随手定的数）
    expect(s200.final).toBeLessThan(observed * 1.5);
    expect(s200.final).toBeGreaterThan(0);

    // ★ 关键性质：60 轮之后还在 0.2 上下 —— 没有"瞬间跳到 0"
    //   这正是方案 § 8.7 说的"演化无法加速"：EMA 的收敛是按周计的
    expect(s60.final).toBeGreaterThan(0.15);
    expect(s200.final).toBeLessThan(s60.final);
  });

  it('α 越大响应越快（可调参数）', () => {
    const slow = computeFitness({
      entry: entry(),
      stats: stats({ hits: 0, createdAt: T0 - 9999 * DAY }),
      now: T0,
      params: { ...DEFAULT_PARAMS, emaAlpha: 0.1 },
      previousFitness: 0.8,
    });
    const fast = computeFitness({
      entry: entry(),
      stats: stats({ hits: 0, createdAt: T0 - 9999 * DAY }),
      now: T0,
      params: { ...DEFAULT_PARAMS, emaAlpha: 0.5 },
      previousFitness: 0.8,
    });
    expect(fast.smoothed).toBeLessThan(slow.smoothed);
  });

  it('★ 硬约束不做平滑（它本来就不参与演化）', () => {
    const r = computeFitness({
      entry: entry({ memClass: 'global_constraint', fitness: 0.99 }),
      stats: stats({ hits: 0, conflicts: 3, createdAt: T0 - 9999 * DAY }),
      now: T0,
      previousFitness: 0.99,
    });
    // 直接返回观测值，不被历史拖住
    expect(r.smoothed).toBe(r.observed);
    expect(r.decayClass).toBe('none');
  });
});

// ═══════════════════════════════════════════════════════════
// 生命周期状态机
// ═══════════════════════════════════════════════════════════

describe('nextLifecycle · 四态迁移', () => {
  it('★ 活跃 → 休眠：连续 60 天未命中', () => {
    const t = nextLifecycle({
      entry: entry({ lifecycle: 'active' }),
      stats: stats({ lastHitAt: T0 - 61 * DAY }),
      now: T0,
    });
    expect(t.kind).toBe('dormant');
    if (t.kind === 'dormant') expect(t.reason).toContain('61 天');
  });

  it('还在阈值内不迁移', () => {
    const t = nextLifecycle({
      entry: entry({ lifecycle: 'active' }),
      stats: stats({ lastHitAt: T0 - 30 * DAY }),
      now: T0,
    });
    expect(t.kind).toBe('none');
  });

  it('★ 休眠 → 归档：适应度跌破阈值', () => {
    const t = nextLifecycle({
      entry: entry({ lifecycle: 'dormant', fitness: 0.1, dormantSince: T0 - 100 * DAY }),
      stats: stats({ lastHitAt: T0 - 100 * DAY }),
      now: T0,
    });
    expect(t.kind).toBe('archived');
  });

  it('休眠但适应度尚可时不归档（渐变，不激进）', () => {
    const t = nextLifecycle({
      entry: entry({ lifecycle: 'dormant', fitness: 0.4, dormantSince: T0 - 100 * DAY }),
      stats: stats({ lastHitAt: T0 - 100 * DAY }),
      now: T0,
    });
    expect(t.kind).toBe('none');
  });

  it('★ 休眠可逆：被再次命中即唤醒', () => {
    const t = nextLifecycle({
      entry: entry({ lifecycle: 'dormant', fitness: 0.2, dormantSince: T0 - 50 * DAY }),
      stats: stats({ lastHitAt: T0 - 1 * DAY }), // 休眠之后又命中了
      now: T0,
    });
    expect(t.kind).toBe('revived');
  });

  it('★ 归档也可唤醒（"淘汰 ≠ 删除"的关键）', () => {
    const t = nextLifecycle({
      entry: entry({ lifecycle: 'archived', fitness: 0.1, archivedAt: T0 - 80 * DAY }),
      stats: stats({ lastHitAt: T0 - 2 * DAY }),
      now: T0,
    });
    expect(t.kind).toBe('revived');
  });

  it('休眠后没有新命中则不唤醒', () => {
    const t = nextLifecycle({
      entry: entry({ lifecycle: 'dormant', fitness: 0.4, dormantSince: T0 - 10 * DAY }),
      stats: stats({ lastHitAt: T0 - 50 * DAY }), // 命中发生在休眠之前
      now: T0,
    });
    expect(t.kind).toBe('none');
  });

  it('★ 硬约束永不迁移', () => {
    const t = nextLifecycle({
      entry: entry({ memClass: 'global_constraint', lifecycle: 'active', fitness: 0.01 }),
      stats: stats({ lastHitAt: T0 - 999 * DAY }),
      now: T0,
    });
    expect(t.kind).toBe('none');
  });

  it('候选不参与自动迁移（等用户审核）', () => {
    const t = nextLifecycle({
      entry: entry({ lifecycle: 'candidate' }),
      stats: stats({ lastHitAt: T0 - 999 * DAY }),
      now: T0,
    });
    expect(t.kind).toBe('none');
  });
});

// ═══════════════════════════════════════════════════════════
// 第三层 · 参数演化
// ═══════════════════════════════════════════════════════════

describe('adaptThreshold · 召回阈值随规模自适应', () => {
  it('小库用基准阈值', () => {
    expect(adaptThreshold(10)).toBe(DEFAULT_PARAMS.recallThresholdBase);
    expect(adaptThreshold(20)).toBe(DEFAULT_PARAMS.recallThresholdBase);
  });

  it('★ 库越大阈值越高（保证精度）', () => {
    const t200 = adaptThreshold(200);
    const t2000 = adaptThreshold(2000);
    expect(t200).toBeGreaterThan(DEFAULT_PARAMS.recallThresholdBase);
    expect(t2000).toBeGreaterThan(t200);
  });

  it('有上限，不会高到无记忆可召回', () => {
    expect(adaptThreshold(10_000_000)).toBeLessThanOrEqual(0.7);
  });
});

// ═══════════════════════════════════════════════════════════
// 演化日志
// ═══════════════════════════════════════════════════════════

describe('transitionToEvolutionEvent · 演化日志', () => {
  it('生成可展示的日志条目', () => {
    const e = transitionToEvolutionEvent({
      id: 'evo_1',
      userId: 'u',
      memoryId: 'm1',
      transition: { kind: 'dormant', reason: '连续 61 天未被命中' },
      now: T0,
    });
    expect(e?.type).toBe('dormant');
    expect(e?.detail).toContain('61 天');
    expect(e?.actor).toBe('system');
  });

  it('无迁移时不产生日志', () => {
    const e = transitionToEvolutionEvent({
      id: 'evo_2',
      userId: 'u',
      memoryId: 'm1',
      transition: { kind: 'none' },
      now: T0,
    });
    expect(e).toBeNull();
  });

  it('用户手动干预的日志标注 actor=user（可观测 + 可干预）', () => {
    const e = transitionToEvolutionEvent({
      id: 'evo_3',
      userId: 'u',
      memoryId: 'm1',
      transition: { kind: 'revived', reason: '用户手动唤醒' },
      now: T0,
      actor: 'user',
    });
    expect(e?.actor).toBe('user');
  });
});
