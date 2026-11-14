/**
 * 关闭外部文件：销毁句柄并撤销 AI 授权。POST { handle, sessionId }
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { closeExternalFile } from '@/app/server/externalFiles.js';
import { externalErrorResponse } from '@/app/server/externalFileHttp.js';

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
    await closeExternalFile(handle, sessionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return externalErrorResponse(err);
  }
}
