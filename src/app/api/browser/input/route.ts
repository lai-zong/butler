/**
 * 浏览器面板 —— 输入转发
 *
 * `POST /api/browser/input`
 *   { type: 'mouse', action: 'down'|'up'|'move'|'wheel', x, y, button?, deltaX?, deltaY? }
 *   { type: 'text', text }
 *   { type: 'key', key }
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { applyInput, isBrowserError } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  try {
    await applyInput(body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isBrowserError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_started' ? 409 : 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '输入失败' }, { status: 500 });
  }
}
