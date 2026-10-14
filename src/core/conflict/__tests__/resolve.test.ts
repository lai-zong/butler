/**
 * 跨领域冲突裁决测试 —— 创新点 ③
 *
 * 三条核心主张需要被锁住：
 *   ① **管家是唯一裁决者** —— 仆人谁也不否决谁（这条由架构保证，这里验证流程）
 *   ② **落败方降权但保留** —— 淘汰 ≠ 删除，同一立场贯穿全项目
 *   ③ **可固化为原则** —— 第一次问用户，同类冲突下次自动裁决
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../../memory/store.js';
import type { ServantId } from '../../servants/types.js';
import {
  applyVerdict,
  buildPrincipleCandidate,
  collectPending,
  conflictIdOf,
  prefersParty,
  toDomainResolution,
  tryAutoVerdict,
  verdictStats,
  type ConflictSide,
  type Verdict,
} from '../resolve.js';

const T0 = 1_760_000_000_000;
const USER = 'u_cf';
const butler = { kind: 'butler', userId: USER } as const;

function setup() {
  const log = new EventLog('s_cf');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, USER);
  return { log, clock, store };
}

/** 冲突双方的立场。 */
function sides(ids: { life?: string; health?: string; work?: string } = {}): ConflictSide[] {
  return [
    {
      servant: 'life',
      claim: '推荐川味火锅（评分 4.8，离家 1 公里）',
      evidence: ['评分高', '距离近'],
      memoryIds: ids.life !== undefined ? [ids.life] : [],
    },
    {
      servant: 'health',
      claim: '火锅高油高盐，与减脂目标冲突',
      evidence: ['单餐钠约 2600mg', '油脂约 60g'],
      memoryIds: ids.health !== undefined ? [ids.health] : [],
    },
    {
      servant: 'work',
      claim: '周六晚更合适',
      evidence: ['周日有早会'],
      memoryIds: ids.work !== undefined ? [ids.work] : [],
    },
  ];
}

const CONFLICT = {
  id: 'cf_001',
  message: '生活仆人推荐火锅，健康仆人指出高油高盐，与减脂目标冲突',
};

// ═══════════════════════════════════════════════════════════
// ① 用户裁决
// ═══════════════════════════════════════════════════════════

