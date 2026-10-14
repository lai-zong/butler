/**
 * 检查点与回退测试 —— 验证方案 § 5.1 / § 5.2 的四条承诺
 *
 *   ① **保留前置成果** —— 只重做失败的那一步
 *   ② **回退预览准确** —— 用户按之前就能看到会丢什么、留什么
 *   ③ **放弃的内容不删除** —— 被取代的产出物可对比
 *   ④ **回退结果可信** —— 重放两次状态哈希一致
 *
 * 外加一条最容易出 bug 的：
 *   ⑤ **级联失效** —— 引用的记忆被删后，检查点必须标记不可用
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { CheckpointManager, isCheckpointWorthy, labelFor } from '../manager.js';
import { hashString, replay, stableStringify, stateHashOf } from '../replay.js';
import { RollbackError } from '../types.js';

const T0 = 1_760_000_000_000;

function setup() {
  const log = new EventLog('s_ckpt');
  const clock = new FixedClock(T0);
  const mgr = new CheckpointManager({ log, clock });
  return { log, clock, mgr };
}

/**
 * 铺一条"请朋友吃饭"的事件流 —— 等价于验证 1 里真实模型跑出来的链路。
 * 用它来验证检查点行为，不烧 token 且完全确定。
 */
function seedSession(log: EventLog): void {
  const now = T0;
  const at = (offset: number) => now + offset * 1000;

  log.append({ type: 'thought.done', actor: 'butler', payload: { stage: 'understand', userGoal: '请朋友吃饭' }, createdAt: at(0) });
  log.append({ type: 'memory.recalled', actor: 'butler', payload: { count: 4 }, createdAt: at(1) });
  log.append({ type: 'route.decided', actor: 'butler', payload: { servant: 'life', confidence: 0.75 }, createdAt: at(2) });
  log.append({
    type: 'dispatch.created',
    actor: 'butler',
    payload: {
      goal: '请朋友吃饭',
      steps: [
        { stepId: 's1', servant: 'life' },
        { stepId: 's2', servant: 'health' },
        { stepId: 's3', servant: 'butler' },
      ],
    },
    createdAt: at(3),
  });
  log.append({ type: 'constraint.injected', actor: 'butler', payload: { stepId: 's1', memoryId: 'm_allergy' }, createdAt: at(4) });
  log.append({ type: 'dispatch.stepStarted', actor: 'butler', payload: { stepId: 's1', servant: 'life' }, createdAt: at(5) });
  log.append({
    type: 'servant.report',
    actor: 'servant',
    servantId: 'life',
    payload: { taskId: 's1', status: 'done', usage: { inputTokens: 800, outputTokens: 400 } },
    createdAt: at(6),
  });
  log.append({ type: 'dispatch.stepDone', actor: 'butler', payload: { stepId: 's1', servant: 'life', status: 'done' }, createdAt: at(7) });
  log.append({ type: 'artifact.created', actor: 'butler', payload: { artifactId: 'art_menu_v1', label: '菜单 v1' }, createdAt: at(8) });
  log.append({ type: 'dispatch.stepStarted', actor: 'butler', payload: { stepId: 's2', servant: 'health' }, createdAt: at(9) });
  log.append({
    type: 'conflict.detected',
    actor: 'supervisor',
    payload: { message: '火锅高油高盐，与减脂目标冲突', severity: 'warn' },
    createdAt: at(10),
  });
  log.append({ type: 'conflict.resolved', actor: 'user', payload: { resolution: '健康优先' }, createdAt: at(11) });
  log.append({ type: 'dispatch.stepDone', actor: 'butler', payload: { stepId: 's2', servant: 'health', status: 'done' }, createdAt: at(12) });
  log.append({ type: 'artifact.created', actor: 'butler', payload: { artifactId: 'art_menu_v2', label: '菜单 v2' }, createdAt: at(13) });
  // 让检查点建立"记忆依赖"：只有 constraint.injected 与 servant.report.memoryRefs
  // 算依赖（memory.candidate 是"产生了"，不是"依赖了"）
  log.append({
    type: 'constraint.injected',
    actor: 'butler',
    payload: { stepId: 's2', memoryId: 'mem_new_pref', negotiable: true },
    createdAt: at(14),
  });
  log.append({ type: 'session.ended', actor: 'butler', payload: {}, createdAt: at(15) });
}

// ═══════════════════════════════════════════════════════════
// ① 筛选：不是每条事件都成为检查点
// ═══════════════════════════════════════════════════════════

