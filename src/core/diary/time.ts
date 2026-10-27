/**
 * 日记日界线与时间窗口。
 *
 * 默认本地时间 04:00 为一天边界：深夜对话不会被切到两个自然日。
 * 这里只使用传入的 now（确定性），不读取系统当前时间。
 */

import type { DiaryDayWindow } from './types.js';

export const DIARY_DAY_BOUNDARY_HOUR = 4;
export const DIARY_GENERATION_MINUTE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function localParts(ms: number): { year: number; month: number; day: number } {
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 把时间归入“本地 04:00 起算”的日期键。 */
export function dayKeyFor(now: number, boundaryHour = DIARY_DAY_BOUNDARY_HOUR): string {
  const shifted = new Date(now);
  shifted.setHours(shifted.getHours() - boundaryHour);
  const p = localParts(shifted.getTime());
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 由日期键计算本地 [前一天 04:00, 当天 04:00) 窗口。 */
export function dayWindow(dayKey: string, boundaryHour = DIARY_DAY_BOUNDARY_HOUR): DiaryDayWindow {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) throw new Error(`invalid diary day key: ${dayKey}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day, boundaryHour, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, boundaryHour, 0, 0, 0);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error(`invalid diary day key: ${dayKey}`);
  }
  return { dayKey, startAt: start.getTime(), endAt: end.getTime() };
}

/** 日报任务的计划时刻（默认 04:10），用于调度器/运维展示。 */
export function diaryRunAt(dayKey: string, minute = DIARY_GENERATION_MINUTE): number {
  const w = dayWindow(dayKey);
  // 04:10 属于窗口结束当天，而不是窗口起点那天。
  return w.endAt + minute * 60 * 1000;
}

/** 前一天键（按本地日界）。 */
export function previousDayKey(now: number): string {
  const w = dayWindow(dayKeyFor(now));
  return dayKeyFor(w.startAt - 1);
}

export function dayLengthMs(): number {
  return DAY_MS;
}
