import { describe, expect, it } from 'vitest';

import {
  USAGE_ACTIVE_WINDOW_MS,
  USAGE_SESSION_GAP_MS,
  createUsageSessionId,
  formatUsageMinutes,
  getUsageEnabled,
  isRecentlyActive,
  setUsageEnabled,
  shouldRotateUsageSession,
  splitUsageMinutes,
  subscribeUsageEnabled,
  usageBarPercent,
  usageChartPeak,
  usageConfidencePercent,
  usageMonthDay,
  usageRangeLabel,
  usageWeekday,
} from '../usage.js';

describe('使用节奏的展示格式', () => {
  it('分钟数如实显示，不把 0 写成“刚刚”', () => {
    expect(formatUsageMinutes(0)).toBe('0 分钟');
    expect(formatUsageMinutes(0.4)).toBe('不到 1 分钟');
    expect(formatUsageMinutes(42)).toBe('42 分钟');
    expect(formatUsageMinutes(60)).toBe('1 小时');
    expect(formatUsageMinutes(222)).toBe('3 小时 42 分');
    expect(formatUsageMinutes(Number.NaN)).toBe('0 分钟');
  });

  it('读数位拆成数字与单位：不足 1 小时用分钟', () => {
    expect(splitUsageMinutes(0)).toEqual({ value: '0', unit: '分钟', exact: '0 分钟' });
    expect(splitUsageMinutes(42)).toEqual({ value: '42', unit: '分钟', exact: '42 分钟' });
    expect(splitUsageMinutes(90)).toEqual({ value: '1.5', unit: '小时', exact: '1 小时 30 分' });
    expect(splitUsageMinutes(600)).toEqual({ value: '10', unit: '小时', exact: '10 小时' });
  });

  it('日期标签用本地日历解析，不落进时区偏移', () => {
    expect(usageWeekday('2024-01-01')).toBe('周一');
    expect(usageWeekday('2024-01-07')).toBe('周日');
    expect(usageWeekday('not-a-date')).toBe('');
    expect(usageMonthDay('2026-11-03')).toBe('11/3');
  });

  it('区间文案取首尾两天', () => {
    expect(usageRangeLabel([])).toBe('');
    expect(
      usageRangeLabel([{ date: '2026-11-03' }, { date: '2026-11-05' }, { date: '2026-11-09' }]),
    ).toBe('11 月 3 日 — 11 月 9 日');
  });

  it('置信度兼容 0–1 与 0–100，输出整数百分比', () => {
    expect(usageConfidencePercent(0)).toBe(0);
    expect(usageConfidencePercent(0.62)).toBe(62);
    expect(usageConfidencePercent(75)).toBe(75);
    expect(usageConfidencePercent(Number.NaN)).toBe(0);
  });
});

describe('使用节奏的柱状图与时间判断', () => {
  it('峰值至少为 1，避免空数据除零', () => {
    expect(usageChartPeak([])).toBe(1);
    expect(usageChartPeak([{ minutes: 0 }, { minutes: 12 }, { minutes: 4 }])).toBe(12);
  });

  it('柱高按峰值换算，极短但有记录的日子保留 3% 可见高度', () => {
    expect(usageBarPercent(0, 10)).toBe(0);
    expect(usageBarPercent(5, 10)).toBe(50);
    expect(usageBarPercent(0.1, 100)).toBe(3);
  });

  it('活跃窗口与轮换阈值来自同一套常量', () => {
    const now = 1_000_000_000;
    expect(isRecentlyActive(now, now - USAGE_ACTIVE_WINDOW_MS)).toBe(true);
    expect(isRecentlyActive(now, now - USAGE_ACTIVE_WINDOW_MS - 1)).toBe(false);
    expect(shouldRotateUsageSession(0, now)).toBe(true);
    expect(shouldRotateUsageSession(now - USAGE_SESSION_GAP_MS, now)).toBe(false);
    expect(shouldRotateUsageSession(now - USAGE_SESSION_GAP_MS - 1, now)).toBe(true);
  });
});

describe('使用节奏的共享开关与会话 id', () => {
  it('开关只在真正变化时通知订阅者', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeUsageEnabled((next) => seen.push(next));
    setUsageEnabled(true);
    setUsageEnabled(true);
    setUsageEnabled(false);
    unsubscribe();
    setUsageEnabled(true);
    expect(seen).toEqual([true, false]);
    expect(getUsageEnabled()).toBe(true);
  });

  it('会话 id 每次生成都不同，且不含用户信息', () => {
    const first = createUsageSessionId();
    const second = createUsageSessionId();
    expect(first.length).toBeGreaterThan(8);
    expect(first).not.toBe(second);
    expect(first).not.toContain('@');
  });
});
