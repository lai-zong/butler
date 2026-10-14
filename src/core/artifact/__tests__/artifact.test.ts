/**
 * 产出物版本化与三方同步回退测试
 *
 * 核心要验证方案 § 5.2 的三条承诺：
 *   ① 每次修改产生新版本，历史可查
 *   ② **被取代的产出物不删除**，可对比
 *   ③ 回退时对话、任务状态、产出物**同时**回到同一个点
 */

import { describe, expect, it } from 'vitest';

import { CheckpointManager } from '../../checkpoint/manager.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { InMemoryArtifactStore } from '../store.js';
import { diffRevisions } from '../types.js';

const T0 = 1_760_000_000_000;

function setup() {
  const log = new EventLog('s_art');
  const clock = new FixedClock(T0);
  const store = new InMemoryArtifactStore(log, clock);
  return { log, clock, store };
}

// ═══════════════════════════════════════════════════════════
// 创建与版本
// ═══════════════════════════════════════════════════════════

describe('创建产出物', () => {
  it('创建后为 active，版本为 1', () => {
    const { store } = setup();
    const a = store.create({
      label: '全素无花生菜单',
      kind: 'plan',
      content: '番茄炖菜、清炒西兰花',
      producedByStep: 's1',
      author: 'servant',
      authorId: 'life',
    });

    expect(a.status).toBe('active');
    expect(a.currentVersion).toBe(1);
    expect(store.currentRevision(a.id)?.content).toContain('番茄炖菜');
  });

  it('创建落 artifact.created 事件', () => {
    const { store, log } = setup();
    const a = store.create({
      label: '菜单',
      kind: 'plan',
      content: 'x',
      producedByStep: 's1',
      author: 'servant',
      authorId: 'life',
    });
    const ev = log.byType('artifact.created');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ artifactId: a.id, label: '菜单', kind: 'plan' });
    expect(ev[0]?.servantId).toBe('life');
  });

  it('★ 语义事件的正文不含内容，但 snapshot 里带全（供重放）', () => {
    const { store, log } = setup();
    store.create({
      label: '长文档',
      kind: 'text',
      content: 'x'.repeat(5000),
      producedByStep: 's1',
      author: 'butler',
    });

    const payload = log.byType('artifact.created')[0]?.payload as Record<string, unknown>;
    expect(payload['size']).toBe(5000);

    /**
     * ⚠️ 这条断言**改过**，原先是 `not.toContain('xxxx')`（内容完全不进事件）。
     *
     *    改的理由：重放需要内容。没有内容的产出物恢复出来是空壳，
     *    而「回退后能看到当时的清单长什么样」正是方案 § 5.2 的演示点。
     *
     *    体量实测：单次会话产出物约 5—30 KB，100 次会话 0.5—3 MB。
     *    这个量级下把内容放进事件是**可接受**的，
     *    换来的是「事件即完整真相源」这一性质的成立。
     *
     *    生产环境应改为内容寻址存储（内容存文件、事件只存哈希）；
     *    当前规模下引入它属于过度设计。
     */
    const snapshot = payload['snapshot'] as {
      revisions?: { content?: string }[];
    };
    expect(snapshot?.revisions?.[0]?.content).toHaveLength(5000);
  });
});

