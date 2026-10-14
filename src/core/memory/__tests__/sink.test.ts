/**
 * 候选落库测试
 *
 * 两个关键性质：
 *   ① 反思产出**一律先落 candidate**，绝不直接生效
 *      —— 反思是模型生成的，可能错；候选必须经用户审核才进召回池
 *   ② **去重必须覆盖全生命周期**（含归档）
 *      —— 否则用户要反复拒绝同一件事
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { MemoryCandidate } from '../../reflection/reflect.js';
import { MemoryStore } from '../store.js';
import { isDuplicate, similarity, sinkCandidates } from '../sink.js';

const T0 = 1_760_000_000_000;
const USER = 'u_sink';

function setup() {
  const log = new EventLog('s_sink');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, USER);
  return { log, clock, store };
}

function cand(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: 'c1',
    kind: 'preference',
    content: '用户偏好清淡口味的家常菜',
    confidence: 0.65,
    evidence: ['用户三次提到想吃清淡的'],
    scope: { memClass: 'domain', domainOwner: 'life' },
    rationale: '本次会话反复出现',
    layer: 'servant',
    by: 'life',
    createdAt: T0,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════
// 落库行为
// ═══════════════════════════════════════════════════════════

describe('sinkCandidates · 落库', () => {
  it('★ 反思产出落为 candidate，不直接生效', () => {
    const { log, store, clock } = setup();
    const r = sinkCandidates({ log, store, clock }, [cand()]);

    expect(r.created).toHaveLength(1);
    expect(r.created[0]?.lifecycle).toBe('candidate');
    expect(store.size()).toBe(1);
  });

  it('候选不参与召回（要等用户审核）', () => {
    const { log, store, clock } = setup();
    sinkCandidates({ log, store, clock }, [cand()]);

    const stored = store.all()[0];
    expect(stored?.lifecycle).toBe('candidate');
    // visibleTo 可以看到候选（用户要审核），但 recall 会跳过它 —— 见 recall 测试
    expect(store.visibleTo({ kind: 'user', userId: USER })).toHaveLength(1);
  });

  it('领域候选归属到指定仆人', () => {
    const { log, store, clock } = setup();
    const r = sinkCandidates({ log, store, clock }, [cand({ scope: { memClass: 'domain', domainOwner: 'health' } })]);

    const e = r.created[0];
    expect(e?.owner.kind).toBe('servant');
    if (e?.owner.kind === 'servant') expect(e.owner.servant).toBe('health');
  });

  it('管家层候选进全局共享层，归属管家', () => {
    const { log, store, clock } = setup();
    const r = sinkCandidates({ log, store, clock }, [
      cand({
        layer: 'butler',
        by: 'butler',
        scope: { memClass: 'global_shared' },
        kind: 'principle',
        content: '涉及时间安排时先确认是工作日还是周末',
      }),
    ]);

    expect(r.created[0]?.memClass).toBe('global_shared');
    expect(r.created[0]?.owner.kind).toBe('butler');
  });

  it('反思来源元信息落事件（用户要看得到"为什么这么认为"）', () => {
    const { log, store, clock } = setup();
    sinkCandidates({ log, store, clock }, [cand({ rationale: '因为用户三次提到' })]);

    // 候选创建事件只该有一条 —— 由 store.create 负责发。
    // sink 若重复发，审计视图看起来会像"建了两条记忆"。
    expect(log.byType('memory.candidate')).toHaveLength(1);

    // 反思来源的附加元信息走单独事件
    const derived = log.byType('principle.derived');
    expect(derived).toHaveLength(1);
    expect(derived[0]?.payload).toMatchObject({
      fromReflection: 'servant',
      reflectedBy: 'life',
      rationale: '因为用户三次提到',
      domainOwner: 'life',
    });
  });

  it('领域候选缺归属时被拒，且不静默丢弃', () => {
    const { log, store, clock } = setup();
    const r = sinkCandidates({ log, store, clock }, [
      cand({ scope: { memClass: 'domain' } }), // 没有 domainOwner
    ]);

    expect(r.created).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.reason).toContain('建档被拒');
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 去重
// ═══════════════════════════════════════════════════════════

describe('★ 去重 · 防止候选灌满记忆库', () => {
  it('完全相同的候选被跳过', () => {
    const { log, store, clock } = setup();
    sinkCandidates({ log, store, clock }, [cand()]);
    const r2 = sinkCandidates({ log, store, clock }, [cand({ id: 'c2' })]);

    expect(r2.created).toHaveLength(0);
    expect(r2.skipped).toHaveLength(1);
    expect(store.size()).toBe(1);
  });

  it('措辞略有不同的同一件事也被判重', () => {
    const { log, store, clock } = setup();
    sinkCandidates({ log, store, clock }, [cand({ content: '用户偏好清淡口味的家常菜' })]);
    const r2 = sinkCandidates({ log, store, clock }, [
      cand({ id: 'c2', content: '用户偏好清淡口味的家常菜。' }), // 只多一个句号
    ]);
    expect(r2.created).toHaveLength(0);
  });

  it('★ 已归档的候选也参与去重（否则用户要反复拒绝同一件事）', () => {
    const { log, store, clock } = setup();
    const first = sinkCandidates({ log, store, clock }, [cand()]);
    const id = first.created[0]?.id;
    if (!id) throw new Error('setup failed');

    // 用户拒绝了它 → 归档
    store.review({ kind: 'user', userId: USER }, id, 'reject', '不是这样');
    expect(store.get(id)?.lifecycle).toBe('archived');

    // 下次反思又提出来同一条
    const r2 = sinkCandidates({ log, store, clock }, [cand({ id: 'c3' })]);
    expect(r2.created).toHaveLength(0);
    expect(r2.skipped[0]?.duplicateOf).toBe(id);
  });

  it('不同领域的内容不算重复（即便文字相近）', () => {
    const { log, store, clock } = setup();
    sinkCandidates({ log, store, clock }, [cand({ scope: { memClass: 'domain', domainOwner: 'life' } })]);
    const r2 = sinkCandidates({ log, store, clock }, [
      cand({ id: 'c2', scope: { memClass: 'domain', domainOwner: 'health' } }),
    ]);
    expect(r2.created).toHaveLength(1);
  });

  it('领域 vs 全局层不算重复（层级不同，语义不同）', () => {
    const { log, store, clock } = setup();
    sinkCandidates({ log, store, clock }, [cand()]);
    const r2 = sinkCandidates({ log, store, clock }, [
      cand({ id: 'c2', scope: { memClass: 'global_shared' } }),
    ]);
    expect(r2.created).toHaveLength(1);
  });

  it('同一批内的重复也被去掉', () => {
    const { log, store, clock } = setup();
    const r = sinkCandidates({ log, store, clock }, [
      cand({ id: 'a', content: '用户偏好清淡口味的家常菜' }),
      cand({ id: 'b', content: '用户偏好清淡口味的家常菜' }),
    ]);
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
  });

  it('真正不同的候选都会入库', () => {
    const { log, store, clock } = setup();
    const r = sinkCandidates({ log, store, clock }, [
      cand({ id: 'a', content: '用户偏好清淡口味的家常菜' }),
      cand({ id: 'b', kind: 'principle', content: '推荐餐厅前先确认同行人忌口' }),
    ]);
    expect(r.created).toHaveLength(2);
  });
});

describe('★ 原则落库时携带条件与动作', () => {
  it('候选带 principle 时写入仓储（注入与违背检测都依赖它）', () => {
    const { log, store, clock } = setup();
    const r = sinkCandidates({ log, store, clock }, [
      cand({
        kind: 'principle',
        content: '推荐餐厅前先确认同行人忌口',
        principle: {
          condition: '推荐餐厅或安排聚餐时',
          action: '先问清同行人的饮食禁忌再给方案',
        },
      }),
    ]);

    const id = r.created[0]?.id;
    if (!id) throw new Error('未落库');
    const stored = store.get(id);
    expect(stored?.principle?.condition).toBe('推荐餐厅或安排聚餐时');
    expect(stored?.principle?.action).toBe('先问清同行人的饮食禁忌再给方案');
  });

  it('候选不带 principle 时字段留空（不伪造）', () => {
    const { log, store, clock } = setup();
    const r = sinkCandidates({ log, store, clock }, [
      cand({ kind: 'principle', content: '某条没给条件的原则' }),
    ]);
    const id = r.created[0]?.id;
    if (!id) throw new Error('未落库');
    expect(store.get(id)?.principle).toBeUndefined();
  });

  it('反思来源事件里标注是否带结构化详情', () => {
    const { log, store, clock } = setup();
    // ⚠️ 两条内容必须**明显不同** —— 否则会被去重跳过（去重覆盖全生命周期）
    sinkCandidates({ log, store, clock }, [
      cand({
        kind: 'principle',
        content: '推荐餐厅前先确认同行人忌口',
        principle: { condition: '推荐餐厅或安排聚餐时', action: '先问清同行人禁忌再给方案' },
      }),
      cand({
        id: 'c2',
        kind: 'principle',
        content: '安排时间前先确认是工作日还是周末',
      }),
    ]);
    const evs = log.byType('principle.derived');
    const flags = evs.map((e) => (e.payload as { hasPrincipleDetail?: boolean }).hasPrincipleDetail);
    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });
});

describe('similarity · 相似度', () => {
  it('完全相同为 1', () => {
    expect(similarity('用户偏好清淡口味', '用户偏好清淡口味')).toBe(1);
  });

  it('标点与空白不影响判定', () => {
    expect(similarity('用户偏好清淡口味', '用户偏好清淡口味。')).toBeGreaterThan(0.9);
  });

  it('完全不同为 0', () => {
    expect(similarity('用户偏好清淡口味', '明天要下雨')).toBe(0);
  });

  it('部分重合介于中间', () => {
    const s = similarity('用户偏好清淡口味的家常菜', '用户喜欢清淡的蒸菜');
    expect(s).toBeGreaterThan(0.2);
    expect(s).toBeLessThan(0.8);
  });

  it('空串边界安全', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity('有内容', '')).toBe(0);
  });
});

describe('isDuplicate · 判定组合', () => {
  it('同类 + 内容相近 → 重复', () => {
    const { store, log, clock } = setup();
    const r = sinkCandidates({ log, store, clock }, [cand()]);
    const existing = r.created[0];
    if (!existing) throw new Error('setup failed');
    expect(isDuplicate(existing, cand())).toBe(true);
  });

  it('内容相差大的不判重', () => {
    const { store, log, clock } = setup();
    const r = sinkCandidates({ log, store, clock }, [cand()]);
    const existing = r.created[0];
    if (!existing) throw new Error('setup failed');
    expect(isDuplicate(existing, cand({ content: '用户打算下个月换工作' }))).toBe(false);
  });
});
