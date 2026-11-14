/**
 * 保存外部文本文件。PUT { handle, sessionId, text, etag }
 *
 * ★ 必须带 etag：文件被 AI/编辑器改过时返回 409，由界面决定覆盖还是刷新，
 *   不能悄悄把别人的修改冲掉。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { saveExternalText } from '@/app/server/externalFiles.js';
import { externalErrorResponse } from '@/app/server/externalFileHttp.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PUT(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      handle?: unknown;
      sessionId?: unknown;
      text?: unknown;
      etag?: unknown;
    };
    const handle = typeof body.handle === 'string' ? body.handle : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const etag = typeof body.etag === 'string' ? body.etag : '';
    if (handle === '' || sessionId === '' || etag === '') {
      return NextResponse.json({ error: '缺少 handle/sessionId/etag' }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...(await saveExternalText(handle, sessionId, text, etag)) });
  } catch (err) {
    return externalErrorResponse(err);
  }
}
