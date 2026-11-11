/**
 * 状态快照回归 —— "改了状态却没留证据"的定点测试（2026-11-11）
 *
 * ★ 共同症状：改动在**内存里生效、重启后消失**，而且全程不报错。
 *   本文件每一条都对应一个实测过的复现：
 *
 *   | 场景                    | 修复前（重启后）              |
 *   |------------------------|------------------------------|
 *   | 撤销一条记忆             | 回到 active，继续被召回        |
 *   | 合并三条近义记忆         | 三条同时 active，重复召回      |
 *   | 操作记忆第 2 次及以后    | 退回首次值，"越做越准"失效     |
 *   | 偏好 / 环境记忆          | 整体消失（根本没进重放器）     |
 *   | 敏感域授权 / 凭证标记    | grants / capability 丢失      |
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock, SeededRandom } from '../../ports/clock.js';
import { MemoryStore } from '../store.js';
import { revoke } from '../admission.js';
import { mergeMemories } from '../merge.js';
import { replayMemory, hydrateStore } from '../replay.js';
import { snapshotOf } from '../snapshot.js';
import { OperationMemoryStore } from '../operations.js';
import { hydrateOperationStore, replayOperations } from '../operationReplay.js';

const T0 = 1_760_000_000_000;
const USER = 'u_snapshot';
const butler = { kind: 'butler', userId: USER } as const;

function setup() {
  const log = new EventLog('s_snapshot');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, USER);
  return { log, clock, store };
}

/** 重放一次，返回一个全新的 store（模拟"重启"）。 */
function restart(
  log: EventLog,
  clock: FixedClock,
): MemoryStore {
  const result = replayMemory(log.all());
  const fresh = new MemoryStore(new EventLog('s_restart'), clock, USER);
  hydrateStore({ store: fresh, result });
  return fresh;
}

