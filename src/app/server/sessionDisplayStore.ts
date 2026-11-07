/**
 * 会话展示元数据 sidecar：生成标题与置顶状态。
 *
 * 这些字段不参与聊天/记忆/审计，不需要写入 events.jsonl：
 *   · title       —— 第一轮结束后由模型生成；失败时 UI 回退第一句话
 *   · pinnedAt    —— 时间模式置顶排序
 *   · pinnedWorkspace —— 工作区模式的置顶作用域
 *
 * 文件损坏/缺失一律按空处理，不阻断聊天。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SESSION_DISPLAY_FILE = 'session-display.json';

export interface SessionDisplay {
  readonly title?: string;
  readonly titleGeneratedAt?: number;
  readonly pinnedAt?: number | null;
  readonly pinnedWorkspace?: string | null;
}

interface PersistedDisplay {
  readonly version: 1;
  readonly sessions: Record<string, SessionDisplay>;
}

export function sessionDisplayPath(dir: string): string {
  return join(dir, SESSION_DISPLAY_FILE);
}

async function readAll(dir: string): Promise<Record<string, SessionDisplay>> {
  try {
    const raw = JSON.parse(await readFile(sessionDisplayPath(dir), 'utf8')) as {
      sessions?: unknown;
    } | null;
    if (typeof raw !== 'object' || raw === null || typeof raw.sessions !== 'object' || raw.sessions === null) {
      return {};
    }
    const out: Record<string, SessionDisplay> = {};
    for (const [id, value] of Object.entries(raw.sessions as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const title = typeof v['title'] === 'string' && v['title'].trim().length > 0
        ? v['title'].trim().slice(0, 80)
        : undefined;
      const titleGeneratedAt = typeof v['titleGeneratedAt'] === 'number'
        ? v['titleGeneratedAt']
        : undefined;
      const pinnedAt = typeof v['pinnedAt'] === 'number' ? v['pinnedAt'] : null;
      const pinnedWorkspace = typeof v['pinnedWorkspace'] === 'string'
        ? v['pinnedWorkspace']
        : null;
      out[id] = {
        ...(title !== undefined ? { title } : {}),
        ...(titleGeneratedAt !== undefined ? { titleGeneratedAt } : {}),
        ...(pinnedAt !== null ? { pinnedAt } : { pinnedAt: null }),
        ...(pinnedWorkspace !== null ? { pinnedWorkspace } : { pinnedWorkspace: null }),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadSessionDisplays(
  dir: string,
): Promise<ReadonlyMap<string, SessionDisplay>> {
  const all = await readAll(dir);
  return new Map(Object.entries(all));
}

export async function readSessionDisplay(
  dir: string,
  sessionId: string,
): Promise<SessionDisplay> {
  return (await readAll(dir))[sessionId] ?? {};
}

export async function patchSessionDisplay(
  dir: string,
  sessionId: string,
  patch: SessionDisplay,
): Promise<SessionDisplay> {
  const all = await readAll(dir);
  const next: SessionDisplay = { ...all[sessionId], ...patch };
  all[sessionId] = next;
  await mkdir(dir, { recursive: true });
  const target = sessionDisplayPath(dir);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload: PersistedDisplay = { version: 1, sessions: all };
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temp, target);
  return next;
}
