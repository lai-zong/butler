/**
 * 专注空间的日期与时间格式。
 *
 * ★ 与主界面的 format.ts 分开：专注空间需要「今天 / 明天 / 周几」
 *   这类围绕当前时刻的说法，而主界面更多是绝对时间与相对历史。
 *   放在一处，避免日程列表、当前安排和编辑器各写一份后口径漂移。
 */

import type { FocusScheduleDto } from '../lib/types.js';

const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

function pad(n: number): string {
  return `${n}`.padStart(2, '0');
}

export function clockLabel(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateLabel(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function weekdayLabel(ts: number): string {
  return WEEK_LABELS[new Date(ts).getDay()] ?? '';
}

function startOfDay(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dayDiff(ts: number, now: number): number {
  return Math.round((startOfDay(ts) - startOfDay(now)) / 86_400_000);
}

/** 日程分组的日期标题：今天 / 明天 / 11 月 16 日 · 周一 / 2025 年… */
export function scheduleDayLabel(ts: number, now = Date.now()): string {
  const diff = dayDiff(ts, now);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const base = `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${weekdayLabel(ts)}`;
  return sameYear ? base : `${date.getFullYear()} 年 ${base}`;
}

/** 当前安排里的时间段：同一天只写一次日期。 */
export function scheduleRangeLabel(
  schedule: Pick<FocusScheduleDto, 'startAt' | 'endAt'>,
  now = Date.now(),
): string {
  const startDay = scheduleDayLabel(schedule.startAt, now);
  if (startOfDay(schedule.startAt) === startOfDay(schedule.endAt)) {
    return `${startDay} ${clockLabel(schedule.startAt)} — ${clockLabel(schedule.endAt)}`;
  }
  return `${startDay} ${clockLabel(schedule.startAt)} — ${scheduleDayLabel(schedule.endAt, now)} ${clockLabel(schedule.endAt)}`;
}

export type FocusPhase = 'upcoming' | 'active' | 'ended';

export function schedulePhase(
  schedule: Pick<FocusScheduleDto, 'startAt' | 'endAt'>,
  now = Date.now(),
): FocusPhase {
  if (now < schedule.startAt) return 'upcoming';
  if (now < schedule.endAt) return 'active';
  return 'ended';
}

export function phaseLabel(phase: FocusPhase): string {
  if (phase === 'active') return '进行中';
  if (phase === 'ended') return '已结束';
  return '未开始';
}

/** 距离开始还有多久；已开始返回 null。用于当前安排的第二行提示。 */
export function untilStartLabel(startAt: number, now = Date.now()): string | null {
  const diff = startAt - now;
  if (diff <= 0) return null;
  const minutes = Math.max(1, Math.ceil(diff / 60_000));
  if (minutes < 60) return `还有 ${minutes} 分钟开始`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `还有 ${hours} 小时 ${rest} 分开始` : `还有 ${hours} 小时开始`;
  return `还有 ${Math.floor(hours / 24)} 天开始`;
}

/** `<input type="datetime-local">` 需要的本地时间字符串。 */
export function toDateTimeLocal(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 解析 `datetime-local` 的值；本地时区，非法返回 null。 */
export function fromDateTimeLocal(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (![year, month, day, hour, minute].every((n) => Number.isFinite(n))) return null;
  const ts = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** 新建日程的默认时间：下一个半点开始，持续一小时。 */
export function defaultScheduleRange(now = Date.now()): { readonly startAt: number; readonly endAt: number } {
  const date = new Date(now);
  date.setSeconds(0, 0);
  const remainder = date.getMinutes() % 30;
  const add = remainder === 0 ? 30 : 30 - remainder;
  date.setMinutes(date.getMinutes() + add);
  const startAt = date.getTime();
  return { startAt, endAt: startAt + 60 * 60_000 };
}

export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
