import { describe, expect, it } from 'vitest';

import { aggregateUsage, type UsagePing } from '../aggregate.js';

function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 0, day, hour, minute, 0, 0).getTime();
}

function ping(day: number, hour: number, page: UsagePing['page'] = 'chat', active = true): UsagePing {
  return { at: at(day, hour), page, active };
}

describe('usage aggregate', () => {
  it('空数据不编造习惯', () => {
    const s = aggregateUsage([], { now: at(10, 12), days: 7 });
    expect(s.totalMinutes).toBe(0);
    expect(s.sessionCount).toBe(0);
    expect(s.habits).toEqual([]);
    expect(s.daily).toHaveLength(7);
  });

  it('活跃心跳按分钟累计，并切分会话', () => {
    const s = aggregateUsage(
      [
        ping(10, 20),
        { at: at(10, 20), page: 'chat', active: true },
        { at: at(10, 20) + 60_000, page: 'chat', active: true },
        { at: at(10, 20) + 120_000, page: 'memory', active: true },
        { at: at(10, 20) + 30 * 60_000, page: 'chat', active: true },
      ],
      { now: at(11, 12), days: 7 },
    );
    expect(s.sessionCount).toBe(2);
    expect(s.totalMinutes).toBeGreaterThan(0);
    expect(s.pages.some((p) => p.id === 'memory')).toBe(true);
  });

  it('开着但未操作的心跳不计入活跃分钟', () => {
    const s = aggregateUsage(
      [
        ping(10, 9, 'chat', false),
        ping(10, 9, 'chat', false),
        { at: at(10, 9) + 60_000, page: 'chat', active: false },
      ],
      { now: at(11, 12), days: 7 },
    );
    expect(s.totalMinutes).toBe(0);
    expect(s.visibleMinutes).toBe(3);
  });

  it('连续多天晚间出现时给出时段习惯', () => {
    const pings: UsagePing[] = [];
    for (const day of [5, 6, 7]) {
      pings.push({ at: at(day, 21), page: 'chat', active: true });
      pings.push({ at: at(day, 21) + 60_000, page: 'memory', active: true });
    }
    const s = aggregateUsage(pings, { now: at(8, 12), days: 7 });
    expect(s.activeDays).toBe(3);
    expect(s.habits.some((h) => h.id === 'usual-window' && h.text.includes('20:00'))).toBe(true);
  });
});
