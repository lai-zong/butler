/**
 * 桌宠固定会话的服务端入口。
 *
 * 网页桌宠聊天与主动提醒共用同一条会话；主动提醒写入这里，
 * 下一轮桌宠聊天才能在历史里看到它。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getRuntime } from '@/app/runtime';
import {
  loadPetConfig,
  resolveDataDir,
  savePetConfig,
} from './petConfig.js';
import type { ChatSession, SessionStore } from '@/core/chat/types.js';

export interface PetSession {
  readonly sessionId: string;
  readonly chat: SessionStore;
}

const PET_SESSION_FILE = 'pet-session.json';

let creating: Promise<PetSession> | null = null;

function petSessionPath(): string {
  return join(resolveDataDir(), PET_SESSION_FILE);
}

interface PetSessionMarker {
  readonly sessionId: string;
  readonly retired: readonly string[];
}

/**
 * 专用会话标记。
 *
 * 不能把 `pet-config.sessionId` 或旧的 `pet-state.sessionId` 直接当桌宠会话：
 * 历史上它们可能指向普通对话，主动提醒一旦写进去就会污染普通任务对话。
 * 只有这个 sidecar 里的 id 才代表“这条会话确实是桌宠的”。
 */
async function readMarker(): Promise<PetSessionMarker> {
  try {
    const raw = JSON.parse(await readFile(petSessionPath(), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return { sessionId: '', retired: [] };
    const v = raw as Record<string, unknown>;
    const id = typeof v['sessionId'] === 'string' ? v['sessionId'].trim() : '';
    const retired = Array.isArray(v['retired'])
      ? v['retired'].filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    return { sessionId: id, retired };
  } catch {
    return { sessionId: '', retired: [] };
  }
}

export async function getMarkedPetSessionId(): Promise<string | null> {
  const marker = await readMarker();
  return marker.sessionId.length > 0 ? marker.sessionId : null;
}

async function writeMarker(sessionId: string, retired: readonly string[]): Promise<void> {
  const dir = resolveDataDir();
  await mkdir(dir, { recursive: true });
  const target = petSessionPath();
  const temp = `${target}.${process.pid}.tmp`;
  const uniqueRetired = [...new Set(retired.filter((id) => id !== sessionId))];
  await writeFile(
    temp,
    `${JSON.stringify({ version: 1, sessionId, retired: uniqueRetired }, null, 2)}\n`,
    'utf8',
  );
  await rename(temp, target);
}

async function resolvePetSession(): Promise<PetSession> {
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;
  const marker = await readMarker();
  const marked = marker.sessionId.length > 0 ? marker.sessionId : null;

  if (marked !== null && chat.getSession(marked) !== undefined) {
    const config = await loadPetConfig();
    if (config.sessionId !== marked) await savePetConfig({ sessionId: marked });
    return { sessionId: marked, chat };
  }

  // 没有专用标记时创建一条新会话，绝不把普通对话直接升级为桌宠会话。
  // 旧版 pet-state 的 session 只作为历史数据保留，不再自动收养。
  const session = chat.createSession();
  const retired = [
    ...marker.retired,
    ...(marked !== null ? [marked] : []),
  ];
  await rt.bootstrapped.log.flushPersistence().catch(() => undefined);
  await writeMarker(session.id, retired);
  await savePetConfig({ sessionId: session.id });
  return { sessionId: session.id, chat };
}

/** 获取或创建桌宠固定会话；并发调用共享同一次创建。 */
export async function getPetSession(): Promise<PetSession> {
  if (creating === null) {
    creating = resolvePetSession().finally(() => {
      creating = null;
    });
  }
  return creating;
}

/** 侧栏可见会话：包含当前桌宠会话，但隐藏已退役的旧会话。 */
export async function sidebarSessions(chat: SessionStore): Promise<readonly ChatSession[]> {
  const marker = await readMarker();
  const hidden = new Set(marker.retired);
  return chat.listSessions().filter((s) => !hidden.has(s.id));
}

/**
 * 普通对话可见的会话。
 *
 * 桌宠会话不能成为“最近会话”的默认落点，也不能被新对话草稿复用；
 * 但它可以出现在侧栏的“桌宠”分区里（见 sidebarSessions）。
 */
export async function normalSessions(chat: SessionStore): Promise<readonly ChatSession[]> {
  const marker = await readMarker();
  const hidden = new Set([marker.sessionId, ...marker.retired]);
  return chat.listSessions().filter((s) => !hidden.has(s.id));
}

/** 隐藏一个旧会话；只用于桌宠迁移/清理，不暴露普通 UI。 */
export async function retireSession(sessionId: string): Promise<void> {
  if (sessionId.trim().length === 0) return;
  const marker = await readMarker();
  if (marker.retired.includes(sessionId) || marker.sessionId === sessionId) return;
  await writeMarker(marker.sessionId, [...marker.retired, sessionId]);
}

/** 无显式 sessionId 时的默认会话：只从普通会话里选。 */
export async function latestNormalSessionOrCreate(chat: SessionStore): Promise<ChatSession> {
  const list = await normalSessions(chat);
  return list[0] ?? chat.createSession();
}
