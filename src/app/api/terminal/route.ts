/**
 * 新建终端。POST { sessionId }
 *
 * cwd 默认是本会话工作区；会话不存在时用默认工作区（workspaceScopeOf 已处理）。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { startTerminal, TerminalError } from '@/app/server/terminalSessions.js';
import { workspaceScopeOf } from '@/app/server/workspaceScope.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      sessionId?: unknown;
      cols?: unknown;
      rows?: unknown;
    };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (sessionId === '') {
      return NextResponse.json({ error: '缺少 sessionId' }, { status: 400 });
    }
    const scope = await workspaceScopeOf(sessionId);
    // 面板会把 xterm 的真实行列数带进来，避免 80×24 默认值在大面板上折错行。
    const cols = Number(body.cols);
    const rows = Number(body.rows);
    const info = await startTerminal(
      sessionId,
      scope.root,
      Number.isFinite(cols) ? cols : 80,
      Number.isFinite(rows) ? rows : 24,
    );
    return NextResponse.json({ ok: true, terminal: info });
  } catch (err) {
    const status = err instanceof TerminalError ? 400 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '终端启动失败' },
      { status },
    );
  }
}

