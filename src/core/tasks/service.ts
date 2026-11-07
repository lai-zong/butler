/**
 * 用户任务服务：CRUD、到期提醒视图、自动工作执行。
 *
 * ★ 提醒不做后台轮询推送：
 *   应用没有常驻悬浮框，后台“提醒”无法真正弹出。
 *   因此提醒的 due 状态由 API 计算，页面/全局横幅轮询读取；
 *   应用关闭时不会丢数据，下次打开仍看到逾期提醒。
 *
 * ★ 工作由进程内 60 秒 tick 执行；应用没运行就不会执行。
 */

import { randomUUID } from 'node:crypto';

import type { EventLog } from '../events/log.js';
import type { EventType } from '../events/types.js';
import type { ClockPort } from '../ports/clock.js';
import { advanceOccurrence, isValidSchedule, nextOccurrence, scheduleLabel } from './schedule.js';
import { loadUserTasks, saveUserTasks } from './store.js';
import type {
  UserTask,
  UserTaskCreateInput,
  UserTaskKind,
  UserTaskPermission,
  UserTaskStatus,
  UserTaskUpdateInput,
  UserTaskView,
  WorkTaskResult,
  WorkTaskRunner,
} from './types.js';

const MAX_TITLE = 200;
const MAX_NOTE = 4000;
const MAX_INSTRUCTION = 20000;
const MAX_FILES = 20;

function normalizePermission(value: unknown, workspace: string | null): UserTaskPermission {
  if (value === 'read-only' || value === 'workspace' || value === 'full') return value;
  return workspace === null ? 'full' : 'workspace';
}

function cleanString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanFiles(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, MAX_FILES);
}

function ensureSchedule(input: UserTask['schedule']): void {
  if (!isValidSchedule(input)) throw new Error('定时规则不合法');
}

export class UserTaskService {
  private ticking = false;
  private running = false;

  constructor(
    private readonly dir: string,
    private readonly clock: ClockPort,
    private readonly runWork: WorkTaskRunner,
    private readonly log?: EventLog,
  ) {}

  async list(): Promise<readonly UserTaskView[]> {
    const now = this.clock.now();
    return (await loadUserTasks(this.dir)).map((task) => ({
      ...task,
      due:
        task.status === 'active' &&
        task.nextRunAt !== null &&
        task.nextRunAt <= now,
    }));
  }

  async get(id: string): Promise<UserTask | null> {
    return (await loadUserTasks(this.dir)).find((task) => task.id === id) ?? null;
  }

  async create(input: UserTaskCreateInput): Promise<UserTask> {
    const now = this.clock.now();
    const title = cleanString(input.title, MAX_TITLE);
    if (title.length === 0) throw new Error('任务名称不能为空');
    const kind = input.kind;
    if (kind !== 'reminder' && kind !== 'work') throw new Error('任务类型不合法');
    const schedule = input.schedule;
    ensureSchedule(schedule);
    const instruction = kind === 'work' ? cleanString(input.instruction, MAX_INSTRUCTION) : null;
    if (kind === 'work' && (instruction === null || instruction.length === 0)) {
      throw new Error('工作内容不能为空');
    }
    const workspace = kind === 'work' && typeof input.workspace === 'string' && input.workspace.trim().length > 0
      ? input.workspace.trim()
      : null;
    const initialNext = schedule.repeat === 'once'
      ? schedule.dueAt
      : nextOccurrence(schedule, now);
    if (initialNext === null || (schedule.repeat === 'once' && initialNext <= now)) {
      throw new Error('执行时间必须晚于当前时间');
    }
    const task: UserTask = {
      id: `task_${randomUUID()}`,
      kind,
      title,
      note: cleanString(input.note, MAX_NOTE),
      schedule,
      status: input.status === 'paused' ? 'paused' : 'active',
      nextRunAt: initialNext,
      createdAt: now,
      updatedAt: now,
      instruction: instruction ?? null,
      workspace,
      permission: kind === 'work'
        ? normalizePermission(input.permission, workspace)
        : 'read-only',
      model: kind === 'work' ? (input.model ?? null) : null,
      files: kind === 'work' ? cleanFiles(input.files) : [],
      snoozeUntil: null,
      completedAt: null,
      lastRunAt: null,
      lastOutcome: null,
      lastSummary: null,
      lastError: null,
    };
    const tasks = await loadUserTasks(this.dir);
    await saveUserTasks(this.dir, [task, ...tasks]);
    return task;
  }

