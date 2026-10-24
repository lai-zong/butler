/**
 * 画像快照历史 —— 从事件流重建「成长对比」的测试。
 *
 * ★ 三条主张：
 *   ① 新快照必须带完整状态（不能只有计数）；
 *   ② 旧版本/损坏事件必须**跳过并计数**，不伪造；
 *   ③ 从事件读回的两份快照能直接 diff（重启/导出后仍可对比）。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../../memory/store.js';
import { captureProfile, diffProfiles } from '../profile.js';
import {
  findProfile,
  isProfileSnapshot,
  readProfileHistory,
  summarizeProfile,
} from '../profileHistory.js';

const T0 = new Date(2026, 9, 13, 14, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const USER = 'u_profile';
const butler = { kind: 'butler', userId: USER } as const;

function setup() {
  const log = new EventLog('s_profile');
  const clock = new FixedClock(T0);
  return { log, clock };
}

function storeWith(
  log: EventLog,
  clock: FixedClock,
  facts: number,
  principles = 0,
): MemoryStore {
  const store = new MemoryStore(log, clock, USER);
  for (let i = 0; i < facts; i++) {
    store.create(butler, {
      id: `f${i}`,
      memClass: 'global_shared',
      kind: 'fact',
      content: `事实 ${i}`,
      confidence: 0.8,
      evidence: [],
      lifecycle: 'active',
    });
  }
  for (let i = 0; i < principles; i++) {
    store.create(butler, {
      id: `p${i}`,
      memClass: 'global_shared',
      kind: 'principle',
      content: `原则 ${i}`,
      confidence: 0.8,
      evidence: [],
      lifecycle: 'active',
    });
  }
  return store;
}

describe('画像快照历史', () => {
  it('★★ 新快照在事件里带完整状态，而不是只有计数', () => {
    const { log, clock } = setup();
    const store = storeWith(log, clock, 10, 3);
    const snap = captureProfile({
      log,
      clock,
      store,
      userId: USER,
      patterns: [],
      sessionCount: 10,
    });

    const event = log.byType('profile.snapshot')[0];
    const payload = event?.payload as { snapshot?: unknown } | undefined;
    expect(payload?.snapshot).toEqual(snap);

    const history = readProfileHistory(log.all());
    expect(history.skipped).toBe(0);
    expect(history.profiles).toHaveLength(1);
    expect(history.profiles[0]).toEqual(snap);
  });

  it('★ 旧事件只有计数时跳过并计数，不伪造', () => {
    const { log, clock } = setup();
    const store = storeWith(log, clock, 4);
    captureProfile({ log, clock, store, userId: USER, patterns: [], sessionCount: 4 });

    // 模拟 v10.1 之前的事件：只有计数，没有 snapshot
    log.append({
      type: 'profile.snapshot',
      actor: 'butler',
      payload: {
        snapshotId: 'old',
        sessionCount: 3,
        facts: 2,
        preferences: 1,
        principles: 0,
        temporalPatterns: 0,
        activeMemories: 3,
        readOnlyDerivation: true,
      },
      createdAt: T0 - DAY,
    });

    const history = readProfileHistory(log.all());
    expect(history.profiles).toHaveLength(1);
    expect(history.skipped).toBe(1);
  });

  it('按 capturedAt 升序、同 id 去重', () => {
    const { log, clock } = setup();
    const store = storeWith(log, clock, 2);
    const first = captureProfile({
      log, clock, store, userId: USER, patterns: [], sessionCount: 2,
    });

    clock.advance(DAY);
    const second = captureProfile({
      log, clock, store, userId: USER, patterns: [], sessionCount: 3,
    });

    // 同 id 重复写入（例如进程重试）——只保留一份
    log.append({
      type: 'profile.snapshot',
      actor: 'butler',
      payload: { snapshot: first },
      createdAt: first.capturedAt,
    });

    const history = readProfileHistory(log.all());
    expect(history.profiles.map((p) => p.id)).toEqual([first.id, second.id]);
    expect(history.profiles[0]?.capturedAt).toBeLessThan(history.profiles[1]?.capturedAt ?? 0);
  });

  it('校验拒绝损坏/不完整的 snapshot', () => {
    expect(isProfileSnapshot(null)).toBe(false);
    expect(isProfileSnapshot({})).toBe(false);
    expect(
      isProfileSnapshot({
        id: 'x',
        userId: USER,
        capturedAt: T0,
        sessionCount: 1,
        facts: 1,
        preferences: 0,
        principles: 0,
        temporalPatterns: 0,
        perDomain: {},
        principleList: [],
        summary: 'ok',
      }),
    ).toBe(true);

    const { log } = setup();
    log.append({
      type: 'profile.snapshot',
      actor: 'butler',
      payload: { snapshot: { id: 'broken' } },
      createdAt: T0,
    });
    const history = readProfileHistory(log.all());
    expect(history.profiles).toHaveLength(0);
    expect(history.skipped).toBe(1);
  });

  it('★ 从事件读回的两份快照能直接 diff（重启后仍可对比）', () => {
    const { log, clock } = setup();
    const earlyStore = storeWith(log, clock, 12, 0);
    const early = captureProfile({
      log, clock, store: earlyStore, userId: USER, patterns: [], sessionCount: 10,
    });

    clock.advance(7 * DAY);
    const lateStore = storeWith(log, clock, 41, 6);
    const late = captureProfile({
      log, clock, store: lateStore, userId: USER, patterns: [], sessionCount: 50,
    });

    const history = readProfileHistory(log.all());
    const from = findProfile(history, early.id);
    const to = findProfile(history, late.id);
    expect(from).toBeDefined();
    expect(to).toBeDefined();

    const delta = diffProfiles(from!, to!);
    expect(delta.totalMemories).toBe(35);
    expect(delta.principles).toBe(6);
    expect(delta.headline).toContain('多了解你');
  });

  it('summary / findProfile 提供界面用的轻量数据', () => {
    const { log, clock } = setup();
    const store = storeWith(log, clock, 3, 2);
    const snap = captureProfile({
      log, clock, store, userId: USER, patterns: [], sessionCount: 7,
    });

    const history = readProfileHistory(log.all());
    expect(findProfile(history, snap.id)?.id).toBe(snap.id);
    expect(findProfile(history, 'nope')).toBeUndefined();

    const summary = summarizeProfile(snap);
    expect(summary.totalMemories).toBe(5);
    expect(summary.sessionCount).toBe(7);
    expect(summary.summary).toBe(snap.summary);
  });
});
