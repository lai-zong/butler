/** 浏览器面板 —— 当前页面状态。`GET /api/browser/state` */

import { NextResponse } from 'next/server';

import { BrowserError, browserStatus, pageInfo } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const status = browserStatus();
  if (!status.running) return NextResponse.json({ ok: true, running: false, executable: null });
  try {
    const info = await pageInfo();
    return NextResponse.json({ ok: true, running: true, executable: status.executable, ...info });
  } catch (err) {
    if (err instanceof BrowserError) {
      return NextResponse.json({ ok: true, running: false, executable: null, error: err.message });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '读取页面状态失败' }, { status: 500 });
  }
}