  async update(id: string, input: UserTaskUpdateInput): Promise<UserTask> {
    const now = this.clock.now();
    const tasks = await loadUserTasks(this.dir);
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new Error('找不到定时任务');
    const old = tasks[index]!;
    const schedule = input.schedule ?? old.schedule;
    ensureSchedule(schedule);
    const title = input.title !== undefined ? cleanString(input.title, MAX_TITLE) : old.title;
    if (title.length === 0) throw new Error('任务名称不能为空');
    const workspace = input.workspace !== undefined
      ? (old.kind === 'work' && typeof input.workspace === 'string' && input.workspace.trim().length > 0
          ? input.workspace.trim()
          : null)
      : old.workspace;
    const instruction = input.instruction !== undefined
      ? (old.kind === 'work' ? cleanString(input.instruction, MAX_INSTRUCTION) : null)
      : old.instruction;
    if (old.kind === 'work' && (instruction === null || instruction.length === 0)) {
      throw new Error('工作内容不能为空');
    }
    const status = input.status ?? old.status;
    const scheduleChanged =
      schedule.repeat !== old.schedule.repeat ||
      schedule.dueAt !== old.schedule.dueAt ||
      schedule.timeOfDay !== old.schedule.timeOfDay ||
      schedule.weekday !== old.schedule.weekday;
    const nextRunAt = status === 'completed'
      ? null
      : status === 'paused' || (!scheduleChanged && old.status !== 'completed')
        ? old.nextRunAt
        : (schedule.repeat === 'once' ? schedule.dueAt : nextOccurrence(schedule, now));
    if (status === 'active' && nextRunAt === null) {
      throw new Error('执行时间必须晚于当前时间');
    }
    const next: UserTask = {
      ...old,
      title,
      note: input.note !== undefined ? cleanString(input.note, MAX_NOTE) : old.note,
      schedule,
      status,
      nextRunAt,
      updatedAt: now,
      instruction,
      workspace,
      permission: input.permission !== undefined
        ? normalizePermission(input.permission, workspace)
        : normalizePermission(old.permission, workspace),
      model: input.model !== undefined ? input.model : old.model,
      files: input.files !== undefined ? cleanFiles(input.files) : old.files,
    };
    const copy = [...tasks];
    copy[index] = next;
    await saveUserTasks(this.dir, copy);
    return next;
  }

  async remove(id: string): Promise<void> {
    const tasks = await loadUserTasks(this.dir);
    const next = tasks.filter((task) => task.id !== id);
    if (next.length === tasks.length) throw new Error('找不到定时任务');
    await saveUserTasks(this.dir, next);
  }

  async complete(id: string): Promise<UserTask> {
    return this.patchRuntime(id, {
      status: 'completed',
      nextRunAt: null,
      completedAt: this.clock.now(),
    }, 'user-task.completed');
  }

  async snooze(id: string, minutes: number): Promise<UserTask> {
    const delay = Math.min(Math.max(Math.round(minutes), 1), 24 * 60);
    const until = this.clock.now() + delay * 60_000;
    return this.patchRuntime(id, {
      status: 'active',
      nextRunAt: until,
      snoozeUntil: until,
    }, 'user-task.snoozed');
  }

