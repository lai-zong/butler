/**
 * 专注日程服务。
 *
 * ★ 它只做四件事：读列表、增、改、删，以及记住「当前安排」。
 *   没有调度器、没有 tick、没有事件日志、没有模型调用 ——
 *   这是「日程」与「定时任务」保持独立的关键。
 *
 * ★ 所有写操作串行化：
 *   同一秒内保存两次（例如点完保存又立刻点选当前）时，
 *   并发 read-modify-write 会互相覆盖；这里用一条 Promise 链排队。
 */

import { randomUUID } from 'node:crypto';

import type { ClockPort } from '../ports/clock.js';
import { loadFocusSchedules, saveFocusSchedules } from './store.js';
import type {
  FocusSchedule,
  FocusScheduleCreateInput,
  FocusScheduleState,
  FocusScheduleUpdateInput,
} from './types.js';

const MAX_TITLE = 120;
const MAX_NOTE = 2000;
const MAX_SCHEDULES = 500;

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+$/u, '').trim().slice(0, max) : '';
}

function finiteTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function assertRange(startAt: number, endAt: number): void {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) {
    throw new Error('开始与结束时间不合法');
  }
  if (endAt <= startAt) {
    throw new Error('结束时间必须晚于开始时间');
  }
}

export class FocusScheduleService {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly clock: ClockPort,
  ) {}

  snapshot(): Promise<FocusScheduleState> {
    return this.enqueue(() => loadFocusSchedules(this.dir));
  }

  create(input: FocusScheduleCreateInput): Promise<FocusScheduleState> {
    return this.enqueue(async () => {
      const state = await loadFocusSchedules(this.dir);
      if (state.schedules.length >= MAX_SCHEDULES) {
        throw new Error(`日程最多 ${MAX_SCHEDULES} 条`);
      }
      const title = cleanText(input.title, MAX_TITLE);
      if (title.length === 0) throw new Error('日程标题不能为空');
      const startAt = finiteTimestamp(input.startAt);
      const endAt = finiteTimestamp(input.endAt);
      if (startAt === null || endAt === null) throw new Error('开始与结束时间不合法');
      assertRange(startAt, endAt);
      const now = this.clock.now();
      const schedule: FocusSchedule = {
        id: `focus_${randomUUID()}`,
        title,
        note: cleanText(input.note, MAX_NOTE),
        startAt,
        endAt,
        remind: input.remind === true,
        createdAt: now,
        updatedAt: now,
      };
      const next: FocusScheduleState = {
        version: 1,
        currentId: state.currentId,
        schedules: [...state.schedules, schedule].sort((a, b) => a.startAt - b.startAt),
      };
      await saveFocusSchedules(this.dir, next);
      return next;
    });
  }

  update(id: string, input: FocusScheduleUpdateInput): Promise<FocusScheduleState> {
    return this.enqueue(async () => {
      const state = await loadFocusSchedules(this.dir);
      const index = state.schedules.findIndex((schedule) => schedule.id === id);
      if (index < 0) throw new Error('找不到这条日程');
      const old = state.schedules[index];
      if (old === undefined) throw new Error('找不到这条日程');

      const title = input.title !== undefined ? cleanText(input.title, MAX_TITLE) : old.title;
      if (title.length === 0) throw new Error('日程标题不能为空');
      const startAt = input.startAt !== undefined ? finiteTimestamp(input.startAt) : old.startAt;
      const endAt = input.endAt !== undefined ? finiteTimestamp(input.endAt) : old.endAt;
      if (startAt === null || endAt === null) throw new Error('开始与结束时间不合法');
      assertRange(startAt, endAt);

      const updated: FocusSchedule = {
        ...old,
        title,
        note: input.note !== undefined ? cleanText(input.note, MAX_NOTE) : old.note,
        startAt,
        endAt,
        remind: input.remind !== undefined ? input.remind === true : old.remind,
        updatedAt: this.clock.now(),
      };
      const schedules = [...state.schedules];
      schedules[index] = updated;
      schedules.sort((a, b) => a.startAt - b.startAt);
      const next: FocusScheduleState = { ...state, schedules };
      await saveFocusSchedules(this.dir, next);
      return next;
    });
  }

  remove(id: string): Promise<FocusScheduleState> {
    return this.enqueue(async () => {
      const state = await loadFocusSchedules(this.dir);
      const schedules = state.schedules.filter((schedule) => schedule.id !== id);
      if (schedules.length === state.schedules.length) throw new Error('找不到这条日程');
      const next: FocusScheduleState = {
        version: 1,
        currentId: state.currentId === id ? null : state.currentId,
        schedules,
      };
      await saveFocusSchedules(this.dir, next);
      return next;
    });
  }

  setCurrent(id: string | null): Promise<FocusScheduleState> {
    return this.enqueue(async () => {
      const state = await loadFocusSchedules(this.dir);
      if (id !== null && !state.schedules.some((schedule) => schedule.id === id)) {
        throw new Error('找不到这条日程');
      }
      const next: FocusScheduleState = {
        version: 1,
        currentId: id,
        schedules: state.schedules,
      };
      await saveFocusSchedules(this.dir, next);
      return next;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
