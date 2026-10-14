/**
 * 记忆仓储测试 —— 锁住四条分权不变量
 *
 * 背景（方案 § 2.2⑥）：记忆分权不是一个"设置项"，而是四条必须在代码层强制的规则。
 * 这些测试的作用是：任何人改动 store 时，一旦破坏了分权，测试立刻失败。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { ServantId } from '../../servants/types.js';
import { MemoryStore, type MemoryActor } from '../store.js';

// ── 夹具 ──

const T0 = 1_760_000_000_000;
const USER = 'u_test';

const butler: MemoryActor = { kind: 'butler', userId: USER };
const user: MemoryActor = { kind: 'user', userId: USER };
const life: MemoryActor = { kind: 'servant', userId: USER, servant: 'life' };
const health: MemoryActor = { kind: 'servant', userId: USER, servant: 'health' };

function setup(): { store: MemoryStore; log: EventLog; clock: FixedClock } {
  const log = new EventLog('s_mem');
  const clock = new FixedClock(T0);
  return { store: new MemoryStore(log, clock, USER), log, clock };
}

/** 建一条指定类别的记忆，返回 id。 */
function seed(
  store: MemoryStore,
  memClass: 'global_constraint' | 'global_shared' | 'sensitive' | 'domain',
  content: string,
  domainOwner?: ServantId,
): string {
  const r = store.create(butler, {
    memClass,
    kind: 'fact',
    content,
    confidence: 0.9,
    evidence: ['evt_1'],
    lifecycle: 'active',
    ...(domainOwner !== undefined ? { domainOwner } : {}),
  });
  if (!r.ok) throw new Error(`seed 失败：${r.reason}`);
  return r.entry.id;
}

// ═══════════════════════════════════════════════════════════
// M1 · 全局层只能管家写入
// ═══════════════════════════════════════════════════════════

