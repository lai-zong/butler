/**
 * 会话人格正文的跨重启保存（sidecar）
 *
 * ★★ 为什么需要它：
 *   事件是唯一真相源，但 `session.settings` 事件**刻意只记人格摘要**
 *   （hash / 长度），不写正文 —— 避免把用户写的人格复制进每一轮日志。
 *   而 `SessionStore` 的会话状态只活在进程内存里，
 *   进程重启后人格正文会丢。
 *
 *   所以人格正文单独落一份 `session-settings.json`：
 *     · 事件：审计（哪一轮用了哪份人格，hash/长度）
 *     · sidecar：正文（跨重启恢复）
 *
 * ★ 它不是第二份“设置真相源”：
 *   reasoning / memoryMode 仍由 `session.settings` 事件重放；
 *   sidecar 只补事件里**刻意省略**的人格正文。
 *
 * ★ 文件缺失/损坏 → 返回空 map，不阻断启动。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SESSION_SETTINGS_FILE = 'session-settings.json';

interface PersistedPersona {
  readonly persona: string;
  readonly updatedAt: number;
}

interface PersistedSessionSettings {
  readonly version: 1;
  readonly sessions: Record<string, PersistedPersona>;
}

export function sessionSettingsPath(dir: string): string {
  return join(dir, SESSION_SETTINGS_FILE);
}

export async function loadSessionPersonas(dir: string): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  try {
    const raw = await readFile(sessionSettingsPath(dir), 'utf8');
    const parsed = JSON.parse(raw) as { sessions?: unknown } | null;
    const sessions =
      typeof parsed === 'object' && parsed !== null && typeof parsed.sessions === 'object' && parsed.sessions !== null
        ? (parsed.sessions as Record<string, unknown>)
        : {};
    for (const [id, value] of Object.entries(sessions)) {
      if (typeof value !== 'object' || value === null) continue;
      const persona = (value as { persona?: unknown }).persona;
      if (typeof persona === 'string') out.set(id, persona);
    }
  } catch {
    // 没有文件 / 文件损坏：按“没有人格正文”处理，不阻断启动。
  }
  return out;
}

async function readRecord(dir: string): Promise<Record<string, PersistedPersona>> {
  try {
    const raw = await readFile(sessionSettingsPath(dir), 'utf8');
    const parsed = JSON.parse(raw) as { sessions?: unknown } | null;
    const sessions =
      typeof parsed === 'object' && parsed !== null && typeof parsed.sessions === 'object' && parsed.sessions !== null
        ? (parsed.sessions as Record<string, unknown>)
        : {};
    const out: Record<string, PersistedPersona> = {};
    for (const [id, value] of Object.entries(sessions)) {
      if (typeof value !== 'object' || value === null) continue;
      const persona = (value as { persona?: unknown }).persona;
      if (typeof persona !== 'string') continue;
      const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
      out[id] = {
        persona,
        updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 保存一个会话的人格正文（空字符串表示清空）。
 *
 * ⚠️ 先写临时文件再 rename —— 与项目里其它 JSON 持久化一致：
 *    半截文件会让下次启动读到损坏数据。
 */
export async function saveSessionPersona(
  dir: string,
  sessionId: string,
  persona: string,
): Promise<void> {
  const sessions = await readRecord(dir);
  sessions[sessionId] = { persona, updatedAt: Date.now() };
  await mkdir(dir, { recursive: true });
  const target = sessionSettingsPath(dir);
  const temp = `${target}.${process.pid}.tmp`;
  const payload: PersistedSessionSettings = { version: 1, sessions };
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}
