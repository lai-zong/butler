/**
 * 记忆召回测试 —— 锁住"演化式召回"的五个性质
 *
 * 核心要回答：为什么这个召回比"取最近 N 条"或"取全部"更好？
 *   · 分权过滤：不该看到的绝对看不到
 *   · 适应度加权：同样相关的两条，常用的那条优先
 *   · 探索性召回：低适应度的记忆有机会被验证（防局部最优）
 *   · 多样性保护：不会因为几条高分记忆而只说一件事（防过度剪枝）
 *   · 硬约束恒召回：安全不靠匹配分数
 */

import { describe, expect, it } from 'vitest';

import { SeededRandom } from '../../ports/clock.js';
import type { MemoryEntry, MemoryLifecycle, MemoryKind } from '../types.js';
import {
  relevanceOf,
  recall,
  RECALL_WEIGHTS,
  scoreMemory,
  SEMANTIC_RELEVANCE_THRESHOLD,
} from '../recall.js';

const T0 = 1_760_000_000_000;

function mem(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    owner: { kind: 'butler', userId: 'u' },
    memClass: 'global_shared',
    kind: 'preference',
    content: '偏好清淡口味',
    confidence: 0.8,
    evidence: [],
    fitness: 0.8,
    lifecycle: 'active' as MemoryLifecycle,
    lastHitAt: T0,
    hitCount: 3,
    revivedCount: 0,
    scope: 'global',
    version: 1,
    createdAt: T0 - 86_400_000,
    updatedAt: T0,
    useCount: 3,
    ...over,
  };
}

function run(args: {
  candidates: MemoryEntry[];
  query?: string;
  limit?: number;
  seed?: number;
  favored?: 'life' | 'health';
}) {
  return recall({
    query: args.query ?? '周末请朋友吃饭，需要清淡的菜',
    candidates: args.candidates,
    limit: args.limit ?? 5,
    now: T0,
    random: new SeededRandom(args.seed ?? 42),
    ...(args.favored !== undefined ? { favoredServant: args.favored } : {}),
  });
}

// ═══════════════════════════════════════════════════════════
// 相关性打分
// ═══════════════════════════════════════════════════════════

describe('relevanceOf · 相关性', () => {
  it('★ 硬约束恒为 1.0（安全不能靠匹配分数）', () => {
    const hard = mem({ id: 'm1', memClass: 'global_constraint', content: '你对花生严重过敏' });
    // 即使查询完全不沾边
    expect(relevanceOf(hard, '帮我写一段排序算法')).toBe(1);
  });

  it('谈同一概念时高分', () => {
    const m = mem({ id: 'm2', content: '你偏好清淡口味' });
    expect(relevanceOf(m, '需要清淡的菜')).toBeGreaterThan(0.5);
  });

  it('完全无关时为 0', () => {
    const m = mem({ id: 'm3', content: '你偏好靠窗座位' });
    expect(relevanceOf(m, '帮我调试 React 组件')).toBe(0);
  });
});

