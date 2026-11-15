/**
 * 专注日程的文件存储。
 *
 * ★ 用独立文件 `focus-schedules.json`，而不是事件流或 user-tasks.json：
 *   日程是用户直接编辑的配置，改完就应立即生效；它不参与 AI 执行，
 *   也没有「运行记录」需要回放。
 *
 * ★ 写入走临时文件 + rename，避免进程中断留下半个 JSON。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FocusSchedule, FocusScheduleState } from './types.js';

export const FOCUS_SCHEDULES_FILE = 'focus-schedules.json';

interface FocusScheduleFile {
  readonly version: 1;
  readonly currentId: string | null;
  readonly schedules: readonly FocusSchedule[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function normalizeSchedule(raw: unknown): FocusSchedule | null {
  if (!isObject(raw)) return null;
  const id = text(raw['id']).trim();
  const title = text(raw['title']).trim();
  const startAt = timestamp(raw['startAt']);
  const endAt = timestamp(raw['endAt']);
  if (id.length === 0 || title.length === 0 || startAt === null || endAt === null) return null;
  if (endAt <= startAt) return null;
  return {
    id,
    title,
    note: text(raw['note']),
    startAt,
    endAt,
    remind: raw['remind'] === true,
    createdAt: timestamp(raw['createdAt']) ?? startAt,
    updatedAt: timestamp(raw['updatedAt']) ?? startAt,
  };
}

function normalize(raw: unknown): FocusScheduleState {
  if (!isObject(raw) || !Array.isArray(raw['schedules'])) {
    return { version: 1, currentId: null, schedules: [] };
  }
  const schedules = raw['schedules']
    .map(normalizeSchedule)
    .filter((item): item is FocusSchedule => item !== null)
    .sort((a, b) => a.startAt - b.startAt);
  const currentId = text(raw['currentId']).trim();
  return {
    version: 1,
    currentId:
      currentId.length > 0 && schedules.some((schedule) => schedule.id === currentId)
        ? currentId
        : null,
    schedules,
  };
}

export async function loadFocusSchedules(dir: string): Promise<FocusScheduleState> {
  try {
    const raw = JSON.parse(await readFile(join(dir, FOCUS_SCHEDULES_FILE), 'utf8')) as unknown;
    return normalize(raw);
  } catch {
    return { version: 1, currentId: null, schedules: [] };
  }
}

export async function saveFocusSchedules(
  dir: string,
  state: FocusScheduleState,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, FOCUS_SCHEDULES_FILE);
  const temp = `${target}.tmp`;
  const payload: FocusScheduleFile = {
    version: 1,
    currentId: state.currentId,
    schedules: [...state.schedules].sort((a, b) => a.startAt - b.startAt),
  };
  await writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
  await rename(temp, target);
}