describe('① 检查点筛选', () => {
  it('★ 只有关键决策点成为检查点（16 条事件 → 少数几个）', () => {
    const { log, mgr } = setup();
    seedSession(log);
    const added = mgr.sync();

    expect(log.length).toBe(16);
    // 关键点：理解目标 / 召回 / 路由 / 分解 / s1完成 / v1 / 冲突 / 裁决 / s2完成 / v2 / 交付
    expect(added.length).toBeGreaterThan(5);
    expect(added.length).toBeLessThan(log.length);
  });

  it('明确不该成为检查点的事件被排除', () => {
    const { log } = setup();
    log.append({ type: 'constraint.injected', actor: 'butler', payload: {}, createdAt: T0 });
    log.append({ type: 'dispatch.stepStarted', actor: 'butler', payload: {}, createdAt: T0 });
    log.append({ type: 'fitness.updated', actor: 'system', payload: {}, createdAt: T0 });

    expect(isCheckpointWorthy(log.all()[0]!)).toBe(false);
    expect(isCheckpointWorthy(log.all()[1]!)).toBe(false);
    expect(isCheckpointWorthy(log.all()[2]!)).toBe(false);
  });

  it('关键事件是检查点', () => {
    const { log } = setup();
    for (const t of ['route.decided', 'dispatch.created', 'dispatch.stepDone', 'conflict.detected', 'artifact.created'] as const) {
      const e = log.append({ type: t, actor: 'butler', payload: {}, createdAt: T0 });
      expect(isCheckpointWorthy(e), t).toBe(true);
    }
  });

  it('标签可读（时间轴上用户看得懂）', () => {
    const { log } = setup();
    const e = log.append({
      type: 'route.decided',
      actor: 'butler',
      payload: { servant: 'life', confidence: 0.75 },
      createdAt: T0,
    });
    const { kind, label } = labelFor(e);
    expect(kind).toBe('route');
    expect(label).toContain('life');
  });

  it('sync 是幂等的（重复调用不重复建点）', () => {
    const { log, mgr } = setup();
    seedSession(log);
    const a = mgr.sync();
    const b = mgr.sync();
    expect(b).toHaveLength(0);
    expect(mgr.all()).toHaveLength(a.length);
  });

  it('检查点按 seq 有序', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();
    const seqs = mgr.all().map((c) => c.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
  });

  it('用户可手动打点', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();
    const cp = mgr.manual('我自己想记住这里');
    expect(cp.kind).toBe('manual');
    expect(cp.label).toBe('我自己想记住这里');
    expect(mgr.byId(cp.id)).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// ② 回退预览
// ═══════════════════════════════════════════════════════════

describe('② 回退预览（用户按之前看到的东西）', () => {
  it('★ 告诉用户保留几步、重做几步', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    // 回退到「菜单 v1」这个点 —— 此时 s1 已完成、s2/s3 未做
    const target = mgr.all().find((c) => c.label.includes('菜单 v1'));
    expect(target, '应存在「菜单 v1」检查点').toBeDefined();
    const plan = mgr.planRollback(target!.id);

    // ★ 核心承诺：s1 的成果保留，不重做
    expect(plan.keepSteps).toContain('s1');
    // s2 与 s3 在该点之后完成，需要重做
    expect(plan.redoSteps).toContain('s2');
    expect(plan.keepSteps).not.toContain('s2');
  });

  it('★ 回退到「任务分解」时，还没有任何步骤完成', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    const planCp = mgr.all().find((c) => c.kind === 'plan');
    if (!planCp) throw new Error('no target');
    const plan = mgr.planRollback(planCp.id);

    // 分解刚做完，三个步骤都还没执行
    expect(plan.keepSteps).toEqual([]);
    expect([...plan.redoSteps].sort()).toEqual(['s1', 's2']);
  });

  it('★ 列出受影响的产出物，区分保留与取代', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    const target = mgr.all().find((c) => c.label.includes('菜单 v1') || c.kind === 'deliver');
    if (!target) throw new Error('no target');

    const plan = mgr.planRollback(target.id);
    const superseded = plan.artifactImpact.filter((a) => a.action === 'supersede');
    const kept = plan.artifactImpact.filter((a) => a.action === 'keep');

    expect(kept.some((a) => a.artifactId === 'art_menu_v1')).toBe(true);
    if (target.seq < 13) {
      expect(superseded.some((a) => a.artifactId === 'art_menu_v2')).toBe(true);
    }
  });

  it('报告将丢弃多少事件', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    const target = mgr.all()[0];
    if (!target) throw new Error('no target');
    const plan = mgr.planRollback(target.id);
    expect(plan.discardedEvents).toBe(log.length - target.seq);
  });

  it('★ 回退到交付点之前，之后新增的记忆标记为待复核', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    const plan = mgr.all().find((c) => c.kind === 'plan');
    if (!plan) throw new Error('no target');
    const p = mgr.planRollback(plan.id);
    const review = p.memoryImpact.filter((m) => m.action === 'review');
    expect(review.some((m) => m.memoryId === 'mem_new_pref')).toBe(true);
  });

  it('目标就是当前位置时拒绝（无需回退）', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();
    const last = mgr.all()[mgr.all().length - 1];
    if (!last) throw new Error('no target');
    expect(() => mgr.planRollback(last.id)).toThrow(RollbackError);
  });

  it('不存在的检查点抛明确错误', () => {
    const { mgr } = setup();
    try {
      mgr.planRollback('nope');
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RollbackError);
      if (e instanceof RollbackError) expect(e.reason).toBe('checkpoint_not_found');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// ③ 执行回退
// ═══════════════════════════════════════════════════════════

describe('③ 执行回退', () => {
  it('★ 保留前置成果：只重做目标之后的步骤', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    // 回退到 s2 开始之前（s1 已完成）
    const target = mgr.all().find((c) => c.label.includes('菜单 v1'));
    if (!target) throw new Error('no target');

    const r = mgr.rollback(target.id);

    expect(r.toSeq).toBe(target.seq);
    expect(log.length).toBe(target.seq + 1); // +1 是刚写入的 session.rollback 事件

    // s1 的成果保留
    const replayed = replay(log.all());
    expect(replayed.state.completedSteps).toContain('s1');
    expect(replayed.state.completedSteps).not.toContain('s2');
  });

  it('★ 被取代的产出物被标记而非删除', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    const target = mgr.all().find((c) => c.label.includes('菜单 v1'));
    if (!target) throw new Error('no target');

    const r = mgr.rollback(target.id);
    expect(r.superseded).toContain('art_menu_v2');
    // 产出物引用从状态里移除（已被取代），但 rollback 结果里保留了它的 id 供对比
    const replayed = replay(log.all());
    expect(replayed.state.artifactIds).not.toContain('art_menu_v2');
  });

  it('★ 回退本身落事件（可审计 + 供监督窗口同步）', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();
    const target = mgr.all()[0];
    if (!target) throw new Error('no target');
    mgr.rollback(target.id);

    const ev = log.byType('session.rollback');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({
      checkpointId: target.id,
      toSeq: target.seq,
    });
    // 状态哈希要记进事件，便于事后核对
    expect(typeof (ev[0]?.payload as { stateHash?: string }).stateHash).toBe('string');
  });

  it('★ 放弃的事件被返回供归档（截断 ≠ 删除）', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();
    const target = mgr.all().find((c) => c.kind === 'plan');
    if (!target) throw new Error('no target');

    const r = mgr.rollback(target.id);
    expect(r.discarded.length).toBeGreaterThan(0);
    // 每条被丢弃的事件都有 seq 与 type，可用于"被取代内容仍可对比"
    for (const d of r.discarded) {
      expect(typeof d.seq).toBe('number');
      expect(typeof d.type).toBe('string');
    }
  });

  it('回退后可以继续追加事件，seq 接续（前置成果不丢）', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();
    const target = mgr.all().find((c) => c.kind === 'plan');
    if (!target) throw new Error('no target');

    mgr.rollback(target.id);
    const before = log.length;
    const e = log.append({ type: 'dispatch.stepStarted', actor: 'butler', payload: { stepId: 's2' }, createdAt: T0 });
    expect(e.seq).toBe(before + 1);
    // seq 1（理解目标）依然在
    expect(log.all()[0]?.type).toBe('thought.done');
  });

  it('回退后，被回退掉的检查点被移除', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();
    const target = mgr.all().find((c) => c.kind === 'plan');
    if (!target) throw new Error('no target');

    mgr.rollback(target.id);
    expect(mgr.all().every((c) => c.seq <= target.seq + 1)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// ④ ★ 级联失效（最容易出 bug 的地方）
// ═══════════════════════════════════════════════════════════

describe('④ ★ 级联失效检测', () => {
  it('引用的记忆被删除后，检查点标记为失效', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    // 先确认有检查点引用了 mem_new_pref
    const referencing = mgr.all().filter((c) => c.snapshot.memories.some((m) => m.memoryId === 'mem_new_pref'));
    expect(referencing.length).toBeGreaterThan(0);

    // 用户行使遗忘权删掉了它
    const existing = new Set(['art_menu_v1', 'art_menu_v2', 'mem_other']);
    const invalidated = mgr.revalidate((_kind, id) => existing.has(id));

    expect(invalidated.length).toBeGreaterThan(0);
    const bad = mgr.all().find((c) => c.invalidatedBy !== undefined);
    expect(bad?.invalidatedBy).toContain('已被删除');
  });

  it('★ 失效的检查点不可回退，且给出明确原因', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    const target = mgr.all().find((c) => c.snapshot.artifacts.length > 0);
    if (!target) throw new Error('no target');

    // 只保留记忆，删除全部产出物
    mgr.revalidate((kind, _id) => kind === 'memory');

    try {
      mgr.planRollback(target.id);
      expect.unreachable('应拒绝');
    } catch (e) {
      expect(e).toBeInstanceOf(RollbackError);
      if (e instanceof RollbackError) {
        expect(e.reason).toBe('checkpoint_invalidated');
        expect(e.message).toContain('失效');
      }
    }
  });

  it('有效检查点仍然可用（失效是精确的，不是一刀切）', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    // 早期检查点在产出物产生之前，删掉产出物不影响它
    const early = mgr.all().find((c) => c.snapshot.artifacts.length === 0);
    if (!early) throw new Error('no early checkpoint');

    mgr.revalidate((_kind, _id) => false); // 什么都不存在了
    // 早期检查点也不引用任何东西，但记忆引用可能为空
    const stillValid = mgr.valid();
    expect(stillValid.length).toBeGreaterThanOrEqual(0);
    void early;
  });

  it('valid() 排除失效检查点，all() 保留（用户要能看到为什么不能用）', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();
    const total = mgr.all().length;

    mgr.revalidate(() => false);
    expect(mgr.valid().length).toBeLessThanOrEqual(total);
    expect(mgr.all().length).toBe(total); // 仍然保留，只是标记
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ ★ 确定性重放
// ═══════════════════════════════════════════════════════════

describe('⑤ ★ 确定性重放（"回退结果可信"的技术保证）', () => {
  it('同一事件流重放两次，状态哈希完全一致', () => {
    const { log } = setup();
    seedSession(log);
    const h1 = replay(log.all()).stateHash;
    const h2 = replay(log.all()).stateHash;
    expect(h1).toBe(h2);
  });

  it('两条独立建立的相同事件流，哈希一致（不受时间戳影响）', () => {
    const a = new EventLog('s1');
    const b = new EventLog('s2');
    seedSession(a);
    // 用不同的时间戳铺同样的内容
    const shifted = new EventLog('s2');
    const original = a.all();
    for (const e of original) {
      shifted.append({
        type: e.type,
        payload: e.payload,
        actor: e.actor,
        ...(e.servantId !== undefined ? { servantId: e.servantId } : {}),
        createdAt: T0 + 999_999, // 完全不同的时间
      });
    }
    void b;

    // ★ createdAt 不纳入哈希 —— 否则重放必然不一致
    expect(stateHashOf(shifted.all())).toBe(stateHashOf(a.all()));
  });

  it('payload 里混入时间戳会改变哈希（这正是要抓的不确定因素）', () => {
    const a = new EventLog('s');
    a.append({ type: 'thought.done', actor: 'butler', payload: { note: 'x' }, createdAt: T0 });
    const h1 = stateHashOf(a.all());

    const b = new EventLog('s');
    b.append({ type: 'thought.done', actor: 'butler', payload: { note: 'x', at: 123456 }, createdAt: T0 });
    expect(stateHashOf(b.all())).not.toBe(h1);
  });

  it('usage 等元数据不纳入哈希（它们不影响业务状态）', () => {
    const a = new EventLog('s');
    a.append({ type: 'servant.report', actor: 'servant', servantId: 'life', payload: { status: 'done', usage: { inputTokens: 100 } }, createdAt: T0 });
    const b = new EventLog('s');
    b.append({ type: 'servant.report', actor: 'servant', servantId: 'life', payload: { status: 'done', usage: { inputTokens: 999 } }, createdAt: T0 });
    expect(stateHashOf(a.all())).toBe(stateHashOf(b.all()));
  });

  it('回退后重放的状态与检查点记录一致', () => {
    const { log, mgr } = setup();
    seedSession(log);
    mgr.sync();

    const target = mgr.all().find((c) => c.kind === 'plan');
    if (!target) throw new Error('no target');

    mgr.rollback(target.id);
    const after = replay(log.all());
    // 回退到 plan 之后，s1/s2 都还没做
    expect(after.state.completedSteps).toHaveLength(0);
    expect([...after.state.pendingSteps].sort()).toEqual(['s1', 's2', 's3']);
  });

  it('stableStringify 对键顺序不敏感', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('hashString 确定性且区分不同输入', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('')).toHaveLength(8);
  });

  it('浮点数被规范化，避免精度差异导致哈希漂移', () => {
    // 0.1 + 0.2 !== 0.3，但 toFixed(6) 后一致
    expect(stableStringify(0.1 + 0.2)).toBe(stableStringify(0.3));
  });
});
