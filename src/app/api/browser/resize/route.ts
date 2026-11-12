/**
 * 浏览器面板 —— 跟随面板尺寸调整远端视口
 *
 * `POST /api/browser/resize { width, height }`
 * 面板拖动、展开、全屏都会改变可用区域；把远端 viewport 调成实际尺寸，
 * 页面才会像真实浏览器窗口那样重排，而不是固定 1280×800 再留黑边。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isBrowserError, resizeViewport } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const width = Number(body['width']);
  const height = Number(body['height']);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return NextResponse.json({ error: '缺少宽高' }, { status: 400 });
  }

  try {
    const viewport = await resizeViewport(width, height);
    return NextResponse.json({ ok: true, ...viewport });
  } catch (err) {
    if (isBrowserError(err)) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === 'not_started' ? 409 : 400 },
      );
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '调整视口失败' }, { status: 500 });
  }
}
