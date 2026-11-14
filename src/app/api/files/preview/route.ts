/**
 * 外部文件预览。
 *
 * · text   → { kind:'text', text, etag }
 * · office → { kind:'text'|'table', … }（复用零依赖 Office 解析）
 * · image/pdf → { kind, url }，字节走 /api/files/raw
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  externalHandle,
  externalOfficePreview,
  externalText,
} from '@/app/server/externalFiles.js';
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
    const record = externalHandle(handle, sessionId);
    if (record.kind === 'image' || record.kind === 'pdf') {
      const query = new URLSearchParams({ handle, sessionId });
      return NextResponse.json({
        ok: true,
        kind: record.kind,
        url: `/api/files/raw?${query.toString()}`,
      });
    }
    if (record.kind === 'office') {
      return NextResponse.json({ ok: true, ...(await externalOfficePreview(handle, sessionId)) });
    }
    const text = await externalText(handle, sessionId);
    return NextResponse.json({ ok: true, kind: 'text', ...text });
  } catch (err) {
    return externalErrorResponse(err);
  }
}
