/**
 * 浏览器面板 —— 地址栏 / 搜索框
 *
 * `POST /api/browser/navigate { input }`
 * 输入网址就跳转，输入关键词就走搜索引擎（默认 Bing，可用 BUTLER_SEARCH_ENGINE=baidu 切换）。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { BrowserError, navigate } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { input?: unknown };
  try {
    body = (await req.json()) as { input?: unknown };
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const input = typeof body.input === 'string' ? body.input : '';
  if (input.trim().length === 0) return NextResponse.json({ error: '地址不能为空' }, { status: 400 });

  try {
    const result = await navigate(input);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof BrowserError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_started' ? 409 : 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '导航失败' }, { status: 500 });
  }
}
