/**
 * 浏览器面板 —— 下载列表
 *
 * `GET /api/browser/downloads`
 * 下载文件固定落在 `<数据目录>/browser-downloads`，不散落到用户的"下载"文件夹。
 */

import { NextResponse } from 'next/server';

import { listDownloads, isBrowserError } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const items = await listDownloads();
    return NextResponse.json({ ok: true, items });
  } catch (err) {
    if (isBrowserError(err)) {
      return NextResponse.json({ ok: true, items: [], code: err.code });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '读取下载列表失败' }, { status: 500 });
  }
}
