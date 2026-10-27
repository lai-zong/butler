/**
 * 记忆仓储测试 —— 锁住四条分权不变量
 *
 * 背景（方案 § 2.2⑥）：记忆分权不是一个"设置项"，而是四条必须在代码层强制的规则。
 * 这些测试的作用是：任何人改动 store 时，一旦破坏了分权，测试立刻失败。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { DomainId } from '../../execution/types.js';
import { MemoryStore, type MemoryActor } from '../store.js';
import { replayMemory } from '../replay.js';

// ── 夹具 ──

const T0 = 1_760_000_000_000;
const USER = 'u_test';

const butler: MemoryActor = { kind: 'butler', userId: USER };
const user: MemoryActor = { kind: 'user', userId: USER };
/**
 * ★ v7（A2）：「管家+仆人」→「管家+监督员」后，`servant` 操作主体已删除。
 *
 * 这个文件里大量用例原本在测「仆人之间互相隔离」——
 * 那个能力在新架构下**不存在**（只有一个执行者）。
 *
 * 所以这两个名字保留成**同一个管家主体**，
 * 含义从「两个不同仆人」变成「同一个执行者访问不同领域标签的记忆」。
 * 相应地，那些「life 看不见 health」的断言必须改写 ——
 * 现在应当断言**看得见**（领域是标签，不是权限边界）。
 */
const life: MemoryActor = { kind: 'butler', userId: USER };
const health: MemoryActor = { kind: 'butler', userId: USER };

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
  domain?: DomainId,
): string {
  const r = store.create(butler, {
    memClass,
    kind: 'fact',
    content,
    confidence: 0.9,
    evidence: ['evt_1'],
    lifecycle: 'active',
    ...(domain !== undefined ? { domain } : {}),
  });
  if (!r.ok) throw new Error(`seed 失败：${r.reason}`);
  return r.entry.id;
}

// ═══════════════════════════════════════════════════════════
// M1 · 全局层写入权
//
// ⚠️ v7（A2）：这一组**语义变化**（能力收敛，不是测不过就改）。
//
//   旧：`servant` 主体存在，"全局层只能管家写"是**有意义的约束** ——
//       它拦住仆人越权。
//   新：只有一个执行者（管家），这句约束**恒真**，失去了拦截对象。
//
//   ★ 所以本组用例的断言从"仆人被拒"改为"**写入必留痕**"——
//     后者才是现在真正需要守住的东西：**任何写入都可追溯**。
//     拦截逻辑没有删，它只是没有了会触发它的调用方（见 canWrite 的注释）。
// ═══════════════════════════════════════════════════════════