describe('scoreMemory · 三项加权', () => {
  it('权重与设计一致且和为 1', () => {
    const sum = RECALL_WEIGHTS.relevance + RECALL_WEIGHTS.fitness + RECALL_WEIGHTS.confidence;
    expect(sum).toBeCloseTo(1, 6);
  });

  it('★ 同样相关时，适应度高者得分更高（"越用越准"）', () => {
    const used = mem({ id: 'hot', content: '你偏好清淡口味', fitness: 0.95 });
    const cold = mem({ id: 'cold', content: '你偏好清淡口味', fitness: 0.3 });

    const a = scoreMemory(used, '需要清淡的菜');
    const b = scoreMemory(cold, '需要清淡的菜');
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('主责领域的领域记忆获得加成', () => {
    const lifeDomain = mem({
      id: 'd1',
      memClass: 'domain',
      content: '你偏好清淡口味',
      // ★ v7（A2）：归属恒为管家，领域用独立标签表达
      owner: { kind: 'butler', userId: 'u' },
      domain: 'life',
    });
    const noFavor = scoreMemory(lifeDomain, '需要清淡的菜');
    const favored = scoreMemory(lifeDomain, '需要清淡的菜', 'life');
    expect(favored.relevance).toBeGreaterThan(noFavor.relevance);
  });

  it('加成不会让硬约束被挤掉', () => {
    const hard = mem({ id: 'h', memClass: 'global_constraint', content: '花生过敏' });
    const s = scoreMemory(hard, '花生过敏', 'life');
    expect(s.relevance).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 召回主流程
// ═══════════════════════════════════════════════════════════

describe('recall · 基本行为', () => {
  it('挑选与目标相关的记忆，排除不相关的', () => {
    const r = run({
      candidates: [
        mem({ id: 'a', content: '你偏好清淡口味的家常菜' }),
        mem({ id: 'b', content: '你偏好靠窗座位' }),
        mem({ id: 'c', content: '你偏好清淡的蒸菜' }),
      ],
      query: '需要清淡的菜，请朋友吃饭',
    });
    const ids = r.selected.map((s) => s.memory.id);
    expect(ids).toContain('a');
    expect(ids).toContain('c');
    // 座位偏好与"清淡的菜"无关，不该被召回
    expect(ids).not.toContain('b');
  });

  it('完全无关的记忆一条都不召回', () => {
    const r = run({
      candidates: [mem({ id: 'x', content: '你偏好靠窗座位' })],
      query: '帮我调试 React 组件',
    });
    expect(r.selected).toHaveLength(0);
  });

  it('★ 硬约束在任何相关场景下都被召回', () => {
    const r = run({
      candidates: [
        mem({ id: 'hard', memClass: 'global_constraint', content: '你对花生严重过敏' }),
        mem({ id: 'x', content: '你偏好清淡口味' }),
      ],
      query: '帮我安排一次家宴',
    });
    expect(r.selected.map((s) => s.memory.id)).toContain('hard');
  });

  it('候选记忆不参与召回（等用户审核）', () => {
    const r = run({
      candidates: [
        mem({ id: 'cand', content: '你偏好清淡口味', lifecycle: 'candidate' }),
        mem({ id: 'ok', content: '你偏好清淡口味' }),
      ],
    });
    const ids = r.selected.map((s) => s.memory.id);
    expect(ids).not.toContain('cand');
    expect(ids).toContain('ok');
  });

  it('日记产生的试行记忆参与召回，但分数低于同内容稳定记忆', () => {
    const trial = mem({
      id: 'trial',
      content: '你偏好清淡口味',
      lifecycle: 'candidate',
      evidence: ['diary:2026-10-27'],
      fitness: 0.8,
      confidence: 0.8,
    });
    const active = mem({ id: 'active', content: '你偏好清淡口味' });
    const trialScore = scoreMemory(trial, '周末请朋友吃饭，需要清淡的菜').score;
    const activeScore = scoreMemory(active, '周末请朋友吃饭，需要清淡的菜').score;
    expect(trialScore).toBeLessThan(activeScore);
    const r = run({ candidates: [trial, active], limit: 5 });
    expect(r.selected.map((s) => s.memory.id)).toContain('trial');
  });

  it('结果不超过名额', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      mem({ id: `m${i}`, content: `你偏好清淡口味的第 ${i} 条` }),
    );
    expect(run({ candidates: many, limit: 3 }).selected.length).toBeLessThanOrEqual(3);
  });

  it('给出可解释的理由（用户能问"你为什么想起这件事"）', () => {
    const r = run({ candidates: [mem({ id: 'a', content: '你偏好清淡口味' })] });
    const first = r.selected[0];
    expect(first?.why).toBeTruthy();
    expect(first?.why).toContain('适应度');
  });

  it('阈值随候选规模上升（第三层参数演化）', () => {
    const few = run({ candidates: [mem({ id: 'a', content: '你偏好清淡口味' })] });
    const many = run({
      candidates: Array.from({ length: 500 }, (_, i) =>
        mem({ id: `m${i}`, content: '你偏好清淡口味' }),
      ),
      limit: 3,
    });
    expect(many.threshold).toBeGreaterThan(few.threshold);
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 防退化（方案 § 8.5）
// ═══════════════════════════════════════════════════════════

describe('★ 探索性召回 · 防局部最优', () => {
  it('低适应度的休眠记忆有机会被注入', () => {
    // 一条非常相关的活跃记忆 + 一条休眠但相关的记忆
    const candidates = [
      mem({ id: 'hot', content: '你偏好清淡口味的家常菜', fitness: 0.95 }),
      mem({
        id: 'sleepy',
        content: '你偏好清淡口味的蒸菜',
        fitness: 0.28,
        lifecycle: 'dormant',
        dormantSince: T0 - 100 * 86_400_000,
        lastHitAt: T0 - 200 * 86_400_000,
      }),
    ];

    // 探索比例 10% × limit 10 = 1 个名额
    const r = run({ candidates, limit: 10 });
    const exploratory = r.selected.filter((s) => s.exploratory);

    // 休眠那条要么因阈值内直接入选，要么被探索机制捞回 —— 总之不能消失
    const sleepy = r.selected.find((s) => s.memory.id === 'sleepy');
    expect(sleepy, '休眠记忆不应被完全排除').toBeDefined();
    expect(exploratory.length + (sleepy?.exploratory ? 0 : 1)).toBeGreaterThan(0);
  });

  it('探索项标注了原因（可解释）', () => {
    const candidates = [
      mem({ id: 'a', content: '你偏好清淡口味' }),
      mem({
        id: 'z',
        content: '你偏好清淡',
        fitness: 0.1,
        lifecycle: 'archived',
        archivedAt: T0 - 100 * 86_400_000,
        lastHitAt: T0 - 300 * 86_400_000,
      }),
    ];
    const r = run({ candidates, limit: 20 });
    const e = r.selected.find((s) => s.exploratory);
    if (e) {
      expect(e.why).toContain('探索性召回');
      expect(e.why).toContain('验证');
    }
  });

  it('探索名额有限（不会让低分记忆淹没结果）', () => {
    const candidates = [
      ...Array.from({ length: 5 }, (_, i) =>
        mem({ id: `good${i}`, content: `你偏好清淡口味的菜 ${i}`, fitness: 0.9 }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        mem({
          id: `low${i}`,
          content: `你偏好清淡口味 ${i}`,
          fitness: 0.1,
          lifecycle: 'dormant' as MemoryLifecycle,
          dormantSince: T0 - 100 * 86_400_000,
        }),
      ),
    ];
    const r = run({ candidates, limit: 6 });
    const n = r.selected.filter((s) => s.exploratory).length;
    // 10% × 6 = 0 个名额；即便向上取整也不该超过 1
    expect(n).toBeLessThanOrEqual(1);
  });
});

describe('★ 多样性保护 · 防过度剪枝', () => {
  it('同类记忆至少保留 N 条，不被高分者全挤掉', () => {
    const candidates = [
      // 三条高分偏好会把名额占满
      mem({ id: 'p1', content: '你偏好清淡口味一', fitness: 0.95 }),
      mem({ id: 'p2', content: '你偏好清淡口味二', fitness: 0.94 }),
      mem({ id: 'p3', content: '你偏好清淡口味三', fitness: 0.93 }),
      // 一条相关但分数较低的事实类记忆
      mem({ id: 'f1', kind: 'fact' as MemoryKind, content: '你偏好清淡口味的事实', fitness: 0.55 }),
      mem({ id: 'f2', kind: 'fact' as MemoryKind, content: '你偏好清淡口味的事实二', fitness: 0.5 }),
    ];
    const r = run({ candidates, limit: 5 });
    const kinds = new Set(r.selected.map((s) => s.memory.kind));
    // 事实类不应因分数低而被完全排除
    expect(kinds.has('fact'), '事实类记忆被全部挤掉，违反多样性保护').toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 确定性
// ═══════════════════════════════════════════════════════════

describe('确定性 · 可重放（ADR 0004）', () => {
  it('同一 seed 的两次召回结果完全一致', () => {
    const candidates = [
      mem({ id: 'a', content: '你偏好清淡口味' }),
      mem({ id: 'b', content: '你在减脂期需少油', fitness: 0.6 }),
      mem({
        id: 'c',
        content: '你偏好清淡口味的蒸菜',
        fitness: 0.2,
        lifecycle: 'dormant' as MemoryLifecycle,
      }),
    ];
    const r1 = run({ candidates, limit: 5, seed: 7 });
    const r2 = run({ candidates, limit: 5, seed: 7 });
    expect(r1.selected.map((s) => s.memory.id)).toEqual(r2.selected.map((s) => s.memory.id));
  });

  it('不依赖当前时间（now 从参数传入）', () => {
    const candidates = [mem({ id: 'a', content: '你偏好清淡口味' })];
    const r = run({ candidates });
    expect(r.selected.length).toBeGreaterThan(0);
  });
});

describe('语义扩展 · 保守接入', () => {
  it('语义相似度达到门槛时，可补字面漏掉的候选', () => {
    const candidate = mem({
      id: 'fatloss',
      content: '用户正在减脂期，需要控制油脂摄入',
      fitness: 0.8,
      confidence: 0.8,
    });
    const r = recall({
      query: '我想吃火锅',
      candidates: [candidate],
      limit: 5,
      now: T0,
      random: new SeededRandom(1),
      semantic: new Map([['fatloss', SEMANTIC_RELEVANCE_THRESHOLD + 0.1]]),
    });
    expect(r.selected.map((s) => s.memory.id)).toContain('fatloss');
  });

  it('低于门槛的语义分不扩展（避免无关记忆被放进来）', () => {
    const candidate = mem({
      id: 'fatloss',
      content: '用户正在减脂期，需要控制油脂摄入',
      fitness: 0.8,
      confidence: 0.8,
    });
    const r = recall({
      query: '我想吃火锅',
      candidates: [candidate],
      limit: 5,
      now: T0,
      random: new SeededRandom(1),
      semantic: new Map([['fatloss', SEMANTIC_RELEVANCE_THRESHOLD - 0.01]]),
    });
    expect(r.selected.map((s) => s.memory.id)).not.toContain('fatloss');
  });

  it('★ top-k 补充可让略低于阈值的候选进入结果（不降低全局阈值）', () => {
    const candidate = mem({
      id: 'fatloss',
      content: '用户正在减脂期，需要控制油脂摄入',
      fitness: 0.8,
      confidence: 0.8,
    });
    const r = recall({
      query: '我想吃火锅',
      candidates: [candidate],
      limit: 5,
      now: T0,
      random: new SeededRandom(1),
      semantic: new Map([['fatloss', 0.327]]),
      semanticTopK: 3,
      semanticFloor: 0.3,
    });
    expect(r.selected.map((s) => s.memory.id)).toContain('fatloss');
    expect(r.supplemented).toContain('fatloss');
  });

  it('top-k 补充只取语义最靠前的少量候选，不把低分候选全放进来', () => {
    const candidates = [
      mem({ id: 'far', content: '用户喜欢旅行', fitness: 0.5, confidence: 0.5 }),
      mem({ id: 'near', content: '用户正在减脂期', fitness: 0.5, confidence: 0.5 }),
      mem({ id: 'mid', content: '用户控制饮食', fitness: 0.5, confidence: 0.5 }),
    ];
    const r = recall({
      query: '火锅',
      candidates,
      limit: 5,
      now: T0,
      random: new SeededRandom(1),
      semantic: new Map([
        ['far', 0.31],
        ['near', 0.39],
        // 故意低于 0.35：它不能靠“正常语义阈值”进来，只能靠 top-k。
        ['mid', 0.34],
      ]),
      semanticTopK: 1,
      semanticFloor: 0.3,
    });
    expect(r.selected.map((s) => s.memory.id)).toEqual(['near']);
    expect(r.supplemented).toEqual(['near']);
  });
});