describe('版本化', () => {
  it('★ 修改产生新版本，历史版本仍可查', () => {
    const { store } = setup();
    const a = store.create({
      label: '菜单',
      kind: 'plan',
      content: '第一版',
      producedByStep: 's1',
      author: 'servant',
      authorId: 'life',
    });

    store.revise({
      artifactId: a.id,
      content: '第二版',
      author: 'servant',
      authorId: 'health',
      reason: '健康校正后调整',
    });

    expect(store.get(a.id)?.currentVersion).toBe(2);
    expect(store.revisions(a.id)).toHaveLength(2);
    // ★ 历史版本没丢
    expect(store.revision(a.id, 1)?.content).toBe('第一版');
    expect(store.currentRevision(a.id)?.content).toBe('第二版');
  });

  it('修订记录作者与理由（可追溯"谁改的、为什么"）', () => {
    const { store } = setup();
    const a = store.create({
      label: '菜单',
      kind: 'plan',
      content: 'v1',
      producedByStep: 's1',
      author: 'servant',
      authorId: 'life',
    });
    store.revise({
      artifactId: a.id,
      content: 'v2',
      author: 'user',
      reason: '我不想要豆腐',
    });

    const rev = store.currentRevision(a.id);
    expect(rev?.author).toBe('user');
    expect(rev?.reason).toBe('我不想要豆腐');
    expect(rev?.version).toBe(2);
  });

  it('修订落 artifact.revised 事件', () => {
    const { store, log } = setup();
    const a = store.create({
      label: 'x',
      kind: 'text',
      content: 'v1',
      producedByStep: 's1',
      author: 'butler',
    });
    store.revise({ artifactId: a.id, content: 'v2', author: 'butler', reason: '更新' });
    expect(log.byType('artifact.revised')).toHaveLength(1);
  });

  it('修订不存在的产出物抛错', () => {
    const { store } = setup();
    expect(() =>
      store.revise({ artifactId: 'nope', content: 'x', author: 'butler', reason: 'r' }),
    ).toThrow(/不存在/);
  });

  it('★ 恢复被取代的产出物：修订会清掉取代标记', () => {
    const { store } = setup();
    const a = store.create({
      label: '菜单',
      kind: 'plan',
      content: 'v1',
      producedByStep: 's1',
      author: 'butler',
    });
    store.supersede(a.id, { byRollback: 'ckpt_1' });
    expect(store.get(a.id)?.status).toBe('superseded');
    expect(store.get(a.id)?.supersededByRollback).toBe('ckpt_1');

    // 用户决定恢复它并改一版
    store.revise({ artifactId: a.id, content: 'v1 修订', author: 'user', reason: '恢复并调整' });
    expect(store.get(a.id)?.status).toBe('active');
    expect(store.get(a.id)?.supersededByRollback).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 被取代 ≠ 删除
// ═══════════════════════════════════════════════════════════

describe('★ 被取代不等于删除（方案 § 5.2 明确要求）', () => {
  it('标记取代后产出物仍在，历史仍可查', () => {
    const { store } = setup();
    const a = store.create({
      label: '菜单 v1',
      kind: 'plan',
      content: '旧方案',
      producedByStep: 's1',
      author: 'butler',
    });

    store.supersede(a.id, { by: 'art_v2' });

    // ★ 关键：还能取到，内容还在
    const after = store.get(a.id);
    expect(after).toBeDefined();
    expect(after?.status).toBe('superseded');
    expect(after?.supersededBy).toBe('art_v2');
    expect(store.currentRevision(a.id)?.content).toBe('旧方案');
  });

  it('取代事件里显式记录"仍保留"（设计承诺，不只是实现细节）', () => {
    const { store, log } = setup();
    const a = store.create({
      label: 'x',
      kind: 'text',
      content: 'c',
      producedByStep: 's1',
      author: 'butler',
    });
    store.supersede(a.id, { byRollback: 'ckpt_1' });

    const ev = log.byType('artifact.superseded')[0];
    expect(ev?.payload).toMatchObject({ retained: true, byRollback: 'ckpt_1' });
  });

  it('重复取代是幂等的', () => {
    const { store, log } = setup();
    const a = store.create({ label: 'x', kind: 'text', content: 'c', producedByStep: 's', author: 'butler' });
    expect(store.supersede(a.id)).toBe(true);
    expect(store.supersede(a.id)).toBe(true);
    expect(log.byType('artifact.superseded')).toHaveLength(1);
  });

  it('可列出被取代的产出物（界面"历史方案"分区）', () => {
    const { store } = setup();
    const a = store.create({ label: 'a', kind: 'text', content: '1', producedByStep: 's', author: 'butler' });
    store.create({ label: 'b', kind: 'text', content: '2', producedByStep: 's', author: 'butler' });
    store.supersede(a.id);

    expect(store.listByStatus('superseded')).toHaveLength(1);
    expect(store.listByStatus('active')).toHaveLength(1);
  });

  it('用户可明确丢弃（与"被取代"区分）', () => {
    const { store } = setup();
    const a = store.create({ label: 'x', kind: 'text', content: 'c', producedByStep: 's', author: 'butler' });
    store.discard(a.id);
    expect(store.get(a.id)?.status).toBe('discarded');
    // 即便丢弃，数据仍在
    expect(store.currentRevision(a.id)?.content).toBe('c');
  });
});

// ═══════════════════════════════════════════════════════════
// 版本对比
// ═══════════════════════════════════════════════════════════

describe('版本对比 · 新旧并排', () => {
  it('算出新增与去掉了什么', () => {
    const { store } = setup();
    const a = store.create({
      label: '菜单',
      kind: 'plan',
      content: '',
      items: ['番茄炖菜', '清炒西兰花', '杂粮饭'],
      producedByStep: 's1',
      author: 'butler',
    });
    store.revise({
      artifactId: a.id,
      content: '',
      items: ['番茄炖菜', '杂粮饭', '毛豆'],
      author: 'user',
      reason: '去掉西兰花，加毛豆',
    });

    const v1 = store.revision(a.id, 1);
    const v2 = store.revision(a.id, 2);
    if (!v1 || !v2) throw new Error('missing revision');

    const d = diffRevisions(v1, v2);
    expect(d.addedLines).toEqual(['毛豆']);
    expect(d.removedLines).toEqual(['清炒西兰花']);
    expect(d.unchangedCount).toBe(2);
  });

  it('对比相同版本时无差异', () => {
    const { store } = setup();
    const a = store.create({
      label: 'x',
      kind: 'plan',
      content: '',
      items: ['a', 'b'],
      producedByStep: 's',
      author: 'butler',
    });
    const v1 = store.revision(a.id, 1);
    if (!v1) throw new Error('missing');
    const d = diffRevisions(v1, v1);
    expect(d.addedLines).toEqual([]);
    expect(d.removedLines).toEqual([]);
    expect(d.unchangedCount).toBe(2);
  });

  it('text 类型按行对比', () => {
    const { store } = setup();
    const a = store.create({
      label: 'x',
      kind: 'text',
      content: '第一行\n第二行',
      producedByStep: 's',
      author: 'butler',
    });
    store.revise({
      artifactId: a.id,
      content: '第一行\n第三行',
      author: 'butler',
      reason: 'r',
    });
    const v1 = store.revision(a.id, 1);
    const v2 = store.revision(a.id, 2);
    if (!v1 || !v2) throw new Error('missing');
    const d = diffRevisions(v1, v2);
    expect(d.addedLines).toEqual(['第三行']);
    expect(d.removedLines).toEqual(['第二行']);
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 三方同步回退
// ═══════════════════════════════════════════════════════════

describe('★ 三方同步回退（对话 + 任务状态 + 产出物）', () => {
  function buildSession() {
    const log = new EventLog('s_sync');
    const clock = new FixedClock(T0);
    const artifacts = new InMemoryArtifactStore(log, clock);
    const mgr = new CheckpointManager({ log, clock });
    let t = 0;
    const at = (): number => T0 + t++ * 1000;

    log.append({ type: 'thought.done', actor: 'butler', payload: { stage: 'understand' }, createdAt: at() });
    log.append({
      type: 'dispatch.created',
      actor: 'butler',
      payload: { steps: [{ stepId: 's1', servant: 'life' }, { stepId: 's2', servant: 'health' }] },
      createdAt: at(),
    });
    log.append({ type: 'dispatch.stepStarted', actor: 'butler', payload: { stepId: 's1' }, createdAt: at() });

    // s1 产出：菜单 v1
    const menu = artifacts.create({
      label: '菜单 v1',
      kind: 'plan',
      content: '',
      items: ['番茄炖菜', '清炒西兰花'],
      producedByStep: 's1',
      author: 'servant',
      authorId: 'life',
    });
    log.append({ type: 'dispatch.stepDone', actor: 'butler', payload: { stepId: 's1', servant: 'life', status: 'done' }, createdAt: at() });

    // s2 产出：菜单 v2（健康校正后）
    const menuV2 = artifacts.create({
      label: '菜单 v2（加量版）',
      kind: 'plan',
      content: '',
      items: ['番茄炖菜', '清炒西兰花', '毛豆', '天贝'],
      producedByStep: 's2',
      author: 'servant',
      authorId: 'health',
    });
    log.append({ type: 'dispatch.stepDone', actor: 'butler', payload: { stepId: 's2', servant: 'health', status: 'done' }, createdAt: at() });
    log.append({ type: 'session.ended', actor: 'butler', payload: {}, createdAt: at() });

    return { log, clock, artifacts, mgr, menu, menuV2 };
  }

  it('★ 回退时产出物同步标记为已取代，且不删除', () => {
    const { mgr, artifacts, menu, menuV2, log } = buildSession();
    mgr.sync();

    // 回退到 s1 完成点（菜单 v1 那个检查点）
    const cp = mgr.all().find((c) => c.label.includes('菜单 v1'));
    expect(cp, '应存在「菜单 v1」检查点').toBeDefined();

    const r = mgr.rollback(cp!.id, { artifacts });

    // ① 对话层：事件被截断
    expect(log.length).toBeLessThan(cp!.seq + 10);
    // ② 产出物层：v2 被取代
    expect(r.superseded).toContain(menuV2.id);
    expect(artifacts.get(menuV2.id)?.status).toBe('superseded');
    // ③ ★ 但 v2 没被删除，内容还在
    expect(artifacts.get(menuV2.id)).toBeDefined();
    expect(artifacts.revisions(menuV2.id)).toHaveLength(1);
    // ④ v1 保持 active
    expect(artifacts.get(menu.id)?.status).toBe('active');
  });

  it('取消失败：不传 artifacts 时只截断事件（产出物不动）', () => {
    const { mgr, artifacts, menuV2 } = buildSession();
    mgr.sync();
    const cp = mgr.all().find((c) => c.label.includes('菜单 v1'));
    mgr.rollback(cp!.id); // 不传 artifacts
    expect(artifacts.get(menuV2.id)?.status).toBe('active');
  });

  it('★ 回退后仍能对比新旧方案（"被取代可对比"的兑现）', () => {
    const { mgr, artifacts, menu, menuV2 } = buildSession();
    mgr.sync();
    const cp = mgr.all().find((c) => c.label.includes('菜单 v1'));
    mgr.rollback(cp!.id, { artifacts });

    const v1 = artifacts.currentRevision(menu.id);
    const oldV2 = artifacts.currentRevision(menuV2.id);
    if (!v1 || !oldV2) throw new Error('missing');

    const d = diffRevisions(v1, oldV2);
    expect(d.addedLines).toContain('毛豆');
    expect(d.addedLines).toContain('天贝');
  });

  it('取代事件记录了是哪个检查点导致的（可追溯）', () => {
    const { mgr, artifacts, menuV2, log } = buildSession();
    mgr.sync();
    const cp = mgr.all().find((c) => c.label.includes('菜单 v1'));
    mgr.rollback(cp!.id, { artifacts });

    const ev = log.byType('artifact.superseded').find(
      (e) => (e.payload as { artifactId?: string }).artifactId === menuV2.id,
    );
    expect(ev).toBeDefined();
    expect((ev?.payload as { byRollback?: string }).byRollback).toBe(cp!.id);
  });

  it('回退结果里同时列出被取代的产出物与待复核的记忆', () => {
    const { mgr, artifacts } = buildSession();
    mgr.sync();
    const cp = mgr.all().find((c) => c.label.includes('菜单 v1'));
    const r = mgr.rollback(cp!.id, { artifacts });

    expect(Array.isArray(r.superseded)).toBe(true);
    expect(Array.isArray(r.memoriesToReview)).toBe(true);
    expect(r.stateHash).toMatch(/^[0-9a-f]{8}$/);
  });
});
