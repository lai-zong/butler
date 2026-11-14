/**
 * 外部文件元信息。GET /api/files/meta?handle=…&sessionId=…
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { externalMeta } from '@/app/server/externalFiles.js';
import { externalErrorResponse, sessionIdOf } from '@/app/server/externalFileHttp.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionId = sessionIdOf(req);
  const handle = req.nextUrl.searchParams.get('handle') ?? '';
  if (sessionId === null || handle === '') {
    return NextResponse.json({ error: '缺少 handle 或 sessionId' }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, file: await externalMeta(handle, sessionId) });
  } catch (err) {
    return externalErrorResponse(err);
  }
}
