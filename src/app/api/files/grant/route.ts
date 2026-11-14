/**
 * 把当前外部文件授权给本会话的 AI（读写）。
 *
 * POST /api/files/grant { handle, sessionId }
 *
 * ★ 授权是按文件、按会话的内存 allowlist；关闭文件/结束进程即失效。
 * ★ 受保护路径（.butler-data / config / .env.local）不允许授权。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DATA_DIR } from '@/app/runtime';
import {
  externalHandle,
  grantExternalPath,
  isGrantableExternalPath,
} from '@/app/server/externalFiles.js';
import { externalErrorResponse, externalProtectedPaths } from '@/app/server/externalFileHttp.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      handle?: unknown;
      sessionId?: unknown;
    };
    const handle = typeof body.handle === 'string' ? body.handle : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (handle === '' || sessionId === '') {
      return NextResponse.json({ error: '缺少 handle 或 sessionId' }, { status: 400 });
    }
    const record = externalHandle(handle, sessionId);
    if (!isGrantableExternalPath(record.path, externalProtectedPaths(DATA_DIR))) {
      return NextResponse.json({ error: '受保护路径不允许授权给 AI' }, { status: 403 });
    }
    grantExternalPath(sessionId, record.path);
    return NextResponse.json({ ok: true, path: record.path, mode: 'rw' });
  } catch (err) {
    return externalErrorResponse(err);
  }
}
