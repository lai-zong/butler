/** 关闭终端并杀掉整棵进程树。POST { id, sessionId } */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { closeTerminal } from '@/app/server/terminalSessions.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: unknown; sessionId?: unknown };
    const id = typeof body.id === 'string' ? body.id : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (id === '' || sessionId === '') {
      return NextResponse.json({ error: '缺少 id 或 sessionId' }, { status: 400 });
    }
    closeTerminal(id, sessionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '关闭失败' },
      { status: 400 },
    );
  }
}