describe('① 用户裁决落地', () => {
  it('采纳一方：胜方 succeeded+1，败方降权但保留', () => {
    const { store, log, clock } = setup();
    const lifeMem = store.create(butler, {
      id: 'm_life',
      memClass: 'domain',
      kind: 'preference',
      content: '偏好评分高的餐厅',
      confidence: 0.8,
      evidence: [],
      lifecycle: 'active',
      domainOwner: 'life',
    });
    const healthMem = store.create(butler, {
      id: 'm_health',
      memClass: 'domain',
      kind: 'principle',
      content: '减脂期避免高油高盐',
      confidence: 0.85,
      evidence: [],
      lifecycle: 'active',
      domainOwner: 'health',
    });
    expect(lifeMem.ok && healthMem.ok).toBe(true);

    const beforeLife = store.get('m_life')?.fitness ?? 0;
    const outcome = applyVerdict({
      log,
      store,
      clock,
      conflict: CONFLICT,
      sides: sides({ life: 'm_life', health: 'm_health' }),
      verdict: {
        conflictId: CONFLICT.id,
        winner: 'health',
        decidedBy: 'user',
        reason: '减脂优先',
      },
    });

    // 胜方
    expect(outcome.winners).toEqual(['m_health']);
    expect(store.get('m_health')?.effectiveness?.succeeded).toBe(1);

    // ★ 败方降权但保留
    expect(outcome.losers.map((l) => l.memoryId)).toEqual(['m_life']);
    expect(store.get('m_life')?.fitness).toBeLessThan(beforeLife);
    expect(store.get('m_life')).toBeDefined(); // 没被删
    expect(store.get('m_life')?.content).toBe('偏好评分高的餐厅');
  });

  it('★ 落败方只降权不删除（淘汰 ≠ 删除，同一立场）', () => {
    const { store, log, clock } = setup();
    store.create(butler, {
      id: 'm1',
      memClass: 'domain',
      kind: 'preference',
      content: 'x',
      confidence: 0.8,
      evidence: [],
      lifecycle: 'active',
      domainOwner: 'life',
    });

    applyVerdict({
      log,
      store,
      clock,
      conflict: CONFLICT,
      sides: sides({ life: 'm1' }),
      verdict: { conflictId: CONFLICT.id, winner: 'health', decidedBy: 'user', reason: 'r' },
    });

    expect(store.get('m1')).toBeDefined();
    expect(store.get('m1')?.fitness).toBeGreaterThan(0);
  });

  it('裁决落 conflict.resolved 事件，含双方立场与证据', () => {
    const { store, log, clock } = setup();
    applyVerdict({
      log,
      store,
      clock,
      conflict: CONFLICT,
      sides: sides(),
      verdict: {
        conflictId: CONFLICT.id,
        winner: 'health',
        decidedBy: 'user',
        reason: '减脂优先',
      },
    });

    const ev = log.byType('conflict.resolved');
    expect(ev).toHaveLength(1);
    const payload = ev[0]?.payload as Record<string, unknown>;
    expect(payload['winner']).toBe('health');
    expect(payload['decidedBy']).toBe('user');
    expect(payload['reason']).toBe('减脂优先');
    // 各方的立场与证据一并留痕，便于事后追问"当时为什么这么判"
    const recordedSides = payload['sides'] as { servant: string; claim: string }[];
    expect(recordedSides).toHaveLength(3);
    expect(recordedSides.find((s) => s.servant === 'life')?.claim).toContain('火锅');
  });

  it('用户裁决时 actor=user（可审计"这是人定的，不是AI猜的"）', () => {
    const { store, log, clock } = setup();
    applyVerdict({
      log,
      store,
      clock,
      conflict: CONFLICT,
      sides: sides(),
      verdict: { conflictId: CONFLICT.id, winner: 'health', decidedBy: 'user', reason: 'r' },
    });
    expect(log.byType('conflict.resolved')[0]?.actor).toBe('user');
  });

  it('winner=none（都不采纳）也能处理', () => {
    const { store, log, clock } = setup();
    const outcome = applyVerdict({
      log,
      store,
      clock,
      conflict: CONFLICT,
      sides: sides(),
      verdict: { conflictId: CONFLICT.id, winner: 'none', decidedBy: 'user', reason: '换个方案' },
    });
    expect(outcome.winners).toHaveLength(0);
    expect(log.byType('conflict.resolved')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// ② ★ 固化为原则
// ═══════════════════════════════════════════════════════════

describe('② ★ 固化为原则（第一次问用户，下次自动）', () => {
  it('用户勾选固化时产出**候选**（不是直接生效）', () => {
    const { store, log, clock } = setup();
    const outcome = applyVerdict({
      log,
      store,
      clock,
      conflict: CONFLICT,
      sides: sides(),
      verdict: {
        conflictId: CONFLICT.id,
        winner: 'health',
        decidedBy: 'user',
        reason: '减脂优先',
        makePrinciple: true,
      },
    });

    expect(outcome.principleCandidate).toBeDefined();
    expect(outcome.principleCandidate?.content).toContain('健康');
    expect(outcome.principleCandidate?.content).toContain('生活');
    expect(outcome.principleCandidate?.fromVerdict).toBe(CONFLICT.id);

    // ★ 单次裁决不足以证明它是通用规律 → 必须经审核
    const ev = log.byType('principle.derived');
    expect(ev).toHaveLength(1);
    expect((ev[0]?.payload as { note?: string }).note).toContain('待审核');
    // 记忆库里还没有这条原则
    expect(store.all().filter((m) => m.kind === 'principle')).toHaveLength(0);
  });

  it('未勾选固化时不产出候选', () => {
    const { store, log, clock } = setup();
    const outcome = applyVerdict({
      log,
      store,
      clock,
      conflict: CONFLICT,
      sides: sides(),
      verdict: { conflictId: CONFLICT.id, winner: 'health', decidedBy: 'user', reason: 'r' },
    });
    expect(outcome.principleCandidate).toBeUndefined();
    expect(log.byType('principle.derived')).toHaveLength(0);
  });

  it('★ 固化后的原则能让同类冲突自动裁决', () => {
    const { store, log, clock } = setup();

    // 用户裁决并固化
    const outcome = applyVerdict({
      log,
      store,
      clock,
      conflict: CONFLICT,
      sides: sides(),
      verdict: {
        conflictId: CONFLICT.id,
        winner: 'health',
        decidedBy: 'user',
        reason: '减脂优先',
        makePrinciple: true,
      },
    });
    const cand = outcome.principleCandidate;
    if (!cand) throw new Error('未产出候选');

    // 审核生效（这里直接建档模拟"用户采纳"）
    store.create(butler, {
      id: 'p_auto',
      memClass: 'global_shared',
      kind: 'principle',
      content: cand.content,
      confidence: 0.7,
      evidence: [`verdict:${cand.fromVerdict}`],
      lifecycle: 'active',
    });
    store.setPrincipleDetail('p_auto', { condition: cand.condition, action: cand.action });

    // 同类冲突再现 → 自动裁决
    const auto = tryAutoVerdict({
      store,
      conflict: { message: '生活仆人推荐火锅，健康仆人指出高油高盐，与减脂目标冲突', parties: ['life', 'health'] },
    });

    expect(auto).not.toBeNull();
    expect(auto?.verdict.winner).toBe('health');
    expect(auto?.verdict.decidedBy).toBe('principle');
    expect(auto?.verdict.principleId).toBe('p_auto');
    expect(auto?.verdict.reason).toContain('依据已生效原则');
  });

  it('条件不相关时不套用原则（不能张冠李戴）', () => {
    const { store } = setup();
    store.create(butler, {
      id: 'p_unrelated',
      memClass: 'global_shared',
      kind: 'principle',
      content: '跨领域冲突时，健康类约束优先于生活类偏好',
      confidence: 0.7,
      evidence: [],
      lifecycle: 'active',
    });
    store.setPrincipleDetail('p_unrelated', {
      condition: '提交代码前需要跑测试',
      action: '健康优先于生活',
    });

    const auto = tryAutoVerdict({
      store,
      conflict: { message: '生活推荐火锅 vs 健康要求低油', parties: ['life', 'health'] },
    });
    expect(auto).toBeNull();
  });

  it('原则必须明确偏袒某一方，否则不自动裁决', () => {
    const { store } = setup();
    store.create(butler, {
      id: 'p_vague',
      memClass: 'global_shared',
      kind: 'principle',
      content: '冲突时综合考虑',
      confidence: 0.6,
      evidence: [],
      lifecycle: 'active',
    });
    store.setPrincipleDetail('p_vague', {
      condition: '生活推荐火锅 vs 健康要求低油',
      action: '综合考虑各方面因素再决定',
    });

    const auto = tryAutoVerdict({
      store,
      conflict: { message: '生活推荐火锅 vs 健康要求低油', parties: ['life', 'health'] },
    });
    expect(auto).toBeNull(); // 无法判断偏袒谁 → 交回用户
  });

  it('未生效（候选）的原则不参与自动裁决', () => {
    const { store } = setup();
    store.create(butler, {
      id: 'p_cand',
      memClass: 'global_shared',
      kind: 'principle',
      content: '健康优先于生活',
      confidence: 0.5,
      evidence: [],
      lifecycle: 'candidate',
    });
    store.setPrincipleDetail('p_cand', { condition: '生活与健康冲突时', action: '健康优先' });

    expect(
      tryAutoVerdict({
        store,
        conflict: { message: '生活与健康冲突', parties: ['life', 'health'] },
      }),
    ).toBeNull();
  });

  it('多条原则时效果好的优先采用', () => {
    const { store } = setup();
    for (const [id, applied, succeeded] of [
      ['p_good', 10, 10],
      ['p_bad', 10, 1],
    ] as const) {
      store.create(butler, {
        id,
        memClass: 'global_shared',
        kind: 'principle',
        content: `健康优先于生活（${id}）`,
        confidence: 0.7,
        evidence: [],
        lifecycle: 'active',
      });
      store.setPrincipleDetail(id, {
        condition: '生活与健康建议冲突时',
        action: '健康优先于生活',
      });
      store.setEffectiveness(id, { applied, succeeded, lastAppliedAt: T0 });
    }

    const auto = tryAutoVerdict({
      store,
      conflict: { message: '生活与健康建议冲突', parties: ['life', 'health'] },
    });
    expect(auto?.verdict.principleId).toBe('p_good');
  });

  it('固化措辞泛化到"同类冲突"，不记住这一次的具体内容', () => {
    const cand = buildPrincipleCandidate(
      CONFLICT,
      sides(),
      { conflictId: CONFLICT.id, winner: 'health', decidedBy: 'user', reason: 'r' },
    );
    // 泛化措辞：说的是"类约束/类偏好"，不是"火锅"
    expect(cand.content).toContain('类约束');
    expect(cand.content).toContain('类偏好');
    expect(cand.content).not.toContain('火锅');
  });
});

// ═══════════════════════════════════════════════════════════
// ③ 冲突收集（界面用）
// ═══════════════════════════════════════════════════════════

describe('③ 待裁决项收集', () => {
  it('无可用原则时列出选项让用户选', () => {
    const { store } = setup();
    const pending = collectPending({
      store,
      conflicts: [
        { id: 'cf_1', message: CONFLICT.message, severity: 'warn', parties: ['life', 'health'] },
      ],
      sides: sides(),
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.autoVerdict).toBeNull();
    expect(pending[0]?.options.map((o) => o.servant)).toEqual(['life', 'health']);
  });

  it('命中原则时带上自动裁决结果（界面可直接展示依据）', () => {
    const { store } = setup();
    store.create(butler, {
      id: 'p1',
      memClass: 'global_shared',
      kind: 'principle',
      content: '跨领域冲突时，健康类约束优先于生活类偏好',
      confidence: 0.8,
      evidence: [],
      lifecycle: 'active',
    });
    store.setPrincipleDetail('p1', {
      condition: '生活与健康建议冲突时',
      action: '健康优先于生活',
    });

    const pending = collectPending({
      store,
      conflicts: [
        { id: 'cf_1', message: '生活与健康建议冲突', severity: 'warn', parties: ['life', 'health'] },
      ],
      sides: sides(),
    });

    expect(pending[0]?.autoVerdict?.verdict.winner).toBe('health');
    expect(pending[0]?.autoVerdict?.principleContent).toContain('健康');
  });

  it('只保留涉及该冲突的双方立场', () => {
    const { store } = setup();
    const pending = collectPending({
      store,
      conflicts: [
        { id: 'cf_1', message: 'x', severity: 'info', parties: ['life', 'health'] },
      ],
      sides: sides(),
    });
    // work 不在 parties 里，不应出现
    expect(pending[0]?.sides.map((s) => s.servant)).toEqual(['life', 'health']);
  });
});

// ═══════════════════════════════════════════════════════════
// ④ 统计与类型映射
// ═══════════════════════════════════════════════════════════

describe('④ 统计与映射', () => {
  it('汇总裁决次数与来源（界面"这个月自动裁决了几次"）', () => {
    const { store, log, clock } = setup();

    applyVerdict({
      log,
      store,
      clock,
      conflict: { id: 'c1', message: 'm1' },
      sides: sides(),
      verdict: { conflictId: 'c1', winner: 'health', decidedBy: 'user', reason: 'r' },
    });
    applyVerdict({
      log,
      store,
      clock,
      conflict: { id: 'c2', message: 'm2' },
      sides: sides(),
      verdict: {
        conflictId: 'c2',
        winner: 'health',
        decidedBy: 'principle',
        reason: '依据原则',
        principleId: 'p1',
      },
    });

    const s = verdictStats(log);
    expect(s.total).toBe(2);
    expect(s.byUser).toBe(1);
    expect(s.byPrinciple).toBe(1);
  });

  it('冲突 id 从类型与内容生成（稳定可复现）', () => {
    const id1 = conflictIdOf({ kind: 'crossServant', message: '蛋白摄入是否加量' });
    const id2 = conflictIdOf({ kind: 'crossServant', message: '蛋白摄入是否加量' });
    expect(id1).toBe(id2);
    expect(id1).toContain('crossServant');
  });

  it('映射到领域模型', () => {
    const auto = toDomainResolution({
      conflictId: 'c',
      winner: 'health',
      decidedBy: 'principle',
      reason: '依据原则 X',
      principleId: 'p1',
    });
    expect(auto.kind).toBe('autoResolved');

    const ask = toDomainResolution({
      conflictId: 'c',
      winner: 'health',
      decidedBy: 'user',
      reason: 'r',
    });
    expect(ask.kind).toBe('askUser');

    const none = toDomainResolution({
      conflictId: 'c',
      winner: 'none',
      decidedBy: 'user',
      reason: '都不采纳',
    });
    expect(none.kind).toBe('dismissed');
  });
});

describe('⑥ ★ 偏向判定（中文语序）', () => {
  it('「A 优先于 B」判定偏袒 A，且 B 不被误判', () => {
    expect(prefersParty('健康优先于生活', 'health')).toBeGreaterThan(0);
    // ⚠️ 这条是踩过的坑：「优先于」里的「于」曾被字符类 `[于之]` 命中，
    //    导致生活被判成"次于健康"而一起负分。
    expect(prefersParty('健康优先于生活', 'life')).toBe(0);
  });

  it('「采用 A 一方」判定偏袒 A', () => {
    expect(prefersParty('采用健康一方：火锅高油高盐', 'health')).toBeGreaterThan(0);
    expect(prefersParty('采用健康一方：火锅高油高盐', 'life')).toBe(0);
  });

  it('「以 A 为准」判定偏袒 A', () => {
    expect(prefersParty('以健康为准', 'health')).toBeGreaterThan(0);
    expect(prefersParty('以健康为准', 'life')).toBe(0);
  });

  it('「B 让位于 A」判定 A 胜、B 负', () => {
    expect(prefersParty('生活让位于健康', 'life')).toBeLessThan(0);
    expect(prefersParty('生活让位于健康', 'health')).toBeGreaterThan(0);
  });

  it('★ 两边都提到但无偏向标记 → 双方都不得分（交回用户）', () => {
    const ambiguous = '健康与生活都有道理，需要综合判断';
    expect(prefersParty(ambiguous, 'health')).toBe(0);
    expect(prefersParty(ambiguous, 'life')).toBe(0);
  });

  it('完全不提某一方时该方不得分', () => {
    expect(prefersParty('采用健康一方', 'code')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ ★ 管家唯一裁决者（架构性主张）
// ═══════════════════════════════════════════════════════════

describe('⑤ ★ 管家是唯一裁决者', () => {
  it('★ 仆人没有否决权：冲突只能由裁决流程解决，不由某一方宣告', () => {
    const { store, log, clock } = setup();
    // 健康仆人「声称」自己优先 —— 但这不构成裁决
    const verdict: Verdict = {
      conflictId: CONFLICT.id,
      winner: 'health',
      // ⚠️ 关键：decidedBy 不是 'servant'，类型上就不允许
      decidedBy: 'user',
      reason: '用户决定',
    };

    const outcome = applyVerdict({
      log,
      store,
      clock,
      conflict: CONFLICT,
      sides: sides(),
      verdict,
    });

    // 裁决事件由 user/butler 产生 —— 不会出现 actor=servant 的裁决
    const ev = log.byType('conflict.resolved')[0];
    expect(ev?.actor).not.toBe('servant');
    expect(outcome.verdict.decidedBy).toBe('user');
  });

  it('硬约束不走裁决流程（由机械校验直接拦截，那条路径独立）', () => {
    // 这里只需确认：裁决类型里没有 hardBlocked 这个 decidedBy ——
    // 硬约束拦截发生在 butler/hardConstraints.ts，不经过用户裁决
    const { store, log, clock } = setup();
    const outcome = applyVerdict({
      log,
      store,
      clock,
      conflict: { id: 'cf_hard', message: '花生过敏 vs 口味偏好' },
      sides: [
        { servant: 'life', claim: '推荐花生酱拌面', evidence: [], memoryIds: [] },
        { servant: 'health', claim: '用户对花生严重过敏', evidence: [], memoryIds: [] },
      ],
      verdict: { conflictId: 'cf_hard', winner: 'health', decidedBy: 'user', reason: '安全优先' },
    });
    // 走的是用户裁决路径，事件类型是 conflict.resolved
    expect(log.byType('conflict.resolved')).toHaveLength(1);
    expect(log.byType('constraint.hardBlocked')).toHaveLength(0);
    expect(outcome.verdict.winner).toBe('health');
  });
});

/** 类型自检：ServantId 参与构造。 */
const _typeCheck: ServantId = 'life';
void _typeCheck;
