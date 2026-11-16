import { describe, expect, it } from 'vitest';

import {
  formatChatTime,
  formatDayLabel,
  relativeTime,
  sameLocalDay,
} from '../format.js';

function ts(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

const NOW = ts(2026, 11, 16, 10, 0);

describe('对话时间标注', () => {
  it('同一天只显示时钟，并标记今天', () => {
    const at = ts(2026, 11, 16, 9, 50);
    expect(formatChatTime(at, NOW)).toBe('09:50');
    expect(formatDayLabel(at, NOW)).toBe('今天');
    expect(relativeTime(at, NOW)).toBe('10 分钟前');
  });

  it('自然日昨天带“昨天”和具体时钟，不按 24 小时差误判', () => {
    const at = ts(2026, 11, 15, 23, 50);
    expect(formatChatTime(at, NOW)).toBe('昨天 23:50');
    expect(formatDayLabel(at, NOW)).toBe('昨天');
    expect(relativeTime(at, NOW)).toBe('昨天');
  });

  it('更早的消息显示月日与时钟，跨年显示年份', () => {
    expect(formatChatTime(ts(2026, 11, 14, 23, 50), NOW)).toBe('11 月 14 日 23:50');
    expect(formatDayLabel(ts(2026, 11, 14, 23, 50), NOW)).toBe('11 月 14 日');
    expect(formatChatTime(ts(2025, 12, 31, 23, 50), NOW)).toBe('2025 年 12 月 31 日 23:50');
    expect(formatDayLabel(ts(2025, 12, 31, 23, 50), NOW)).toBe('2025 年 12 月 31 日');
  });

  it('同一自然日判断跨午夜', () => {
    expect(sameLocalDay(ts(2026, 11, 16, 0, 1), ts(2026, 11, 16, 23, 59))).toBe(true);
    expect(sameLocalDay(ts(2026, 11, 15, 23, 59), ts(2026, 11, 16, 0, 1))).toBe(false);
  });
});
