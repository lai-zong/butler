/** 向终端写入（键盘输入）。POST { id, sessionId, data } */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { TerminalError, writeTerminal } from '@/app/server/terminalSessions.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: unknown;
      sessionId?: unknown;
      data?: unknown;
    };
    const id = typeof body.id === 'string' ? body.id : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const data = typeof body.data === 'string' ? body.data : '';
    if (id === '' || sessionId === '') {
      return NextResponse.json({ error: '缺少 id 或 sessionId' }, { status: 400 });
    }
    writeTerminal(id, sessionId, data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '写入失败' },
      { status: err instanceof TerminalError ? 400 : 500 },
    );
  }
}
