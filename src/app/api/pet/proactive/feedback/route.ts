/**
 * 桌宠主动说话反馈。
 *
 * dismiss = 知道了（不额外记忆）
 * snooze  = 稍后（30 分钟内不再主动说）
 * mute    = 别再提醒（关闭 proactiveEnabled）
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { savePetConfig } from '@/app/server/petConfig.js';
import { withPetProactiveLock } from '@/app/server/petProactiveLock.js';
import { loadPetProactiveState, savePetProactiveState } from '@/app/server/petProactiveState.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SNOOZE_MS = 30 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

async function feedback(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = record(await req.json());
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const action = body['action'];
  if (action !== 'dismiss' && action !== 'snooze' && action !== 'mute') {
    return NextResponse.json({ error: 'action 只能是 dismiss / snooze / mute' }, { status: 400 });
  }

  if (action === 'mute') {
    const config = await savePetConfig({ proactiveEnabled: false });
    return NextResponse.json({ ok: true, proactiveEnabled: config.proactiveEnabled });
  }

  if (action === 'snooze') {
    const state = await loadPetProactiveState();
    await savePetProactiveState({
      ...state,
      suppressedUntil: Date.now() + SNOOZE_MS,
    });
    return NextResponse.json({ ok: true, snoozedUntil: Date.now() + SNOOZE_MS });
  }

  // dismiss: 已领取的事件已经记录，无需额外状态。
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return withPetProactiveLock(() => feedback(req));
}
