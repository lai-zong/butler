/**
 * 记忆持久化基础测试 —— 分级准入 + 建档事件 + 重放
 *
 * ★ 三组主张：
 *   ① **分级自主**：用户所述的自主生效，AI 推断的待审
 *   ② **建档落事件**：档案里有足够信息重建（这是重放的前提）
 *   ③ ★★ **重放等价**：重放出的状态与真实状态**逐字段一致**
 *      —— 这是"跨重启存活"能成立的验收标准
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../store.js';
import type { MemoryCandidate } from '../../reflection/reflect.js';
import {
  ATTACHMENT_CONFIDENCE_FLOOR,
  OBSERVED_CONFIDENCE_FLOOR,
  admitAutonomously,
  admitBatch,
  decideAdmission,
  inferSource,
  revocationRates,
  revoke,
} from '../admission.js';
import {
  MEMORY_STATE_EVENTS,
  diffStores,
  hydrateStore,
  replayMemory,
} from '../replay.js';
import { snapshotOf } from '../snapshot.js';

const T0 = 1_760_000_000_000;
const USER = 'u_persist';
const butler = { kind: 'butler', userId: USER } as const;

function setup() {
  const log = new EventLog('s_persist');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, USER);
  return { log, clock, store };
}

function candidate(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: 'cand_1',
    kind: 'fact',
    content: '你对花生严重过敏',
    confidence: 0.9,
    evidence: ['用户说：我对花生过敏'],
    scope: { memClass: 'global_shared' },
    rationale: '用户明确陈述',
    layer: 'servant',
    by: 'health',
    createdAt: T0,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════
// ① ★ 分级自主
// ═══════════════════════════════════════════════════════════

describe('① ★ 分级自主 —— 用户所述的自主生效', () => {
  it('★★ 用户明确陈述的事实 → 自主生效', () => {
    const d = decideAdmission({ candidate: candidate(), source: 'userStated' });
    expect(d.admission).toBe('autoApproved');
    expect(d.reason).toContain('转述');
  });

  it('★★ 用户的纠正 → 自主生效（必须立刻，否则下次还错）', () => {
    const d = decideAdmission({ candidate: candidate(), source: 'userCorrected' });
    expect(d.admission).toBe('autoApproved');
    expect(d.reason).toContain('立刻生效');
  });

  it('用户直接指定的记忆 → 自主生效', () => {
    expect(decideAdmission({ candidate: candidate(), source: 'userInstructed' }).admission).toBe(
      'autoApproved',
    );
  });

  it('★★ 高置信度行为观察 → 自主生效', () => {
    const d = decideAdmission({
      candidate: candidate({ confidence: 0.85 }),
      source: 'observed',
    });
    expect(d.admission).toBe('autoApproved');
  });

  it('★ 低置信度行为观察 → 待审（证据不足）', () => {
    const d = decideAdmission({
      candidate: candidate({ confidence: 0.5 }),
      source: 'observed',
    });
    expect(d.admission).toBe('needsReview');
    expect(d.reason).toContain('证据不足');
  });

  it('★ 行为观察的门槛常量符合预期', () => {
    expect(OBSERVED_CONFIDENCE_FLOOR).toBeGreaterThan(0.5);
    expect(OBSERVED_CONFIDENCE_FLOOR).toBeLessThan(0.9);
  });
});

describe('① ★ 分级自主 —— AI 推断的待审', () => {
  it('★★ AI 推断的偏好 → 待审', () => {
    const d = decideAdmission({
      candidate: candidate({ kind: 'preference', content: '你偏好命令行而非图形界面' }),
      source: 'aiInferredPreference',
    });
    expect(d.admission).toBe('needsReview');
    expect(d.reason).toContain('推断');
  });

  it('★★ AI 提炼的原则 → 待审（会改变未来行为方式，风险最高）', () => {
    const d = decideAdmission({
      candidate: candidate({ kind: 'principle', content: '推荐餐厅前先确认忌口' }),
      // 即使来源是"用户所述"，原则也要审
      source: 'userStated',
    });
    expect(d.admission).toBe('needsReview');
    expect(d.reason).toContain('行为方式');
  });

  it('★★ 与既有记忆冲突 → 待审（无论来源多可信）', () => {
    const d = decideAdmission({
      candidate: candidate(),
      source: 'userStated',
      conflictsWith: ['m_existing_1'],
    });
    expect(d.admission).toBe('needsReview');
    expect(d.reason).toContain('价值判断');
  });

  it('★★ 冲突优先于来源判断（顺序很重要）', () => {
    // 原则 + 冲突 → 应当报"冲突"而不是"原则"，因为冲突在第一步
    const d = decideAdmission({
      candidate: candidate({ kind: 'principle' }),
      source: 'userStated',
      conflictsWith: ['x'],
    });
    expect(d.reason).toContain('冲突');
  });

  it('附件解析：置信度够才自主', () => {
    const high = decideAdmission({
      candidate: candidate({ confidence: 0.9 }),
      source: 'parsedFromAttachment',
    });
    const low = decideAdmission({
      candidate: candidate({ confidence: 0.5 }),
      source: 'parsedFromAttachment',
    });
    expect(high.admission).toBe('autoApproved');
    expect(low.admission).toBe('needsReview');
    expect(ATTACHMENT_CONFIDENCE_FLOOR).toBeGreaterThan(OBSERVED_CONFIDENCE_FLOOR);
  });
});

describe('① ★ 安全网③：撤销率提高门槛', () => {
  it('★★ 某类来源历史撤销率高时门槛提高', () => {
    const normal = decideAdmission({
      candidate: candidate({ confidence: 0.75 }),
      source: 'observed',
    });
    expect(normal.admission).toBe('autoApproved');

    const tightened = decideAdmission({
      candidate: candidate({ confidence: 0.75 }),
      source: 'observed',
      revocationRate: 0.5,
    });
    expect(tightened.admission).toBe('needsReview');
    expect(tightened.reason).toContain('历史撤销率');
  });

  it('低撤销率不提高门槛', () => {
    const d = decideAdmission({
      candidate: candidate({ confidence: 0.75 }),
      source: 'observed',
      revocationRate: 0.05,
    });
    expect(d.admission).toBe('autoApproved');
  });
});

// ═══════════════════════════════════════════════════════════
// ② 来源推断
// ═══════════════════════════════════════════════════════════

describe('② 来源推断（兜底路径）', () => {
  it('★ 证据含用户引述 → userStated', () => {
    expect(inferSource(candidate({ evidence: ['用户说：我不吃辣'] }))).toBe('userStated');
  });

  it('★ 证据含纠正字样 → userCorrected', () => {
    expect(inferSource(candidate({ evidence: ['用户纠正：不是这样'] }))).toBe('userCorrected');
  });

  it('证据含活动聚合 → observed', () => {
    expect(inferSource(candidate({ evidence: ['activity 聚合，连续 5 天'] }))).toBe('observed');
  });

  it('证据含收据 → parsedFromAttachment', () => {
    expect(inferSource(candidate({ evidence: ['receipt 解析'] }))).toBe('parsedFromAttachment');
  });

  it('原则 → aiDerivedPrinciple', () => {
    expect(inferSource(candidate({ kind: 'principle' }))).toBe('aiDerivedPrinciple');
  });

  it('★★ 认不出的一律当"AI 推断"（保守方向）', () => {
    // 判错的代价：多让用户看一眼（可接受）
    // 反向判错的代价：AI 静默把用户带偏（不可接受）
    expect(inferSource(candidate({ evidence: ['某个说不清的依据'] }))).toBe('aiInferredPreference');
  });
});

// ═══════════════════════════════════════════════════════════
// ③ 自主生效与撤销
// ═══════════════════════════════════════════════════════════

describe('③ 自主生效必须留痕', () => {
  function seeded() {
    const s = setup();
    const r = s.store.create(butler, {
      id: 'm1',
      memClass: 'global_shared',
      kind: 'fact',
      content: '你对花生严重过敏',
      confidence: 0.9,
      evidence: ['用户说'],
      lifecycle: 'candidate',
    });
    if (!r.ok) throw new Error('建档失败');
    return s;
  }

  it('★ 自主生效后记忆变为 active', () => {
    const { log, store, clock } = seeded();
    const r = admitAutonomously({
      log,
      store,
      clock,
      id: 'm1',
      source: 'userStated',
      reason: '用户所述',
    });
    expect(r).not.toBeNull();
    expect(store.get('m1')?.lifecycle).toBe('active');
  });

  it('★★ 事件里必须标注"这是系统自主决定的"，含来源与理由', () => {
    const { log, store, clock } = seeded();
    admitAutonomously({
      log,
      store,
      clock,
      id: 'm1',
      source: 'userStated',
      reason: '转述用户的话',
    });

    const approved = log.byType('memory.approved');
    expect(approved.length).toBeGreaterThan(0);
    const p = approved[approved.length - 1]?.payload as Record<string, unknown>;
    expect(p['decidedBy']).toBe('system');
    expect(p['source']).toBe('userStated');
    expect(p['sourceLabel']).toBe('用户明确陈述');
    expect(p['reason']).toBe('转述用户的话');
    expect(p['revocable']).toBe(true);
  });

  it('★ 自主生效的事件带状态快照（供重放）', () => {
    const { log, store, clock } = seeded();
    admitAutonomously({ log, store, clock, id: 'm1', source: 'userStated', reason: 'r' });
    const approved = log.byType('memory.approved');
    const p = approved[approved.length - 1]?.payload as Record<string, unknown>;
    expect(p['snapshot']).toBeDefined();
  });

  it('对不存在的记忆返回 null', () => {
    const { log, store, clock } = setup();
    expect(
      admitAutonomously({ log, store, clock, id: 'nope', source: 'userStated', reason: 'r' }),
    ).toBeNull();
  });
});

describe('③ ★ 撤销 = 效果反馈（安全网②）', () => {
  function admitted() {
    const s = setup();
    s.store.create(butler, {
      id: 'm1',
      memClass: 'global_shared',
      kind: 'fact',
      content: '你偏好命令行',
      confidence: 0.9,
      evidence: ['activity 聚合'],
      lifecycle: 'candidate',
    });
    admitAutonomously({
      log: s.log,
      store: s.store,
      clock: s.clock,
      id: 'm1',
      source: 'observed',
      reason: '行为观察',
    });
    return s;
  }

  it('★ 撤销后归档而非删除', () => {
    const { log, store, clock } = admitted();
    expect(revoke({ log, store, clock, id: 'm1', reason: '这不是我的偏好' })).toBe(true);
    expect(store.get('m1')?.lifecycle).toBe('archived');
    // 仍然可查（保留"曾被撤销"这一事实）
    expect(store.get('m1')?.content).toContain('命令行');
  });

  it('★★ 撤销事件带 feedback 标记（供统计撤销率）', () => {
    const { log, store, clock } = admitted();
    revoke({ log, store, clock, id: 'm1', reason: '不对' });

    const rejected = log.byType('memory.rejected');
    const p = rejected[rejected.length - 1]?.payload as Record<string, unknown>;
    expect(p['feedback']).toBe('revokedByUser');
    expect(p['note']).toContain('门槛将提高');
  });

  it('对不存在的记忆撤销返回 false', () => {
    const { log, store, clock } = setup();
    expect(revoke({ log, store, clock, id: 'nope', reason: 'x' })).toBe(false);
  });
});

describe('③ 撤销率统计', () => {
  it('★ 只统计自主生效过的（人工拒绝不算系统判断错）', () => {
    const s = setup();
    // 两条自主生效
    for (const id of ['m1', 'm2']) {
      s.store.create(butler, {
        id,
        memClass: 'global_shared',
        kind: 'fact',
        content: `观察 ${id}`,
        confidence: 0.9,
        evidence: ['activity'],
        lifecycle: 'candidate',
      });
      admitAutonomously({
        log: s.log,
        store: s.store,
        clock: s.clock,
        id,
        source: 'observed',
        reason: 'r',
      });
    }
    // 一条人工审核通过（decidedBy 不是 system）
    s.store.create(butler, {
      id: 'm3',
      memClass: 'global_shared',
      kind: 'fact',
      content: '人工通过的',
      confidence: 0.9,
      evidence: [],
      lifecycle: 'candidate',
    });
    s.store.review(butler, 'm3', 'approve');

    // 撤销其中一条自主生效的
    revoke({ log: s.log, store: s.store, clock: s.clock, id: 'm1', reason: 'x' });

    const rates = revocationRates(s.log);
    expect(rates.observed).toBeCloseTo(0.5, 5); // 1/2
  });

  it('没有自主生效记录时撤销率为 0', () => {
    const { log } = setup();
    expect(revocationRates(log).observed ?? 0).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// ④ 批量准入
// ═══════════════════════════════════════════════════════════

describe('④ 批量准入', () => {
  it('★ 自主生效与待审分开返回', () => {
    const { log, store, clock } = setup();
    const entries = [
      { id: 'e1', cand: candidate({ id: 'c1', evidence: ['用户说：我不吃辣'] }) },
      { id: 'e2', cand: candidate({ id: 'c2', evidence: ['某个说不清的依据'] }) },
    ];

    const created = entries.map(({ id, cand }) => {
      const r = store.create(butler, {
        id,
        memClass: 'global_shared',
        kind: cand.kind,
        content: cand.content,
        confidence: cand.confidence,
        evidence: cand.evidence,
        lifecycle: 'candidate',
      });
      if (!r.ok) throw new Error('建档失败');
      return { entry: r.entry, candidate: cand };
    });

    const result = admitBatch({ log, store, clock, entries: created });
    expect(result.autoApproved).toHaveLength(1);
    expect(result.pendingReview).toHaveLength(1);
    expect(result.autoApproved[0]?.entry.lifecycle).toBe('active');
    expect(store.get('e2')?.lifecycle).toBe('candidate');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ ★★ 建档落事件（重放的前提）
// ═══════════════════════════════════════════════════════════

describe('⑤ ★★ 建档必须落"可重建"的事件', () => {
  it('★★ 建档落 memory.created 且带完整 entry', () => {
    const { log, store } = setup();
    store.create(butler, {
      id: 'm1',
      memClass: 'global_shared',
      kind: 'fact',
      content: '你对花生过敏',
      confidence: 0.9,
      evidence: ['e1'],
      lifecycle: 'active',
    });

    const created = log.byType('memory.created');
    expect(created).toHaveLength(1);
    const entry = (created[0]?.payload as { entry?: Record<string, unknown> }).entry;
    expect(entry).toBeDefined();
    // ★ 重建所需的字段都在
    for (const f of ['id', 'memClass', 'kind', 'content', 'confidence', 'fitness', 'lifecycle', 'createdAt', 'version']) {
      expect(entry?.[f], `entry 缺字段 ${f}`).toBeDefined();
    }
  });

  it('★ 语义事件（candidate/approved）与状态事件（created）并存', () => {
    const { log, store } = setup();
    store.create(butler, {
      id: 'm1', memClass: 'global_shared', kind: 'fact',
      content: 'x', confidence: 0.9, evidence: [], lifecycle: 'candidate',
    });

    // 语义事件回答"这条记忆是怎么来的"
    expect(log.byType('memory.candidate')).toHaveLength(1);
    // 状态事件供重放
    expect(log.byType('memory.created')).toHaveLength(1);
  });

  it('❌ 旧格式的语义事件不足以重建（如实记为跳过）', () => {
    const { log } = setup();
    // 手工造一条缺 entry 的老事件
    log.append({
      type: 'memory.created',
      actor: 'butler',
      payload: { memoryId: 'm_old', content: 'x' },
      createdAt: T0,
    });

    const r = replayMemory(log.all());
    expect(r.entries).toHaveLength(0);
    expect(r.skippedEvents).toHaveLength(1);
    expect(r.skippedEvents[0]?.why).toContain('没有 entry 字段');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑥ ★★ 重放等价（核心验收标准）
// ═══════════════════════════════════════════════════════════

describe('⑥ ★★ 重放等价 —— 跨重启存活的标准', () => {
  function buildRealisticStore() {
    const s = setup();

    // 三种类别、三种生命周期
    s.store.create(butler, {
      id: 'm_fact', memClass: 'global_shared', kind: 'fact',
      content: '你住在杭州', confidence: 0.9, evidence: ['e1', 'e2'], lifecycle: 'active',
    });
    s.store.create(butler, {
      id: 'm_constraint', memClass: 'global_constraint', kind: 'fact',
      content: '你对花生严重过敏', confidence: 0.95, evidence: ['e3'], lifecycle: 'active',
    });
    s.store.create(butler, {
      id: 'm_domain', memClass: 'domain', kind: 'preference',
      content: '你偏好清淡口味', confidence: 0.8, evidence: ['e4'],
      lifecycle: 'active', domainOwner: 'life',
    });
    s.store.create(butler, {
      id: 'm_principle', memClass: 'global_shared', kind: 'principle',
      content: '推荐餐厅前先确认忌口', confidence: 0.85, evidence: ['e5'], lifecycle: 'active',
    });
    s.store.setPrincipleDetail('m_principle', {
      condition: '推荐餐厅或安排聚餐时',
      action: '先问清同行人忌口',
    });
    s.store.setEffectiveness('m_principle', { applied: 7, succeeded: 6, lastAppliedAt: T0 });

    // 走一些状态变更：审核、适应度、生命周期
    s.store.create(butler, {
      id: 'm_cand', memClass: 'global_shared', kind: 'preference',
      content: '你偏好命令行', confidence: 0.6, evidence: ['e6'], lifecycle: 'candidate',
    });
    s.store.review(butler, 'm_cand', 'approve');

    s.log.append({
      type: 'fitness.updated', actor: 'system',
      payload: {
        memoryId: 'm_fact',
        snapshot: snapshotOf({
          ...s.store.get('m_fact')!,
          fitness: 0.77,
          hitCount: 3,
          lastHitAt: T0 + 5000,
        }),
      },
      createdAt: T0 + 5000,
    });
    s.store.setFitness('m_fact', 0.77);

    s.log.append({
      type: 'memory.dormant', actor: 'system',
      payload: {
        memoryId: 'm_domain',
        reason: '60 天未命中',
        snapshot: snapshotOf({
          ...s.store.get('m_domain')!,
          lifecycle: 'dormant',
          dormantSince: T0 + 60 * 24 * 3600 * 1000,
        }),
      },
      createdAt: T0 + 60 * 24 * 3600 * 1000,
    });
    s.store.setLifecycle('m_domain', 'dormant', { dormantSince: T0 + 60 * 24 * 3600 * 1000 });

    return s;
  }

  it('★★★ 重放出的状态与真实状态逐字段一致', () => {
    const { log, store } = buildRealisticStore();
    const before = store.all();

    const replayed = replayMemory(log.all());
    const fresh = new MemoryStore(log, new FixedClock(T0), USER);
    const hydrate = hydrateStore({ store: fresh, result: replayed });

    expect(hydrate.ok).toBe(true);
    expect(hydrate.hydrated).toBe(before.length);

    const diff = diffStores(before, fresh.all());
    expect(diff.onlyInA).toEqual([]);
    expect(diff.onlyInB).toEqual([]);
    expect(
      diff.differing,
      `差异字段：${JSON.stringify(diff.differing)}`,
    ).toEqual([]);
    expect(diff.identical).toBe(true);
  });

  it('★ 记忆条数一致（"重启后记忆还在"最直白的验证）', () => {
    const { log, store } = buildRealisticStore();
    const replayed = replayMemory(log.all());
    expect(replayed.entries).toHaveLength(store.all().length);
  });

  it('★ 原则的条件与动作被恢复（否则合并后无法被注入）', () => {
    const { log } = buildRealisticStore();
    const replayed = replayMemory(log.all());
    const p = replayed.entries.find((e) => e.id === 'm_principle');
    expect(p?.principle?.condition).toBe('推荐餐厅或安排聚餐时');
    expect(p?.principle?.action).toBe('先问清同行人忌口');
  });

  it('★ 效果跟踪被恢复（"这条原则用了 7 次"重启后还在）', () => {
    const { log } = buildRealisticStore();
    const replayed = replayMemory(log.all());
    const p = replayed.entries.find((e) => e.id === 'm_principle');
    expect(p?.effectiveness?.applied).toBe(7);
    expect(p?.effectiveness?.succeeded).toBe(6);
  });

  it('★ 生命周期状态被恢复（休眠的还在休眠）', () => {
    const { log } = buildRealisticStore();
    const replayed = replayMemory(log.all());
    const m = replayed.entries.find((e) => e.id === 'm_domain');
    expect(m?.lifecycle).toBe('dormant');
    expect(m?.dormantSince).toBe(T0 + 60 * 24 * 3600 * 1000);
  });

  it('★ 适应度被恢复（不重算 —— 重放是恢复，不是重新演化）', () => {
    const { log } = buildRealisticStore();
    const replayed = replayMemory(log.all());
    expect(replayed.entries.find((e) => e.id === 'm_fact')?.fitness).toBe(0.77);
  });

  it('★ 领域归属被恢复（生活仆人的记忆不会跑到健康仆人名下）', () => {
    const { log } = buildRealisticStore();
    const replayed = replayMemory(log.all());
    const d = replayed.entries.find((e) => e.id === 'm_domain');
    expect(d?.memClass).toBe('domain');
    expect(d?.owner.kind === 'servant' ? d.owner.servant : null).toBe('life');
  });

  /**
   * ★★ 这条测试是补一个**真实发生过的静默缺口**。
   *
   *   A1 给 `MemoryEntry` 加了 `domain` 字段，但**忘了同步**：
   *     · `snapshot.ts` 的 `snapshotOf`
   *     · `replay.ts` 的字段重建
   *
   *   症状完全符合 `snapshot.ts` 文件开头的警告：
   *   「漏加的后果不是报错，而是**重放后字段悄悄丢失**」
   *   而当时**没有任何测试依赖"重启后 domain 还在"**，所以测试全绿。
   *
   *   ★ 教训：给持久化实体加字段 = 改 snapshot + 改 replay + **加这条测试**，
   *     三件事缺一不可。缺了测试，缺口就是静默的。
   */
  it('★★ 领域标签 domain 重启后仍在（A1 曾漏加 snapshot/replay）', () => {
    const { log } = buildRealisticStore();
    const replayed = replayMemory(log.all());
    const d = replayed.entries.find((e) => e.id === 'm_domain');
    expect(d?.domain).toBe('life');
  });

  it('★ 全局硬约束被恢复（安全约束绝不能丢）', () => {
    const { log } = buildRealisticStore();
    const replayed = replayMemory(log.all());
    const c = replayed.entries.find((e) => e.id === 'm_constraint');
    expect(c?.memClass).toBe('global_constraint');
    expect(c?.content).toContain('花生');
  });

  it('★★ 重放是幂等的（重放两次结果相同）', () => {
    const { log } = buildRealisticStore();
    const a = replayMemory(log.all());
    const b = replayMemory(log.all());
    expect(diffStores(a.entries, b.entries).identical).toBe(true);
  });

  it('★★ 重放不产生新事件（否则事件流会被污染、下次翻倍）', () => {
    const { log, store } = buildRealisticStore();
    const beforeCount = log.length;

    const replayed = replayMemory(log.all());
    const fresh = new MemoryStore(log, new FixedClock(T0), USER);
    hydrateStore({ store: fresh, result: replayed });

    expect(log.length).toBe(beforeCount);
    void store;
  });

  it('★ 拒绝注入到非空 store（避免状态混在一起）', () => {
    const { log, store } = buildRealisticStore();
    const replayed = replayMemory(log.all());
    const r = hydrateStore({ store, result: replayed });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('非空');
  });

  it('★ 空事件流重放出空状态', () => {
    const r = replayMemory([]);
    expect(r.entries).toHaveLength(0);
    expect(r.consumedEvents).toBe(0);
  });

  it('★ 与记忆无关的事件被跳过', () => {
    const s = setup();
    s.log.append({ type: 'route.decided', actor: 'butler', payload: {}, createdAt: T0 });
    const r = replayMemory(s.log.all());
    expect(r.consumedEvents).toBe(0);
  });

  it('MEMORY_STATE_EVENTS 覆盖了所有改状态的事件', () => {
    // 这条是**维护提醒**：新增状态事件时要加进来，否则重放会漏
    expect(MEMORY_STATE_EVENTS).toContain('memory.created');
    expect(MEMORY_STATE_EVENTS).toContain('memory.approved');
    expect(MEMORY_STATE_EVENTS).toContain('memory.dormant');
    expect(MEMORY_STATE_EVENTS).toContain('fitness.updated');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑦ 差异比较本身
// ═══════════════════════════════════════════════════════════

describe('⑦ diffStores 的比较能力', () => {
  function entry(id: string, content: string) {
    return { id, content } as never;
  }

  it('★ 能查出缺条', () => {
    const d = diffStores([entry('a', 'x')], []);
    expect(d.onlyInA).toEqual(['a']);
    expect(d.identical).toBe(false);
  });

  it('★ 能查出多条', () => {
    const d = diffStores([], [entry('a', 'x')]);
    expect(d.onlyInB).toEqual(['a']);
  });

  it('★ 能查出字段差异并列出字段名', () => {
    const a = [{ id: 'a', content: 'x', fitness: 0.5 }] as never;
    const b = [{ id: 'a', content: 'x', fitness: 0.9 }] as never;
    const d = diffStores(a, b);
    expect(d.differing).toHaveLength(1);
    expect(d.differing[0]?.fields).toContain('fitness');
  });

  it('null 与 undefined 视为相同（避免假差异）', () => {
    const a = [{ id: 'a', content: 'x', subject: null }] as never;
    const b = [{ id: 'a', content: 'x' }] as never;
    expect(diffStores(a, b).identical).toBe(true);
  });
});
