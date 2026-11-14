/**
 * 外部文件原始字节（图片 / PDF 预览用）。
 */

import type { NextRequest } from 'next/server';

import { externalRaw } from '@/app/server/externalFiles.js';
import { externalErrorResponse, sessionIdOf } from '@/app/server/externalFileHttp.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const sessionId = sessionIdOf(req);
  const handle = req.nextUrl.searchParams.get('handle') ?? '';
  if (sessionId === null || handle === '') {
    return Response.json({ error: '缺少 handle 或 sessionId' }, { status: 400 });
  }
  try {
    const { buffer, mime, name } = await externalRaw(handle, sessionId);
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return externalErrorResponse(err);
  }
}
