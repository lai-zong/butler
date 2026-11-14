/** Ctrl+C：没有真实 TTY，按“杀进程树 + 重启会话”处理。POST { id, sessionId } */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { interruptTerminal } from '@/app/server/terminalSessions.js';

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
    interruptTerminal(id, sessionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '中断失败' },
      { status: 400 },
    );
  }
}