  async setStatus(id: string, status: UserTaskStatus): Promise<UserTask> {
    const tasks = await loadUserTasks(this.dir);
    const old = tasks.find((task) => task.id === id);
    if (old === undefined) throw new Error('找不到定时任务');
    const nextRunAt = status === 'completed'
      ? null
      : status === 'paused'
        ? old.nextRunAt
        : (old.schedule.repeat === 'once'
            ? old.schedule.dueAt
            : nextOccurrence(old.schedule, this.clock.now()));
    return this.patchRuntime(id, {
      status,
      ...(status === 'completed' ? { completedAt: this.clock.now() } : {}),
      nextRunAt,
    }, 'user-task.updated');
  }

  /** 手动运行工作；提醒不允许从这里执行。 */
  async runNow(id: string): Promise<WorkTaskResult> {
    if (this.running) throw new Error('已有定时任务在运行');
    const tasks = await loadUserTasks(this.dir);
    const task = tasks.find((item) => item.id === id);
    if (task === undefined) throw new Error('找不到定时任务');
    if (task.kind !== 'work') throw new Error('提醒不能通过“立即运行”执行');
    this.running = true;
    try {
      return await this.executeWork(task, true);
    } finally {
      this.running = false;
    }
  }

  /** 每分钟调用；仅自动执行到期的工作。提醒由前端按 due 状态展示。 */
  async tick(now = this.clock.now()): Promise<readonly string[]> {
    if (this.ticking || this.running) return [];
    this.ticking = true;
    this.running = true;
    try {
      const tasks = await loadUserTasks(this.dir);
      const ran: string[] = [];
      for (const task of tasks) {
        if (task.kind !== 'work' || task.status !== 'active') continue;
        if (task.nextRunAt === null || task.nextRunAt > now) continue;
        await this.executeWork(task, false);
        ran.push(task.id);
      }
      return ran;
    } finally {
      this.running = false;
      this.ticking = false;
    }
  }

  private async executeWork(task: UserTask, manual: boolean): Promise<WorkTaskResult> {
    const startedAt = this.clock.now();
    let result: WorkTaskResult;
    try {
      result = await this.runWork(task);
    } catch (err) {
      result = {
        outcome: 'failed',
        summary: err instanceof Error ? err.message : String(err),
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const endedAt = this.clock.now();
    const completed = task.schedule.repeat === 'once';
    const nextRunAt = completed ? null : advanceOccurrence(task.schedule, endedAt);
    const tasks = await loadUserTasks(this.dir);
    const index = tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) {
      const updated: UserTask = {
        ...tasks[index]!,
        status: completed ? 'completed' : 'active',
        nextRunAt,
        updatedAt: endedAt,
        lastRunAt: endedAt,
        lastOutcome: result.outcome,
        lastSummary: result.summary,
        lastError: result.outcome === 'failed' ? result.summary : null,
        ...(completed ? { completedAt: endedAt } : {}),
      };
      const copy = [...tasks];
      copy[index] = updated;
      await saveUserTasks(this.dir, copy);
    }
    this.log?.append({
      type: 'user-task.run',
      actor: 'scheduler',
      payload: {
        id: task.id,
        kind: task.kind,
        title: task.title,
        manual,
        outcome: result.outcome,
        summary: result.summary,
        startedAt,
        endedAt,
      },
      createdAt: endedAt,
    });
    return result;
  }

  private async patchRuntime(id: string, patch: Partial<UserTask>, event: EventType): Promise<UserTask> {
    const tasks = await loadUserTasks(this.dir);
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new Error('找不到定时任务');
    const updated = { ...tasks[index]!, ...patch, updatedAt: this.clock.now() } as UserTask;
    const copy = [...tasks];
    copy[index] = updated;
    await saveUserTasks(this.dir, copy);
    this.log?.append({
      type: event,
      actor: 'user',
      payload: { id, title: updated.title, kind: updated.kind },
      createdAt: this.clock.now(),
    });
    return updated;
  }

  /** 供 UI 显示“这个任务下一次是什么”。 */
  describe(task: UserTask): string {
    return scheduleLabel(task.schedule);
  }
}

export type { UserTaskKind };
