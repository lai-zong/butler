/**
 * 停止桌面桌宠进程。
 *
 * 只用于用户在“显示位置”切换、或明确要求停止时；不是聊天里的停止按钮。
 */

import { NextResponse } from 'next/server';

import { stopPet } from '@/app/server/petRuntime.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  try {
    const status = await stopPet();
    return NextResponse.json({ ok: true, status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