describe('撤销：重启后不能复活', () => {
  it('撤销 → 重放仍是 archived', () => {
    const { log, clock, store } = setup();
    const created = store.create(butler, {
      id: 'mem_revoke',
      memClass: 'global_shared',
      kind: 'fact',
      content: '用户每天早上 7 点跑步',
      confidence: 0.9,
      evidence: ['e1'],
    });
    expect(created.ok).toBe(true);

    revoke({ log, store, clock, id: 'mem_revoke', reason: '记错了' });
    expect(store.get('mem_revoke')?.lifecycle).toBe('archived');

    const afterRestart = restart(log, clock);
    expect(afterRestart.get('mem_revoke')?.lifecycle).toBe('archived');
  });

  it('撤销事件带 snapshot（否则重放器只能跳过）', () => {
    const { log, clock, store } = setup();
    store.create(butler, {
      id: 'mem_revoke2',
      memClass: 'global_shared',
      kind: 'fact',
      content: '用户不吃香菜',
      confidence: 0.9,
      evidence: ['e1'],
    });
    revoke({ log, store, clock, id: 'mem_revoke2', reason: '记错了' });

    const rejected = log.byType('memory.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload).toMatchObject({ snapshot: { lifecycle: 'archived' } });
  });
});

describe('合并：重启后不能散架', () => {
  it('合并两条 → 重放后仍只有一条活跃', () => {
    const { log, clock, store } = setup();
    store.create(butler, {
      id: 'mem_keep',
      memClass: 'global_shared',
      kind: 'preference',
      content: '用户喜欢喝无糖豆浆',
      confidence: 0.8,
      evidence: ['e1'],
      lifecycle: 'active',
    });
    store.create(butler, {
      id: 'mem_absorb',
      memClass: 'global_shared',
      kind: 'preference',
      content: '用户早餐偏好无糖豆浆',
      confidence: 0.8,
      evidence: ['e2'],
      lifecycle: 'active',
    });

    const keep = store.get('mem_keep');
    const absorb = store.get('mem_absorb');
    if (keep === undefined || absorb === undefined) throw new Error('种子记忆缺失');

    const merged = mergeMemories({
      log,
      store,
      clock,
      candidate: {
        keep,
        absorb,
        similarity: 0.93,
        mergedContent: '用户早餐偏好无糖豆浆',
        reason: '近义合并',
      },
    });
    expect(merged).not.toBeNull();

    const live = (s: MemoryStore): number =>
      s.all().filter((e) => e.lifecycle === 'active' || e.lifecycle === 'candidate').length;
    expect(live(store)).toBe(1);

    const afterRestart = restart(log, clock);
    expect(afterRestart.get('mem_keep')?.lifecycle).toBe('archived');
    expect(afterRestart.get('mem_absorb')?.lifecycle).toBe('archived');
    expect(live(afterRestart)).toBe(1);
  });
});

describe('操作记忆：越用越准要跨重启成立', () => {
  it('4 次尝试 → 重放后仍是 4 次', () => {
    const clock = new FixedClock(T0);
    const log = new EventLog('s_op');
    const store = new OperationMemoryStore(log, clock, USER, new SeededRandom(1));

    store.recordAttempt({
      task: '把一批 Word 转 PDF',
      path: 'api',
      success: true,
      durationMs: 1200,
      method: 'COM 批量转换',
    });
    store.recordAttempt({ task: '把一批 Word 转 PDF', path: 'api', success: true, durationMs: 800 });
    store.recordAttempt({ task: '把一批 Word 转 PDF', path: 'api', success: true, durationMs: 900 });
    store.recordAttempt({
      task: '把一批 Word 转 PDF',
      path: 'api',
      success: false,
      durationMs: 5000,
      failureReason: 'Word 弹窗卡住',
    });

    const live = store.all()[0];
    expect(live?.effectiveness?.attempts).toBe(4);
    expect(live?.effectiveness?.succeeded).toBe(3);
    expect(live?.effectiveness?.consecutiveFailures).toBe(1);

    const result = replayOperations(log.all());
    const fresh = new OperationMemoryStore(new EventLog('s_op2'), clock, USER, new SeededRandom(1));
    hydrateOperationStore({ store: fresh, result });
    const restored = fresh.all()[0];

    expect(restored?.effectiveness?.attempts).toBe(4);
    expect(restored?.effectiveness?.succeeded).toBe(3);
    expect(restored?.effectiveness?.consecutiveFailures).toBe(1);
    expect(result.skippedEvents).toHaveLength(0);
  });

  it('偏好与环境记忆 → 重放后还在（旧实现 2 条变 0 条）', () => {
    const clock = new FixedClock(T0);
    const log = new EventLog('s_pref');
    const store = new OperationMemoryStore(log, clock, USER, new SeededRandom(1));

    store.recordPreference({ content: '我的文档都放 D 盘', taskLabel: '整理文件' });
    store.recordEnvironment({ content: '这台机器装了 Office 2019', taskLabel: '转 PDF' });
    expect(store.all()).toHaveLength(2);

    const result = replayOperations(log.all());
    const fresh = new OperationMemoryStore(new EventLog('s_pref2'), clock, USER, new SeededRandom(1));
    hydrateOperationStore({ store: fresh, result });

    expect(fresh.all()).toHaveLength(2);
    expect(fresh.all().map((m) => m.content).sort()).toEqual(
      ['我的文档都放 D 盘', '这台机器装了 Office 2019'].sort(),
    );
  });
});

describe('快照字段完整性', () => {
  it('敏感域授权进快照，重放后仍生效', () => {
    const { log, clock, store } = setup();
    store.create(butler, {
      id: 'mem_sens',
      memClass: 'sensitive',
      kind: 'fact',
      content: '心理咨询记录：对公开演讲有焦虑',
      confidence: 0.9,
      evidence: ['e1'],
    });
    store.grant({
      actor: { kind: 'user', userId: USER },
      memoryId: 'mem_sens',
      taskId: 's_snapshot',
      to: 'health',
      purpose: '回答健康问题',
      ttlMs: 600_000,
    });

    const snap = snapshotOf(store.get('mem_sens'));
    expect(Array.isArray(snap?.['grants'])).toBe(true);

    // 触发一次状态事件，让快照落进事件流
    store.archive('mem_sens', '测试：状态变更后授权仍在');

    const afterRestart = restart(log, clock);
    const entry = afterRestart.get('mem_sens');
    expect(entry?.grants).toHaveLength(1);
    expect(entry?.grants?.[0]?.taskId).toBe('s_snapshot');
  });

  it('凭证标记 capability 进快照，重放后仍在', () => {
    const { log, clock, store } = setup();
    store.create(butler, {
      id: 'mem_cred',
      memClass: 'global_shared',
      kind: 'fact',
      content: 'GitHub 令牌存放在凭证库',
      confidence: 0.9,
      evidence: ['e1'],
    });
    const entry = store.get('mem_cred');
    if (entry === undefined) throw new Error('种子记忆缺失');
    store.restoreEntry({ ...entry, capability: { canUse: true, canRead: false, requiresApproval: true } });

    store.archive('mem_cred', '测试：凭证标记');

    const afterRestart = restart(log, clock);
    expect(afterRestart.get('mem_cred')?.capability).toEqual({ canUse: true, canRead: false, requiresApproval: true });
  });
});
