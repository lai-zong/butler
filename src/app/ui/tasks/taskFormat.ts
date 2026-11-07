/**
 * 定时任务的展示与表单转换 —— 纯函数，不依赖 React
 *
 * ★ 服务端只给绝对时间戳和 HH:mm，界面上的“今天 / 明天 / 已逾期”
 *   都在这里算，卡片与表单才不会各写一份时间说法。
 */

import { formatClock, formatDate, formatDateTime } from '../lib/format.js';
import type {
  TaskKind,
  TaskLastOutcome,
  TaskPermission,
  UserTaskView,
} from '../lib/types.js';

export const WEEKDAY_LABELS: readonly string[] = [
  '周日',
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
];

export const KIND_LABEL: Record<TaskKind, string> = {
  reminder: '提醒',
  work: '工作',
};

export const PERMISSION_LABEL: Record<TaskPermission, string> = {
  'read-only': '只读',
  workspace: '工作区',
  full: '完全',
};

/** 三档权限的直白说明；表单与卡片共用同一份措辞。 */
export const PERMISSION_NOTE: Record<TaskPermission, string> = {
  'read-only': '不修改文件。',
  workspace: '只允许在工作区内写入，越界直接失败，不弹确认。',
  full: '允许整台电脑的文件、应用、命令操作；无人值守时不询问，模型自行判断，属于高风险选择。',
};

export const OUTCOME_LABEL: Record<TaskLastOutcome, string> = {
  succeeded: '成功',
  failed: '失败',
  skipped: '跳过',
};

export function outcomeTone(outcome: TaskLastOutcome): 'accent' | 'warn' | 'neutral' {
  if (outcome === 'succeeded') return 'accent';
  if (outcome === 'failed') return 'warn';
  return 'neutral';
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeOfDay(value: string): boolean {
  return HHMM.test(value);
}

export function isWeekday(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 6;
}

export function weekdayLabel(weekday: number | null): string {
  if (weekday === null) return '每周';
  return WEEKDAY_LABELS[weekday] ?? '每周';
}

/** 计划规则的短句：一次 · 2026-11-02 09:30 / 每天 09:00 / 每周五 18:00 */
export function scheduleLabel(schedule: UserTaskView['schedule']): string {
  if (schedule.repeat === 'once') {
    return schedule.dueAt === null ? '一次' : `一次 · ${formatDateTime(schedule.dueAt)}`;
  }
  const time = schedule.timeOfDay !== null && isValidTimeOfDay(schedule.timeOfDay)
    ? schedule.timeOfDay
    : '--:--';
  if (schedule.repeat === 'daily') return `每天 ${time}`;
  return `每${weekdayLabel(schedule.weekday)} ${time}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** “今天 09:00 / 明天 09:00 / 11 月 5 日 09:00” */
export function formatWhen(ts: number, now: number): string {
  const diffDays = Math.round((startOfDay(ts) - startOfDay(now)) / 86_400_000);
  if (diffDays === 0) return `今天 ${formatClock(ts)}`;
  if (diffDays === 1) return `明天 ${formatClock(ts)}`;
  if (diffDays === 2) return `后天 ${formatClock(ts)}`;
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return sameYear ? `${formatDate(ts)} ${formatClock(ts)}` : formatDateTime(ts);
}

/** 卡片上的“下次 / 逾期 / 已完成 / 已暂停”。 */
export function nextRunLabel(task: UserTaskView, now: number): string {
  if (task.status === 'completed') {
    return task.completedAt !== null ? `已完成 · ${formatDateTime(task.completedAt)}` : '已完成';
  }
  if (task.status === 'paused') return '已暂停';
  if (task.nextRunAt === null) return '未安排时间';
  if (task.nextRunAt <= now) return `已逾期 · 原定 ${formatDateTime(task.nextRunAt)}`;
  return `下次 ${formatWhen(task.nextRunAt, now)}`;
}

/** 提醒卡片额外显示“稍后到几点”。 */
export function snoozeLabel(task: UserTaskView, now: number): string | null {
  if (task.snoozeUntil === null || task.snoozeUntil <= now) return null;
  return `稍后到 ${formatWhen(task.snoozeUntil, now)}`;
}

/**
 * 权限留空时的默认值 —— 与 `core/tasks/service.ts` 的口径一致：
 * 默认工作区 = 完全；自定义工作区 = 工作区。
 */
export function effectivePermission(
  permission: '' | TaskPermission,
  workspace: string,
): TaskPermission {
  if (permission !== '') return permission;
  return workspace.trim().length === 0 ? 'full' : 'workspace';
}

/** 只显示工作区最后一段，完整路径放 title。 */
export function workspaceShortLabel(workspace: string | null): string {
  const raw = workspace?.trim() ?? '';
  if (raw.length === 0) return '默认工作区';
  const parts = raw.split(/[\\/]+/).filter((part) => part.length > 0);
  const last = parts[parts.length - 1];
  return last ?? raw;
}

/** `<input type="datetime-local">` 需要的本地时间字符串。 */
export function toDateTimeLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
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

/** 新建“一次”任务时的默认时间：明天 09:00。 */
export function defaultOnceDue(now = Date.now()): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** 参考文件：一行一个路径。 */
export function splitFileLines(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 20);
}

/** 把 0–6 的星期排成“周日 … 周六”，与后端口径一致。 */
export function weekdayOptions(): readonly { readonly value: number; readonly label: string }[] {
  return WEEKDAY_LABELS.map((label, index) => ({ value: index, label }));
}
