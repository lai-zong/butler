/**
 * 浏览器面板 —— 读取页面选中文字
 *
 * `GET /api/browser/selection` → `{ok, text}`
 * 前端拿到后再写系统剪贴板（需要用户点击手势）。
 */

import { NextResponse } from 'next/server';

import { readSelection, isBrowserError } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const text = await readSelection();
    return NextResponse.json({ ok: true, text });
  } catch (err) {
    if (isBrowserError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_started' ? 409 : 500 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '读取选区失败' }, { status: 500 });
  }
}
