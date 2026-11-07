/**
 * 桌宠固定会话。
 *
 * 桌面 Tk 桌宠和 Web 悬浮桌宠共用这一条会话：
 *   - 优先使用 pet-config.sessionId；
 *   - 兼容迁移旧的 pet-state.sessionId；
 *   - 都没有时创建一条，并写回 pet-config。
 *
 * 这是服务端内部用的稳定会话入口，设置页不应该直接改。
 */

import { readFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import {
  loadPetConfig,
  petStatePath,
  savePetConfig,
} from '@/app/server/petConfig.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let creating: Promise<string> | null = null;

async function readLegacySessionId(): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(petStatePath(), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const id = (raw as Record<string, unknown>)['sessionId'];
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
  } catch {
    return null;
  }
}

async function resolveSessionId(): Promise<string> {
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;
  const config = await loadPetConfig();

  if (config.sessionId !== null && chat.getSession(config.sessionId) !== undefined) {
    return config.sessionId;
  }

  // 迁移旧桌宠本地状态里的 session；不覆盖已有有效配置。
  const legacy = await readLegacySessionId();
  if (legacy !== null && chat.getSession(legacy) !== undefined) {
    await savePetConfig({ sessionId: legacy });
    return legacy;
  }

  const session = chat.createSession();
  await rt.bootstrapped.log.flushPersistence().catch(() => undefined);
  await savePetConfig({ sessionId: session.id });
  return session.id;
}

export async function GET(): Promise<NextResponse> {
  if (creating === null) {
    creating = resolveSessionId().finally(() => {
      creating = null;
    });
  }
  try {
    const sessionId = await creating;
    return NextResponse.json({ ok: true, sessionId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
