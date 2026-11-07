/**
 * 用户任务文件存储。
 *
 * ★ 用配置文件而不是事件回放：
 *   任务是用户直接编辑的配置，修改/删除应当立即生效；
 *   事件流只负责运行记录（由服务层追加）。
 *
 * 文件写入使用临时文件 + rename，避免进程中断留下半个 JSON。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  UserTask,
  UserTaskKind,
  UserTaskModelChoice,
  UserTaskPermission,
  UserTaskRepeat,
  UserTaskSchedule,
  UserTaskStatus,
} from './types.js';

export const USER_TASKS_FILE = 'user-tasks.json';

interface UserTaskFile {
  readonly version: 1;
  readonly tasks: readonly UserTask[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeSchedule(raw: unknown): UserTaskSchedule | null {
  if (!isObject(raw)) return null;
  const repeat = raw['repeat'];
  if (repeat !== 'once' && repeat !== 'daily' && repeat !== 'weekly') return null;
  return {
    repeat: repeat as UserTaskRepeat,
    dueAt: numberOrNull(raw['dueAt']),
    timeOfDay: typeof raw['timeOfDay'] === 'string' ? raw['timeOfDay'] : null,
    weekday: typeof raw['weekday'] === 'number' && raw['weekday'] >= 0 && raw['weekday'] <= 6
      ? Math.round(raw['weekday'])
      : null,
  };
}

function normalizeModel(raw: unknown): UserTaskModelChoice | null {
  if (!isObject(raw)) return null;
  const profileId = str(raw['profileId']);
  const modelId = str(raw['modelId']);
  if (profileId.length === 0 || modelId.length === 0) return null;
  return { profileId, modelId, label: str(raw['label'], modelId) };
}

function normalizeTask(raw: unknown): UserTask | null {
  if (!isObject(raw)) return null;
  const id = str(raw['id']);
  const kind = raw['kind'];
  const title = str(raw['title']);
  if (id.length === 0 || (kind !== 'reminder' && kind !== 'work') || title.length === 0) {
    return null;
  }
  const schedule = normalizeSchedule(raw['schedule']);
  if (schedule === null) return null;
  const status = raw['status'];
  const normalizedStatus: UserTaskStatus =
    status === 'paused' || status === 'completed' ? status : 'active';
  const permission = raw['permission'];
  const normalizedPermission: UserTaskPermission =
    permission === 'read-only' || permission === 'full' ? permission : 'workspace';
  const lastOutcome = raw['lastOutcome'];
  return {
    id,
    kind: kind as UserTaskKind,
    title,
    note: str(raw['note']),
    schedule,
    status: normalizedStatus,
    nextRunAt: numberOrNull(raw['nextRunAt']),
    createdAt: numberOrNull(raw['createdAt']) ?? 0,
    updatedAt: numberOrNull(raw['updatedAt']) ?? 0,
    instruction: typeof raw['instruction'] === 'string' ? raw['instruction'] : null,
    workspace: typeof raw['workspace'] === 'string' ? raw['workspace'] : null,
    permission: normalizedPermission,
    model: normalizeModel(raw['model']),
    files: Array.isArray(raw['files'])
      ? raw['files'].filter((value): value is string => typeof value === 'string')
      : [],
    snoozeUntil: numberOrNull(raw['snoozeUntil']),
    completedAt: numberOrNull(raw['completedAt']),
    lastRunAt: numberOrNull(raw['lastRunAt']),
    lastOutcome:
      lastOutcome === 'succeeded' || lastOutcome === 'failed' || lastOutcome === 'skipped'
        ? lastOutcome
        : null,
    lastSummary: typeof raw['lastSummary'] === 'string' ? raw['lastSummary'] : null,
    lastError: typeof raw['lastError'] === 'string' ? raw['lastError'] : null,
  };
}

export async function loadUserTasks(dir: string): Promise<readonly UserTask[]> {
  try {
    const raw = JSON.parse(await readFile(join(dir, USER_TASKS_FILE), 'utf8')) as unknown;
    if (!isObject(raw) || !Array.isArray(raw['tasks'])) return [];
    return raw['tasks']
      .map(normalizeTask)
      .filter((task): task is UserTask => task !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function saveUserTasks(dir: string, tasks: readonly UserTask[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, USER_TASKS_FILE);
  const temp = `${target}.tmp`;
  const payload: UserTaskFile = { version: 1, tasks };
  await writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
  await rename(temp, target);
}
