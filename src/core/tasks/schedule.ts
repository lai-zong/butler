import type { UserTaskSchedule } from './types.js';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTimeOfDay(value: unknown): string | null {
  if (typeof value !== 'string' || !HHMM.test(value)) return null;
  return value;
}

export function isValidWeekday(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

export function isValidSchedule(schedule: UserTaskSchedule): boolean {
  if (schedule.repeat === 'once') {
    return schedule.dueAt !== null && Number.isFinite(schedule.dueAt) && schedule.dueAt > 0;
  }
  if (schedule.timeOfDay === null || parseTimeOfDay(schedule.timeOfDay) === null) return false;
  if (schedule.repeat === 'weekly') return isValidWeekday(schedule.weekday);
  return true;
}

/**
 * 从 `now` 之后算下一次触发时间。
 *
 * 这里使用进程本地时区；应用是本地优先的单机程序，不引入时区字段。
 * 每月/复杂 cron 不进入第一版，避免规则一开始就过于复杂。
 */
export function nextOccurrence(schedule: UserTaskSchedule, now: number): number | null {
  if (schedule.repeat === 'once') {
    return schedule.dueAt !== null && schedule.dueAt > now ? schedule.dueAt : null;
  }
  const time = schedule.timeOfDay;
  if (time === null) return null;
  const [hourText, minuteText] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (schedule.repeat === 'weekly') {
    const weekday = schedule.weekday;
    if (weekday === null) return null;
    let diff = weekday - candidate.getDay();
    if (diff < 0) diff += 7;
    if (diff === 0 && candidate.getTime() <= now) diff = 7;
    candidate.setDate(candidate.getDate() + diff);
    return candidate.getTime();
  }

  if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

/** 到期后的下一次；once 返回 null。 */
export function advanceOccurrence(schedule: UserTaskSchedule, now: number): number | null {
  if (schedule.repeat === 'once') return null;
  return nextOccurrence(schedule, now + 1000);
}

export function scheduleLabel(schedule: UserTaskSchedule): string {
  if (schedule.repeat === 'once') {
    return schedule.dueAt === null ? '一次' : '一次';
  }
  const time = schedule.timeOfDay ?? '--:--';
  if (schedule.repeat === 'daily') return `每天 ${time}`;
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `每${names[schedule.weekday ?? 0] ?? '周'} ${time}`;
}
