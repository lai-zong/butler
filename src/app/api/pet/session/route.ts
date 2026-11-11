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

import { NextResponse } from 'next/server';

import { getPetSession } from '@/app/server/petSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const { sessionId } = await getPetSession();
    return NextResponse.json({ ok: true, sessionId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