describe('M1 · 全局层只能管家写入', () => {
  it('仆人写 global_constraint 被拒，且留下越权审计事件', () => {
    const { store, log } = setup();

    const r = store.create(life, {
      memClass: 'global_constraint',
      kind: 'fact',
      content: '花生过敏',
      confidence: 0.9,
      evidence: [],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('global_butler_only');

    // ★ 关键：越权尝试必须留痕，不能静默失败
    const attempted = log.byType('memory.writeAttempted');
    expect(attempted).toHaveLength(1);
    expect(attempted[0]?.payload).toMatchObject({ rejected: true, reason: 'global_butler_only' });
    expect(attempted[0]?.servantId).toBe('life');

    // 而且确实没写进去
    expect(store.size()).toBe(0);
  });

  it('仆人写 global_shared 与 sensitive 同样被拒', () => {
    const { store } = setup();
    for (const cls of ['global_shared', 'sensitive'] as const) {
      const r = store.create(life, {
        memClass: cls,
        kind: 'fact',
        content: 'x',
        confidence: 0.5,
        evidence: [],
      });
      expect(r.ok, cls).toBe(false);
    }
  });

  it('管家可以写全部四类', () => {
    const { store } = setup();
    expect(seed(store, 'global_constraint', '过敏')).toBeTruthy();
    expect(seed(store, 'global_shared', '作息')).toBeTruthy();
    expect(seed(store, 'sensitive', '心理咨询')).toBeTruthy();
    expect(seed(store, 'domain', '偏好清淡', 'life')).toBeTruthy();
    expect(store.size()).toBe(4);
  });

  it('用户可以直接写（用户是最高权限来源）', () => {
    const { store } = setup();
    const r = store.create(user, {
      memClass: 'global_constraint',
      kind: 'fact',
      content: '阿司匹林过敏',
      confidence: 1,
      evidence: [],
    });
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// M2 · 领域记忆只能所属仆人读写
// ═══════════════════════════════════════════════════════════

describe('M2 · 领域记忆隔离', () => {
  it('所属仆人可以读自己的领域记忆', () => {
    const { store } = setup();
    const id = seed(store, 'domain', '偏好离家 3 公里内', 'life');

    const r = store.read(life, id);
    expect(r.ok).toBe(true);
  });

  it('★ 其它仆人读不到（这是"仆人独立演化"的前提）', () => {
    const { store, log } = setup();
    const id = seed(store, 'domain', '偏好离家 3 公里内', 'life');

    const r = store.read(health, id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('domain_not_owner');

    // 拒绝也要留痕（便于发现异常访问模式）
    expect(log.byType('grant.denied')).toHaveLength(1);
  });

  it('仆人只能写自己领域的记忆', () => {
    const { store } = setup();

    const mine = store.create(life, {
      memClass: 'domain',
      kind: 'preference',
      content: '喜欢靠窗座位',
      confidence: 0.7,
      evidence: [],
    });
    expect(mine.ok).toBe(true);

    const notMine = store.create(health, {
      memClass: 'domain',
      kind: 'preference',
      content: '别人领域的',
      confidence: 0.7,
      evidence: [],
      domainOwner: 'life',
    });
    expect(notMine.ok).toBe(false);
  });

  it('管家对本领域记忆只读（写入被拒，保证所属权清晰）', () => {
    const { store } = setup();
    const id = seed(store, 'domain', '偏好清淡', 'life');

    const r = store.revise(butler, id, { content: '被管家改了' }, '越权测试');
    expect(r.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// M3 · 敏感域默认完全隔离 + 逐次授权
// ═══════════════════════════════════════════════════════════

describe('M3 · 敏感域隔离与授权', () => {
  it('默认任何仆人都读不到', () => {
    const { store } = setup();
    const id = seed(store, 'sensitive', '心理咨询：近期压力较大');

    for (const actor of [life, health]) {
      const r = store.read(actor, id);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('sensitive_no_grant');
    }
  });

  it('管家与用户可读', () => {
    const { store } = setup();
    const id = seed(store, 'sensitive', '财务状况');
    expect(store.read(butler, id).ok).toBe(true);
    expect(store.read(user, id).ok).toBe(true);
  });

  it('授权后该仆人可读，且读取留痕', () => {
    const { store, log } = setup();
    const id = seed(store, 'sensitive', '心理咨询：近期压力较大');

    const g = store.grant({
      actor: butler,
      memoryId: id,
      to: 'health',
      taskId: 't_diet',
      purpose: '根据心理状态安排饮食',
      ttlMs: 60_000,
    });
    expect(g.ok).toBe(true);

    const r = store.read(health, id);
    expect(r.ok).toBe(true);

    // ★ "谁在什么时候读了什么" 全程留痕
    expect(log.byType('grant.requested')).toHaveLength(1);
    expect(log.byType('grant.approved')).toHaveLength(1);
    const used = log.byType('grant.used');
    expect(used).toHaveLength(1);
    expect(used[0]?.servantId).toBe('health');
  });

  it('★ 授权到期后自动失效（不做长期免授权）', () => {
    const { store, clock } = setup();
    const id = seed(store, 'sensitive', '心理咨询');

    store.grant({
      actor: butler,
      memoryId: id,
      to: 'health',
      taskId: 't1',
      purpose: '本次任务',
      ttlMs: 1000,
    });
    expect(store.read(health, id).ok).toBe(true);

    clock.advance(1001);
    const after = store.read(health, id);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('sensitive_no_grant');
  });

  it('只授权给 A 时 B 依然读不到', () => {
    const { store } = setup();
    const id = seed(store, 'sensitive', '心理咨询');

    store.grant({
      actor: butler,
      memoryId: id,
      to: 'health',
      taskId: 't1',
      purpose: 'x',
      ttlMs: 60_000,
    });

    expect(store.read(health, id).ok).toBe(true);
    expect(store.read(life, id).ok).toBe(false);
  });

  it('仆人不能自己给自己授权', () => {
    const { store } = setup();
    const id = seed(store, 'sensitive', '心理咨询');

    const g = store.grant({
      actor: health,
      memoryId: id,
      to: 'health',
      taskId: 't1',
      purpose: '自己给自己',
      ttlMs: 60_000,
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe('only_butler_or_user_can_grant');
  });

  it('非敏感域不允许授权（避免把授权当作绕过隔离的手段）', () => {
    const { store } = setup();
    const id = seed(store, 'global_shared', '作息');
    const g = store.grant({
      actor: butler,
      memoryId: id,
      to: 'health',
      taskId: 't1',
      purpose: 'x',
      ttlMs: 1000,
    });
    expect(g.ok).toBe(false);
  });

  it('expireGrants 清理过期授权并留痕', () => {
    const { store, clock, log } = setup();
    const id = seed(store, 'sensitive', '心理咨询');
    store.grant({
      actor: butler,
      memoryId: id,
      to: 'health',
      taskId: 't1',
      purpose: 'x',
      ttlMs: 1000,
    });

    expect(store.expireGrants()).toBe(0); // 还没过期
    clock.advance(2000);
    expect(store.expireGrants()).toBe(1);
    expect(log.byType('grant.expired')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 强制可见性
// ═══════════════════════════════════════════════════════════

describe('全局硬约束对所有角色强制可见', () => {
  it('任何仆人都能读到硬约束（安全不能靠授权）', () => {
    const { store } = setup();
    const id = seed(store, 'global_constraint', '你对花生严重过敏');
    for (const actor of [life, health, butler, user]) {
      expect(store.read(actor, id).ok, actor.kind).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 版本历史与遗忘权
// ═══════════════════════════════════════════════════════════

describe('版本历史', () => {
  it('修改产生新版本并保留 before/after', () => {
    const { store, log } = setup();
    const id = seed(store, 'global_shared', '偏好清淡');

    const r = store.revise(butler, id, { content: '偏好重口味' }, '用户更正');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.version).toBe(2);

    const revs = store.revisionsOf(id);
    expect(revs).toHaveLength(1);
    expect(revs[0]?.patch.before.content).toBe('偏好清淡');
    expect(revs[0]?.patch.after.content).toBe('偏好重口味');
    expect(revs[0]?.reason).toBe('用户更正');

    expect(log.byType('memory.revised')).toHaveLength(1);
  });
});

describe('遗忘权', () => {
  it('用户可彻底删除一般记忆', () => {
    const { store, log } = setup();
    const id = seed(store, 'global_shared', '某条偏好');

    const r = store.forget(user, id);
    expect(r.ok).toBe(true);
    expect(store.get(id)).toBeUndefined();

    // 事件里只留"已删除"，不留内容
    const forgotten = log.byType('intervention.forgotten');
    expect(forgotten).toHaveLength(1);
    expect(JSON.stringify(forgotten[0]?.payload)).not.toContain('某条偏好');
  });

  it('★ 硬约束不可遗忘（否则会删掉过敏史）', () => {
    const { store } = setup();
    const id = seed(store, 'global_constraint', '你对花生严重过敏');

    const r = store.forget(user, id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('hard_constraint_cannot_be_forgotten');
    expect(store.get(id)).toBeDefined();
  });

  it('仆人不能删除不属于自己的记忆', () => {
    const { store } = setup();
    const id = seed(store, 'domain', '生活领域偏好', 'life');
    const r = store.forget(health, id);
    expect(r.ok).toBe(false);
    expect(store.get(id)).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 审核流程
// ═══════════════════════════════════════════════════════════

describe('候选审核', () => {
  it('新建默认为 candidate，审核通过后变 active', () => {
    const { store, log } = setup();
    const r = store.create(butler, {
      memClass: 'global_shared',
      kind: 'preference',
      content: '候选偏好',
      confidence: 0.6,
      evidence: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.entry.lifecycle).toBe('candidate');
    expect(log.byType('memory.candidate')).toHaveLength(1);

    const ok = store.review(user, r.entry.id, 'approve', '看起来对');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.entry.lifecycle).toBe('active');
    expect(log.byType('memory.approved')).toHaveLength(1);
  });

  it('拒绝不删除，而是归档（避免反思反复提同一条）', () => {
    const { store, log } = setup();
    const r = store.create(butler, {
      memClass: 'global_shared',
      kind: 'preference',
      content: '不对的偏好',
      confidence: 0.6,
      evidence: [],
    });
    if (!r.ok) throw new Error('create failed');

    const rej = store.review(user, r.entry.id, 'reject', '不是这样');
    expect(rej.ok).toBe(true);
    if (rej.ok) expect(rej.entry.lifecycle).toBe('archived');

    expect(store.get(r.entry.id)).toBeDefined(); // 仍在
    expect(log.byType('memory.rejected')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// visibleTo 与召回输入
// ═══════════════════════════════════════════════════════════

describe('visibleTo · 召回层的输入集合', () => {
  it('生活仆人看到：硬约束 + 共享 + 自己的领域，看不到敏感域与他域', () => {
    const { store } = setup();
    seed(store, 'global_constraint', '花生过敏');
    seed(store, 'global_shared', '作息规律');
    seed(store, 'sensitive', '心理咨询');
    seed(store, 'domain', '生活偏好', 'life');
    seed(store, 'domain', '健康偏好', 'health');

    const visible = store.visibleTo(life);
    const contents = visible.map((e) => e.content).sort();

    // 期望集合：硬约束（强制可见）+ 全局共享 + 自己的领域
    expect([...contents]).toEqual(['作息规律', '花生过敏', '生活偏好'].sort());
    expect(contents).not.toContain('心理咨询');
    expect(contents).not.toContain('健康偏好');
  });
});
