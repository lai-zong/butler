/**
 * 浏览器面板 —— 本地网关地址
 *
 * `GET /api/browser/gateway` → `{ok, url, token}`
 * UI 拿到后，输入与画面直连网关，绕开 Next dev 的每请求开销。
 */

import { NextResponse } from 'next/server';

import { ensureBrowserGateway } from '@/app/server/browserGateway.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const gateway = await ensureBrowserGateway();
    return NextResponse.json({ ok: true, ...gateway });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '网关启动失败' },
      { status: 500 },
    );
  }
}
