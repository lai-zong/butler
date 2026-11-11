/**
 * 行为观察的保留期清理 —— 必须落到事件层
 *
 * ★ 实测过的问题：只清内存 `records` 时，重启后 `replayFromLog()` 会从
 *   `activity.sampled` 把应用名/时间重新装回来，于是"保留 7 天"只活到下次启动。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { ActivityObserver } from '../observe.js';

const T0 = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function setup(retentionDays = 1) {
  const log = new EventLog('s_activity');
  const clock = new FixedClock(T0);
  const observer = new ActivityObserver(log, clock, 'u1', {
    granted: true,
    enabled: true,
    grantedAt: T0,
    retentionDays,
  });
  return { log, clock, observer };
}

describe('保留期清理', () => {
  it('过期采样在事件流里被抹成占位符', () => {
    const { log, observer } = setup(1);
    observer.observe({ app: 'word', startedAt: T0, endedAt: T0 + 60_000, hadInput: true });
    expect(log.byType('activity.sampled')).toHaveLength(1);

    observer.purgeExpired(T0 + 3 * DAY);

    const events = log.byType('activity.sampled');
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload['purged']).toBe(true);
    // 原文（应用名）不能还在
    expect(JSON.stringify(payload)).not.toContain('word');
  });

  it('清理后重建观察器不会把记录装回来', () => {
    const { log, clock, observer } = setup(1);
    observer.observe({ app: 'chrome', startedAt: T0, endedAt: T0 + 60_000, hadInput: false });
    observer.purgeExpired(T0 + 3 * DAY);

    const fresh = new ActivityObserver(log, new FixedClock(T0 + 3 * DAY), 'u1', {
      granted: true,
      enabled: true,
      grantedAt: T0,
      retentionDays: 1,
    });
    fresh.replayFromLog(T0 + 3 * DAY);
    expect(fresh.rawRecords(T0 + 3 * DAY)).toEqual([]);
    expect(clock.now()).toBe(T0);
  });

  it('保留期内的采样不受影响', () => {
    const { log, observer } = setup(7);
    observer.observe({ app: 'word', startedAt: T0, endedAt: T0 + 60_000, hadInput: true });
    observer.purgeExpired(T0 + 3 * DAY);

    const payload = log.byType('activity.sampled')[0]?.payload as Record<string, unknown>;
    expect(payload['app']).toBe('word');
  });

  it('保留期 0 天：全部抹除', () => {
    const { log, observer } = setup(1);
    observer.observe({ app: 'word', startedAt: T0, endedAt: T0 + 60_000, hadInput: true });

    const zero = new ActivityObserver(log, new FixedClock(T0), 'u1', {
      granted: true,
      enabled: true,
      grantedAt: T0,
      retentionDays: 0,
    });
    zero.purgeExpired(T0);
    const payload = log.byType('activity.sampled')[0]?.payload as Record<string, unknown>;
    expect(payload['purged']).toBe(true);
  });
});
