/**
 * 相似合并测试 —— 演化第二层最后一块
 *
 * ★ 要证明的三条纪律：
 *   ① 合并可选（挑信息量大的），但**可追溯**（mergedFrom + 旧条目归档不删）
 *   ② 证据与效果**累加**，不丢历史
 *   ③ **硬约束永不合并** —— "花生过敏"与"坚果过敏"合并是危险的
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../store.js';
import {
  MERGE_SIMILARITY,
  MERGE_SUGGEST_FLOOR,
  canMerge,
  findMergeCandidates,
  findMergeSuggestions,
  mergeAll,
  mergeMemories,
  mergeStats,
} from '../merge.js';
import type { MemoryClass, MemoryEntry, MemoryKind } from '../types.js';

const T0 = 1_760_000_000_000;
const USER = 'u_mg';
const butler = { kind: 'butler', userId: USER } as const;

function setup() {
  const log = new EventLog('s_mg');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, USER);
  return { log, clock, store };
}

/** 建一条记忆。 */
function seed(
  store: MemoryStore,
  args: {
    id: string;
    content: string;
    kind?: MemoryKind;
    memClass?: MemoryClass;
    confidence?: number;
    evidence?: readonly string[];
    domainOwner?: 'life' | 'health' | 'work' | 'code' | 'study';
    lifecycle?: 'candidate' | 'active';
    principle?: { condition: string; action: string };
  },
): string {
  const r = store.create(butler, {
    id: args.id,
    memClass: args.memClass ?? 'global_shared',
    kind: args.kind ?? 'preference',
    content: args.content,
    confidence: args.confidence ?? 0.8,
    evidence: args.evidence ?? ['evt_1'],
    lifecycle: args.lifecycle ?? 'active',
    ...(args.domainOwner !== undefined ? { domainOwner: args.domainOwner } : {}),
  });
  if (!r.ok) throw new Error(`建档失败 ${args.id}：${r.reason}`);
  if (args.principle) store.setPrincipleDetail(args.id, args.principle);
  return args.id;
}

// ═══════════════════════════════════════════════════════════
// ① 合并资格
// ═══════════════════════════════════════════════════════════