describe('M1 · 全局层写入权与留痕', () => {
  it('管家写全局层成功，且写入可追溯', () => {
    const { store, log } = setup();

    const r = store.create(butler, {
      memClass: 'global_constraint',
      kind: 'fact',
      content: '花生过敏',
      confidence: 0.9,
      evidence: [],
    });

    expect(r.ok).toBe(true);
    expect(store.size()).toBe(1);
    // ★ 真正需要守住的东西：写入必留痕
    expect(log.all().some((e) => e.type === 'memory.created')).toBe(true);
  });

  it('管家可以写全部四类', () => {
    const { store } = setup();
    for (const cls of ['global_shared', 'sensitive'] as const) {
      const r = store.create(butler, {
        memClass: cls,
        kind: 'fact',
        content: 'x',
        confidence: 0.5,
        evidence: [],
      });
      expect(r.ok, cls).toBe(true);
    }
    expect(seed(store, 'global_constraint', '过敏')).toBeTruthy();
    expect(seed(store, 'domain', '偏好清淡', 'life')).toBeTruthy();
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
// M2 · 领域标签：是标签，不是权限边界
//
// ⚠️ v7（A2）：这一组**能力反转**，是本轮改造最实质的变化。
//
//   旧：「领域记忆只有所属仆人读写」—— 领域 = 某个执行者的地盘
//   新：「领域是标签」—— 只有一个执行者，领域只用于
//       ① 反思作用域（创新点①）② 召回过滤 ③ 监督员选纪律
//
//   ★ 所以"其它人读不到"这条能力**不存在了**，
//     断言改为"领域标签被正确记录、且不构成隔离"。
//     这不是放宽标准 —— 是隔离的对象变了（见 docs/servant-to-supervisor-audit.md）。
// ═══════════════════════════════════════════════════════════

describe('M2 · 领域标签（不是权限边界）', () => {
  it('领域记忆可读，且标签被正确记录', () => {
    const { store } = setup();
    const id = seed(store, 'domain', '偏好离家 3 公里内', 'life');

    const r = store.read(life, id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.domain).toBe('life');
  });

  it('★ 领域标签不构成权限边界（同一执行者读任何领域）', () => {
    const { store, log } = setup();
    const id = seed(store, 'domain', '偏好离家 3 公里内', 'life');

    // 旧架构里这里会被拒（domain_not_owner）。现在应当**放行**。
    const r = store.read(health, id);
    expect(r.ok).toBe(true);
    // 且不应产生"越权被拒"的审计事件
    expect(log.byType('grant.denied')).toHaveLength(0);
  });

  it('管家可写任何领域的记忆（否则领域记忆永远没有新内容）', () => {
    const { store } = setup();

    const r = store.create(butler, {
      memClass: 'domain',
      kind: 'preference',
      content: '喜欢靠窗座位',
      confidence: 0.7,
      evidence: [],
      domain: 'life',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.domain).toBe('life');
  });

  it('管家可改动领域记忆（旧架构是只读，新架构必须可写）', () => {
    const { store } = setup();
    const id = seed(store, 'domain', '偏好清淡', 'life');

    const r = store.revise(butler, id, { content: '改为偏好重口味' }, '用户更正');
    expect(r.ok).toBe(true);
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

  /**
   * ⚠️ v7（A2）：这条用例的**前提变了**，属于设计变化。
   *
   * 旧：管家永远能读敏感域（敏感域检查排在"管家放行"之后）
   * 新：**管家也要授权**（检查提到前面）
   *
   * 理由：单执行者下如果管家能直接读，敏感域隔离就变成空壳 ——
   *   而 D-8 的产品判断是「敏感信息不该出现在无关任务的上下文里」。
   *   现在唯一无条件能读的是**用户本人**。
   */
  it('★ 敏感域默认连管家也读不到，只有用户本人能读', () => {
    const { store } = setup();
    const id = seed(store, 'sensitive', '财务状况');

    const asButler = store.read(butler, id);
    expect(asButler.ok).toBe(false);
    if (!asButler.ok) expect(asButler.reason).toBe('sensitive_no_grant');

    expect(store.read(user, id).ok).toBe(true);
  });

  it('授权后管家可读，且读取留痕', () => {
    const { store, log } = setup();
    const id = seed(store, 'sensitive', '心理咨询：近期压力较大');

    const g = store.grant({
      actor: user,
      memoryId: id,
      to: 'health',
      taskId: 't_diet',
      purpose: '根据心理状态安排饮食',
      ttlMs: 60_000,
    });
    expect(g.ok).toBe(true);

    const r = store.read({ ...health, taskId: 't_diet' }, id);
    expect(r.ok).toBe(true);

    // ★ "谁在什么时候读了什么" 全程留痕
    expect(log.byType('grant.requested').length).toBeGreaterThanOrEqual(1);
    expect(log.byType('grant.approved').length).toBeGreaterThanOrEqual(1);
    expect(log.byType('grant.used').length).toBeGreaterThanOrEqual(1);
    // 审计只记“读过”，不把敏感正文再写进事件流
    expect(log.byType('grant.used')[0]?.payload).not.toHaveProperty('content');
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
    expect(store.read({ ...health, taskId: 't1' }, id).ok).toBe(true);

    clock.advance(1001);
    const after = store.read({ ...health, taskId: 't1' }, id);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('sensitive_no_grant');
  });

  /**
   * ⚠️ v7（A2）：这条能力**反转**了。
   *
   * 旧：授权是"给某个仆人"，所以"只授权给 A，B 读不到"有意义。
   * 新：只有一个执行者，授权语义变成「**本任务可以读敏感域**」（由 taskId 界定）。
   *
   *   ★ 所以不再有"给 A 不给 B"这回事。断言改为：
   *     授权后**可读**，且**任务过期后不可读**（这才是现在要守的边界）。
   */
  it('★ 授权后同一任务的读取放行（授权范围由 taskId 界定）', () => {
    const { store } = setup();
    const id = seed(store, 'sensitive', '心理咨询');

    store.grant({
      actor: user,
      memoryId: id,
      to: 'health',
      taskId: 't1',
      purpose: 'x',
      ttlMs: 60_000,
    });

    expect(store.read({ ...health, taskId: 't1' }, id).ok).toBe(true);
    // ⚠️ v10.4：授权只对 taskId 匹配的任务有效，不能泄漏给别的任务
    expect(store.read({ ...health, taskId: 't2' }, id).ok).toBe(false);
  });

  it('未授权时任何人都读不到（除用户本人）', () => {
    const { store } = setup();
    const id = seed(store, 'sensitive', '心理咨询');

    // ⚠️ v7：`servant` 主体已删除，"仆人不能自己给自己授权"这条不再适用。
    //    现在只有 butler / user 能授权，而两者都被允许 ——
    //    真正要守的是"**未授权就谁都读不到**"，这条在上面两个用例里覆盖。
    expect(store.read(butler, id).ok).toBe(false);
    expect(store.read(user, id).ok).toBe(true);
  });

  it('授权必须带 task / purpose，且 TTL 有上限', () => {
    const { store } = setup();
    const id = seed(store, 'sensitive', '心理咨询');

    expect(store.grant({
      actor: user,
      memoryId: id,
      to: 'health',
      taskId: '',
      purpose: 'x',
      ttlMs: 60_000,
    }).ok).toBe(false);

    expect(store.grant({
      actor: user,
      memoryId: id,
      to: 'health',
      taskId: 't1',
      purpose: '',
      ttlMs: 60_000,
    }).ok).toBe(false);

    expect(store.grant({
      actor: user,
      memoryId: id,
      to: 'health',
      taskId: 't1',
      purpose: 'x',
      ttlMs: 24 * 60 * 60 * 1000 + 1,
    }).ok).toBe(false);
  });

  it('任务结束时 revokeGrantsForTask 立即失效', () => {
    const { store, log } = setup();
    const id = seed(store, 'sensitive', '心理咨询');
    store.grant({
      actor: user,
      memoryId: id,
      to: 'health',
      taskId: 't_end',
      purpose: '本次任务',
      ttlMs: 60_000,
    });

    expect(store.read({ ...health, taskId: 't_end' }, id).ok).toBe(true);
    expect(store.revokeGrantsForTask('t_end')).toBe(1);
    expect(store.read({ ...health, taskId: 't_end' }, id).ok).toBe(false);
    expect(log.byType('grant.expired').some((e) => (e.payload as Record<string, unknown>)['reason'] === 'task_ended')).toBe(true);
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

  it('★★ 硬约束只有用户显式确认后才能删除，并留下不可还原的墓碑', () => {
    const { store, log } = setup();
    const id = seed(store, 'global_constraint', '你对花生严重过敏');

    expect(store.forgetHardConstraint(butler, id, 'confirmed').ok).toBe(false);
    expect(store.get(id)).toBeDefined();

    const r = store.forgetHardConstraint(user, id, 'confirmed');
    expect(r.ok).toBe(true);
    expect(store.get(id)).toBeUndefined();

    const tomb = log.byType('intervention.forgotten').at(-1);
    expect(tomb?.payload).toMatchObject({
      hardConstraint: true,
      confirmedBy: 'user',
      erased: true,
    });
    expect(JSON.stringify(tomb?.payload)).not.toContain('花生');
  });

  /**
   * ⚠️ v7（A2）：这条能力**反转**了 —— 领域已不是权限边界。
   *
   * 旧：仆人不能删除别人领域的记忆（`domain_not_owner`）
   * 新：只有一个执行者，管家可删除任何记忆。
   *     **真正要守的是"用户本人可随时删除"（遗忘权）** —— 见下一条。
   */
  it('★ 管家可删除任何领域的记忆（领域不是权限边界）', () => {
    const { store } = setup();
    const id = seed(store, 'domain', '生活领域偏好', 'life');
    const r = store.forget(health, id);
    expect(r.ok).toBe(true);
    expect(store.get(id)).toBeUndefined();
  });

  it('★★ 用户本人可删除领域记忆（遗忘权，安全底线）', () => {
    const { store } = setup();
    const id = seed(store, 'domain', '生活领域偏好', 'life');
    const r = store.forget(user, id);
    expect(r.ok).toBe(true);
    expect(store.get(id)).toBeUndefined();
  });

  it('★★ 硬约束**不允许**被遗忘（安全底线优先于遗忘权）', () => {
    // ⚠️ 我写这条测试时先想当然地以为"遗忘权覆盖一切"，
    //    结果被 store.forget 的护栏拦住了 —— 那道护栏是刻意的：
    //    过敏原这类硬约束一旦被删，后续所有推荐都会失去保护。
    //    所以**安全底线优先于遗忘权**，这里把这条设计显式钉住。
    const { store } = setup();
    const id = seed(store, 'global_constraint', '花生过敏');
    const r = store.forget(user, id);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('hard_constraint_cannot_be_forgotten');
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
  /**
   * ⚠️ v7（A2）：期望集合变了，因为**领域不再是权限边界**。
   *
   * 旧：生活仆人看到「硬约束 + 共享 + 自己的领域」，看不到他域
   * 新：单执行者，两个领域的记忆**都看得到**（领域只用于过滤/加权）
   *
   * ★ 但**敏感域依旧被挡住** —— 这一条是安全核心，**一条都不能松**。
   */
  it('★ 看到：硬约束 + 共享 + 全部领域标签的记忆，但看不到敏感域', () => {
    const { store } = setup();
    seed(store, 'global_constraint', '花生过敏');
    seed(store, 'global_shared', '作息规律');
    seed(store, 'sensitive', '心理咨询');
    seed(store, 'domain', '生活偏好', 'life');
    seed(store, 'domain', '健康偏好', 'health');

    const visible = store.visibleTo(life);
    const contents = visible.map((e) => e.content).sort();

    // 硬约束（强制可见）+ 全局共享 + 两个领域的记忆都在（领域是标签不是边界）
    expect([...contents]).toEqual(['作息规律', '花生过敏', '生活偏好', '健康偏好'].sort());
    // ★★ 安全底线：敏感域在无授权时必须被挡住
    expect(contents).not.toContain('心理咨询');
  });

  it('★★ 敏感域授权后才会出现在召回输入里', () => {
    const { store } = setup();
    const id = seed(store, 'sensitive', '心理咨询');

    expect(store.visibleTo(life).map((e) => e.content)).not.toContain('心理咨询');

    store.grant({ actor: user, memoryId: id, to: 'health', taskId: 't1', purpose: 'x', ttlMs: 60_000 });

    expect(store.visibleTo({ ...life, taskId: 't1' }).map((e) => e.content)).toContain('心理咨询');
  });
});

describe('检查点回退 · 记忆待复核', () => {
  it('markForReview 把普通记忆切成 candidate，并可通过事件重放恢复', () => {
    const { store, log } = setup();
    const id = seed(store, 'domain', '回退后才依赖的偏好', 'life');

    expect(store.markForReview(id)).toBe(true);
    expect(store.get(id)?.lifecycle).toBe('candidate');

    const replayed = replayMemory(log.all());
    expect(replayed.entries.find((e) => e.id === id)?.lifecycle).toBe('candidate');
    expect(replayed.anomalies).toEqual([]);
  });

  it('全局硬约束不能被回退降级为候选', () => {
    const { store } = setup();
    const id = seed(store, 'global_constraint', '花生过敏');

    expect(store.markForReview(id)).toBe(false);
    expect(store.get(id)?.lifecycle).toBe('active');
  });
});
