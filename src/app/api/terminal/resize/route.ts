/**
 * 终端尺寸变化。POST { id, sessionId, cols, rows }
 *
 * ★ ConPTY 必须知道真实 cols/rows：PSReadLine 的折行、补全菜单、
 *   进度条都按这个尺寸算；不通知的话 xterm 和远端会各画各的。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { resizeTerminal, TerminalError } from '@/app/server/terminalSessions.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: unknown;
      sessionId?: unknown;
      cols?: unknown;
      rows?: unknown;
    };
    const id = typeof body.id === 'string' ? body.id : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const cols = Number(body.cols);
    const rows = Number(body.rows);
    if (id === '' || sessionId === '' || !Number.isFinite(cols) || !Number.isFinite(rows)) {
      return NextResponse.json({ error: '缺少 id/sessionId/cols/rows' }, { status: 400 });
    }
    resizeTerminal(id, sessionId, cols, rows);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '调整尺寸失败' },
      { status: err instanceof TerminalError ? 400 : 500 },
    );
  }
}