describe('① ★ 硬约束永不合并', () => {
  it('★ 全局硬约束不参与合并', () => {
    const { store } = setup();
    seed(store, {
      id: 'c1',
      content: '你对花生严重过敏',
      memClass: 'global_constraint',
    });
    const e = store.get('c1');
    if (!e) throw new Error('missing');
    expect(canMerge(e)).toBe(false);
  });

  it('★ 两条语义几乎相同的硬约束也不合并（安全约束必须逐条独立）', () => {
    const { store } = setup();
    seed(store, { id: 'c1', content: '你对花生严重过敏', memClass: 'global_constraint' });
    seed(store, { id: 'c2', content: '你对花生严重过敏，务必避免', memClass: 'global_constraint' });

    expect(findMergeCandidates(store)).toHaveLength(0);
  });

  it('敏感域不参与合并（合并会模糊授权边界）', () => {
    const { store } = setup();
    seed(store, { id: 's1', content: '身份证号 110101...', memClass: 'sensitive', kind: 'fact' });
    const e = store.get('s1');
    if (!e) throw new Error('missing');
    expect(canMerge(e)).toBe(false);
  });

  it('候选（未审核）不参与合并', () => {
    const { store } = setup();
    seed(store, { id: 'p1', content: '喜欢清淡口味', lifecycle: 'candidate' });
    const e = store.get('p1');
    if (!e) throw new Error('missing');
    expect(canMerge(e)).toBe(false);
  });

  it('已归档的不再参与', () => {
    const { store } = setup();
    seed(store, { id: 'a1', content: 'x' });
    store.setLifecycle('a1', 'archived', { archivedAt: T0 });
    const e = store.get('a1');
    if (!e) throw new Error('missing');
    expect(canMerge(e)).toBe(false);
  });

  it('普通记忆可以合并', () => {
    const { store } = setup();
    seed(store, { id: 'n1', content: '喜欢清淡口味' });
    const e = store.get('n1');
    if (!e) throw new Error('missing');
    expect(canMerge(e)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// ② 找出可合并的组合
// ═══════════════════════════════════════════════════════════

describe('② 找可合并的组合', () => {
  it('★ 语义相近的两条被识别出来', () => {
    const { store } = setup();
    seed(store, { id: 'a', content: '用户喜欢清淡口味的菜' });
    seed(store, { id: 'b', content: '用户喜欢清淡口味的菜，不爱油腻' });

    const c = findMergeCandidates(store);
    expect(c).toHaveLength(1);
    expect(c[0]!.similarity).toBeGreaterThanOrEqual(MERGE_SIMILARITY);
  });

  it('不相关的两条不会被合并', () => {
    const { store } = setup();
    seed(store, { id: 'a', content: '用户喜欢清淡口味' });
    seed(store, { id: 'b', content: 'Python 装在 D 盘' });
    expect(findMergeCandidates(store)).toHaveLength(0);
  });

  it('类型不同的不合并（偏好与事实是两回事）', () => {
    const { store } = setup();
    seed(store, { id: 'a', content: '用户喜欢清淡口味的菜', kind: 'preference' });
    seed(store, { id: 'b', content: '用户喜欢清淡口味的菜', kind: 'fact' });
    expect(findMergeCandidates(store)).toHaveLength(0);
  });

  it('不同仆人的领域记忆不合并', () => {
    const { store } = setup();
    seed(store, { id: 'a', content: '用户喜欢清淡口味', memClass: 'domain', domainOwner: 'life' });
    seed(store, { id: 'b', content: '用户喜欢清淡口味', memClass: 'domain', domainOwner: 'health' });
    expect(findMergeCandidates(store)).toHaveLength(0);
  });

  it('同仆人的领域记忆可以合并', () => {
    const { store } = setup();
    seed(store, { id: 'a', content: '用户喜欢清淡口味的菜', memClass: 'domain', domainOwner: 'life' });
    seed(store, { id: 'b', content: '用户喜欢清淡口味的菜，不爱油腻', memClass: 'domain', domainOwner: 'life' });
    expect(findMergeCandidates(store).length).toBeGreaterThan(0);
  });

  it('★ 条件不同的原则不合并（套用场景不同）', () => {
    const { store } = setup();
    seed(store, {
      id: 'p1',
      content: '推荐餐厅前先确认同行人忌口',
      kind: 'principle',
      principle: { condition: '推荐餐厅或安排聚餐时', action: '先问清忌口' },
    });
    seed(store, {
      id: 'p2',
      content: '推荐餐厅前先确认同行人忌口',
      kind: 'principle',
      principle: { condition: '提交代码前跑测试时', action: '先问清忌口' },
    });
    expect(findMergeCandidates(store)).toHaveLength(0);
  });

  it('一条不会被重复合并进多组', () => {
    const { store } = setup();
    seed(store, { id: 'a', content: '用户喜欢清淡口味的菜' });
    seed(store, { id: 'b', content: '用户喜欢清淡口味的菜，不爱油腻' });
    seed(store, { id: 'c', content: '用户喜欢清淡口味的菜，不喜重口' });

    const c = findMergeCandidates(store);
    const used = c.flatMap((x) => [x.keep.id, x.absorb.id]);
    expect(new Set(used).size).toBe(used.length);
  });

  it('★ 中间相似度只给建议，不自动合并', () => {
    const { store } = setup();
    // 相似但不完全等同 —— 实测相似度约 0.63，落在「建议」区间
    // （0.72 以上自动合并，0.55—0.72 交用户判断，0.55 以下忽略）
    seed(store, { id: 'a', content: '用户喜欢清淡口味的家常菜' });
    seed(store, { id: 'b', content: '用户喜欢清淡口味，不吃辣' });

    const auto = findMergeCandidates(store);
    const suggest = findMergeSuggestions(store);

    // ★ 两条互斥：自动合并区的不再进入建议列表（否则用户会被重复打扰）
    expect(auto).toHaveLength(0);
    expect(suggest.length).toBeGreaterThan(0);
    expect(suggest[0]!.reason).toContain('交给你判断');
    expect(suggest[0]!.similarity).toBeGreaterThanOrEqual(MERGE_SUGGEST_FLOOR);
    expect(suggest[0]!.similarity).toBeLessThan(MERGE_SIMILARITY);
  });
});

// ═══════════════════════════════════════════════════════════
// ③ ★ 执行合并的三条纪律
// ═══════════════════════════════════════════════════════════

describe('③ ★ 合并执行', () => {
  const twoSimilar = (store: MemoryStore): { keepId: string; absorbId: string } => {
    const keepId = seed(store, {
      id: 'keep',
      content: '用户喜欢清淡口味的菜，不爱油腻',
      evidence: ['e1', 'e2', 'e3'],
      confidence: 0.9,
    });
    const absorbId = seed(store, {
      id: 'absorb',
      content: '用户喜欢清淡口味的菜',
      evidence: ['e4'],
      confidence: 0.7,
    });
    return { keepId, absorbId };
  };

  it('★ 产生新条目并记录 mergedFrom（可追溯）', () => {
    const { store, log, clock } = setup();
    const { keepId, absorbId } = twoSimilar(store);

    const c = findMergeCandidates(store)[0];
    if (!c) throw new Error('no candidate');
    const r = mergeMemories({ log, store, clock, candidate: c });
    if (!r) throw new Error('merge failed');

    // 新条目带 mergedFrom
    const merged = store.get(r.merged.id);
    expect(merged?.mergedFrom).toEqual(expect.arrayContaining([keepId, absorbId]));
  });

  it('★ 旧条目归档而非删除（淘汰 ≠ 删除，同一立场）', () => {
    const { store, log, clock } = setup();
    const { keepId, absorbId } = twoSimilar(store);

    const c = findMergeCandidates(store)[0];
    if (!c) throw new Error('no candidate');
    mergeMemories({ log, store, clock, candidate: c });

    // 两条旧条目都还在，只是归档了
    expect(store.get(keepId)?.lifecycle).toBe('archived');
    expect(store.get(absorbId)?.lifecycle).toBe('archived');
    expect(store.get(keepId)?.content).toContain('清淡');
    expect(store.get(absorbId)?.content).toContain('清淡');
  });

  it('★ 证据链累加去重', () => {
    const { store, log, clock } = setup();
    twoSimilar(store);

    const c = findMergeCandidates(store)[0];
    if (!c) throw new Error('no candidate');
    const r = mergeMemories({ log, store, clock, candidate: c });
    if (!r) throw new Error('merge failed');

    // e1..e4 都在（e1-e3 来自 keep，e4 来自 absorb）
    expect(r.merged.evidence).toEqual(expect.arrayContaining(['e1', 'e2', 'e3', 'e4']));
    expect(r.evidenceCount).toBe(4);
  });

  it('证据重复时不叠加', () => {
    const { store, log, clock } = setup();
    seed(store, { id: 'a', content: '用户喜欢清淡口味的菜', evidence: ['same'] });
    seed(store, { id: 'b', content: '用户喜欢清淡口味的菜，不爱油腻', evidence: ['same'] });

    const c = findMergeCandidates(store)[0];
    if (!c) throw new Error('no candidate');
    const r = mergeMemories({ log, store, clock, candidate: c });
    if (!r) throw new Error('merge failed');

    expect(r.merged.evidence).toEqual(['same']);
  });

  it('★ 适应度按证据数加权（证据多的更有发言权）', () => {
    const { store, log, clock } = setup();
    seed(store, { id: 'a', content: '用户喜欢清淡口味的菜，不爱油腻', evidence: ['1', '2', '3', '4'] });
    seed(store, { id: 'b', content: '用户喜欢清淡口味的菜', evidence: ['5'] });
    store.setFitness('a', 0.8);
    store.setFitness('b', 0.2);

    const c = findMergeCandidates(store)[0];
    if (!c) throw new Error('no candidate');
    const r = mergeMemories({ log, store, clock, candidate: c });
    if (!r) throw new Error('merge failed');

    // 加权：(0.8*4 + 0.2*1)/5 = 0.68，而不是简单平均 0.5
    expect(r.fitnessAfter).toBeCloseTo(0.68, 2);
  });

  it('★ 效果跟踪累加（applied / succeeded 相加）', () => {
    const { store, log, clock } = setup();
    seed(store, { id: 'a', content: '推荐餐厅前确认忌口', kind: 'principle', principle: { condition: '推荐餐厅时', action: '确认忌口' } });
    seed(store, { id: 'b', content: '推荐餐厅前确认同行忌口', kind: 'principle', principle: { condition: '推荐餐厅时', action: '确认忌口' } });
    store.setEffectiveness('a', { applied: 5, succeeded: 4, lastAppliedAt: T0 });
    store.setEffectiveness('b', { applied: 3, succeeded: 3, lastAppliedAt: T0 + 100 });

    const c = findMergeCandidates(store)[0];
    if (!c) throw new Error('no candidate');
    const r = mergeMemories({ log, store, clock, candidate: c });
    if (!r) throw new Error('merge failed');

    const eff = store.get(r.merged.id)?.effectiveness;
    expect(eff?.applied).toBe(8);
    expect(eff?.succeeded).toBe(7);
    expect(eff?.lastAppliedAt).toBe(T0 + 100);
  });

  it('★ 原则的条件与动作被继承（否则合并后无法被注入）', () => {
    const { store, log, clock } = setup();
    seed(store, {
      id: 'a',
      content: '推荐餐厅前确认同行忌口',
      kind: 'principle',
      principle: { condition: '推荐餐厅时', action: '先问清忌口' },
    });
    seed(store, { id: 'b', content: '推荐餐厅前确认同行忌口，尤其素食者', kind: 'principle' });

    const c = findMergeCandidates(store)[0];
    if (!c) throw new Error('no candidate');
    const r = mergeMemories({ log, store, clock, candidate: c });
    if (!r) throw new Error('merge failed');

    expect(store.get(r.merged.id)?.principle?.action).toBe('先问清忌口');
  });

  it('落 memory.merged 事件，含来源与原文', () => {
    const { store, log, clock } = setup();
    twoSimilar(store);

    const c = findMergeCandidates(store)[0];
    if (!c) throw new Error('no candidate');
    mergeMemories({ log, store, clock, candidate: c });

    const ev = log.byType('memory.merged');
    expect(ev).toHaveLength(1);
    const p = ev[0]?.payload as Record<string, unknown>;
    expect((p['from'] as string[]).length).toBe(2);
    expect(p['absorbedRetained']).toBe(true);
    expect(String(p['mergedContent'])).toContain('清淡');
  });

  it('★ 绕过扫描直接调用也会被拦住（双保险）', () => {
    const { store, log, clock } = setup();
    seed(store, { id: 'c1', content: '你对花生严重过敏', memClass: 'global_constraint' });
    seed(store, { id: 'c2', content: '你对花生严重过敏', memClass: 'global_constraint' });

    const a = store.get('c1');
    const b = store.get('c2');
    if (!a || !b) throw new Error('missing');

    const r = mergeMemories({
      log,
      store,
      clock,
      candidate: { keep: a, absorb: b, similarity: 1, mergedContent: a.content, reason: '强行' },
    });
    expect(r).toBeNull();
    expect(log.byType('memory.merged')).toHaveLength(0);
  });

  it('★ 合并主体选信息量更大的那条', () => {
    const { store } = setup();
    // 相似度实测 0.867（探针确认），且信息量明显不同
    seed(store, { id: 'small', content: '用户喜欢清淡口味的菜，不爱油腻', evidence: ['1'] });
    seed(store, { id: 'big', content: '用户喜欢清淡口味的菜，不爱油腻，晚餐尤其', evidence: ['1', '2', '3', '4'] });

    const c = findMergeCandidates(store)[0];
    if (!c) throw new Error('no candidate');
    expect(c.keep.id).toBe('big');
  });
});

// ═══════════════════════════════════════════════════════════
// ④ 批量合并
// ═══════════════════════════════════════════════════════════

describe('④ 批量合并', () => {
  it('一次合并多组', () => {
    const { store, log, clock } = setup();
    seed(store, { id: 'a1', content: '用户喜欢清淡口味的菜' });
    seed(store, { id: 'a2', content: '用户喜欢清淡口味的菜，不爱油腻' });
    seed(store, { id: 'b1', content: 'Python 安装在 D 盘目录下' });
    seed(store, { id: 'b2', content: 'Python 安装在 D 盘目录下，版本 3.11' });

    const results = mergeAll({ log, store, clock });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(log.byType('memory.merged').length).toBe(results.length);
  });

  it('无可合并时返回空数组且不报错', () => {
    const { store, log, clock } = setup();
    seed(store, { id: 'a', content: '用户喜欢清淡口味' });
    seed(store, { id: 'b', content: 'Python 装在 D 盘' });
    expect(mergeAll({ log, store, clock })).toHaveLength(0);
  });

  it('合并后记忆总数下降（这正是合并的目的）', () => {
    const { store, log, clock } = setup();
    seed(store, { id: 'a1', content: '用户喜欢清淡口味的菜' });
    seed(store, { id: 'a2', content: '用户喜欢清淡口味的菜，不爱油腻' });
    const before = store.all().filter((m) => m.lifecycle === 'active').length;

    mergeAll({ log, store, clock });

    const after = store.all().filter((m) => m.lifecycle === 'active').length;
    expect(after).toBeLessThan(before);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ 统计
// ═══════════════════════════════════════════════════════════

describe('⑤ 合并统计', () => {
  it('统计合并次数与被吸收条数', () => {
    const { store, log, clock } = setup();
    seed(store, { id: 'a1', content: '用户喜欢清淡口味的菜' });
    seed(store, { id: 'a2', content: '用户喜欢清淡口味的菜，不爱油腻' });
    mergeAll({ log, store, clock });

    const s = mergeStats(log);
    expect(s.count).toBeGreaterThan(0);
    expect(s.absorbed).toBe(s.count * 2);
  });

  it('无合并时统计为零', () => {
    const { log } = setup();
    expect(mergeStats(log)).toEqual({ count: 0, absorbed: 0 });
  });
});

// ═══════════════════════════════════════════════════════════
// ⑥ 确定性
// ═══════════════════════════════════════════════════════════

describe('⑥ 确定性', () => {
  it('同一批记忆产生同一份合并计划（可重放）', () => {
    const build = (): string => {
      const { store } = setup();
      seed(store, { id: 'a1', content: '用户喜欢清淡口味的菜' });
      seed(store, { id: 'a2', content: '用户喜欢清淡口味的菜，不爱油腻' });
      seed(store, { id: 'b1', content: 'Python 安装在 D 盘目录下' });
      return findMergeCandidates(store)
        .map((c) => `${c.keep.id}<-${c.absorb.id}:${c.similarity.toFixed(4)}`)
        .join(',');
    };
    expect(build()).toBe(build());
  });

  it('时间来自 ClockPort', () => {
    const { store, log, clock } = setup();
    seed(store, { id: 'a1', content: '用户喜欢清淡口味的菜' });
    seed(store, { id: 'a2', content: '用户喜欢清淡口味的菜，不爱油腻' });
    const c = findMergeCandidates(store)[0];
    if (!c) throw new Error('no candidate');
    const r = mergeMemories({ log, store, clock, candidate: c });
    expect(r?.merged.createdAt).toBe(clock.now());
  });
});

/** 类型自检。 */
const _t: MemoryEntry | undefined = undefined;
void _t;
