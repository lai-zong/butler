import { describe, expect, it } from 'vitest';

import { decideProactive, inQuietHours, proactiveText } from '../proactive.js';

const at = (hour: number, minute = 0): number => new Date(2026, 0, 10, hour, minute).getTime();
const base = {
  enabled: true,
  frequency: 'normal' as const,
  quietStart: '22:30',
  quietEnd: '08:00',
  scenarios: { lateNight: true, longSession: true, return: true },
};
const usage = { sessionMinutes: 50, lastActiveAt: at(23), previousActiveAt: at(9) };

describe('pet proactive', () => {
  it('安静时段跨午夜', () => {
    expect(inQuietHours(at(23), '22:30', '08:00')).toBe(true);
    expect(inQuietHours(at(7), '22:30', '08:00')).toBe(true);
    expect(inQuietHours(at(12), '22:30', '08:00')).toBe(false);
  });

  it('关闭时不说话', () => {
    const d = decideProactive({
      now: at(23),
      config: { ...base, enabled: false },
      usage,
      history: [],
      suppressedUntil: null,
    });
    expect(d.speak).toBe(false);
  });

  it('命中长会话并受每日上限', () => {
    const d = decideProactive({
      now: at(14),
      config: { ...base, quietStart: '00:00', quietEnd: '00:00' },
      usage: { ...usage, lastActiveAt: at(14) },
      history: [],
      suppressedUntil: null,
    });
    expect(d.speak).toBe(true);
    expect(d.trigger).toBe('long_session');

    const blocked = decideProactive({
      now: at(14),
      config: { ...base, quietStart: '00:00', quietEnd: '00:00' },
      usage: { ...usage, lastActiveAt: at(14) },
      history: [
        { at: at(9), trigger: 'long_session' },
        { at: at(10), trigger: 'long_session' },
      ],
      suppressedUntil: null,
    });
    expect(blocked.speak).toBe(false);
  });

  it('同类提醒轮换模板，不总是同一句', () => {
    const a = proactiveText('late_night', []);
    const b = proactiveText('late_night', [{ at: 1, trigger: 'late_night' }]);
    const c = proactiveText('late_night', [
      { at: 1, trigger: 'late_night' },
      { at: 2, trigger: 'late_night' },
    ]);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });

  it('用户稍后有效', () => {
    const d = decideProactive({
      now: at(14),
      config: { ...base, quietStart: '00:00', quietEnd: '00:00' },
      usage: { ...usage, lastActiveAt: at(14) },
      history: [],
      suppressedUntil: at(15),
    });
    expect(d.speak).toBe(false);
  });
});
