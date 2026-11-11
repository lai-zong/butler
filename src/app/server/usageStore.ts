/**
 * 使用节奏的本地存储。
 *
 * 与 events.jsonl 分开：这里只有页面 / 时间 / 活跃状态，没有任务内容，
 * 也不参与记忆、审查或导出。清除使用统计时只动 usage.jsonl。
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isUsagePage,
  type UsagePing,
  type UsageSettings,
} from '@/core/usage/aggregate.js';

export const USAGE_FILE = 'usage.jsonl';
export const USAGE_SETTINGS_FILE = 'usage-settings.json';

export function resolveUsageDir(): string {
  return process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
}

export function usagePath(dir = resolveUsageDir()): string {
  return join(dir, USAGE_FILE);
}

export function usageSettingsPath(dir = resolveUsageDir()): string {
  return join(dir, USAGE_SETTINGS_FILE);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 从磁盘读取；坏行忽略，不让一条损坏记录毁掉整页统计。 */
export async function loadUsagePings(dir = resolveUsageDir()): Promise<readonly UsagePing[]> {
  let raw: string;
  try {
    raw = await readFile(usagePath(dir), 'utf8');
  } catch {
    return [];
  }

  const out: UsagePing[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const p = record(parsed);
    if (typeof p['at'] !== 'number' || !Number.isFinite(p['at'])) continue;
    if (!isUsagePage(p['page'])) continue;
    const active = p['active'] !== false;
    const sessionId =
      typeof p['sessionId'] === 'string' && p['sessionId'].trim().length > 0
        ? p['sessionId'].trim().slice(0, 120)
        : undefined;
    out.push({
      at: p['at'],
      page: p['page'],
      active,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }
  return out;
}

/**
 * 上一次写入的 (目录, 页面, 分钟)。
 *
 * ★ 为什么需要它：前端心跳是 60 秒一次，但 React 严格模式、页面重挂载、
 *   两个标签页都会让同一分钟写入多条 —— 实测连发 20 次 ping 后
 *   "可见分钟数"直接涨到 20。这里按分钟去重，同一分钟只记一条。
 */
const lastPingKey = new Map<string, string>();

export async function appendUsagePing(
  ping: UsagePing,
  dir = resolveUsageDir(),
): Promise<void> {
  const minute = Math.floor(ping.at / 60_000);
  const key = `${dir}|${ping.page}|${minute}|${ping.active ? 1 : 0}`;
  if (lastPingKey.get(dir) === key) return;
  lastPingKey.set(dir, key);

  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    at: ping.at,
    page: ping.page,
    active: ping.active,
    ...(ping.sessionId !== undefined ? { sessionId: ping.sessionId } : {}),
  });
  await appendFile(usagePath(dir), `${line}\n`, 'utf8');
}

export async function clearUsage(dir = resolveUsageDir()): Promise<void> {
  lastPingKey.delete(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(usagePath(dir), '', 'utf8');
}

export async function loadUsageSettings(dir = resolveUsageDir()): Promise<UsageSettings> {
  try {
    const raw = await readFile(usageSettingsPath(dir), 'utf8');
    const parsed = record(JSON.parse(raw) as unknown);
    return { enabled: parsed['enabled'] !== false };
  } catch {
    return { enabled: true };
  }
}

export async function saveUsageSettings(
  settings: UsageSettings,
  dir = resolveUsageDir(),
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = usageSettingsPath(dir);
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify({ enabled: settings.enabled }, null, 2), 'utf8');
  await rename(temp, target);
}
