/**
 * 浏览器面板 —— 输入转发
 *
 * `POST /api/browser/input`
 *   { type: 'mouse', action: 'down'|'up'|'move'|'wheel', x, y, button? }
 *   { type: 'text', text }
 *   { type: 'key', key }
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { keyInput, mouseInput, isBrowserError } from '@/app/server/browserSession.js';

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
    const type = String(body['type'] ?? '');
    if (type === 'mouse') {
      const action = String(body['action'] ?? '');
      const x = Number(body['x']);
      const y = Number(body['y']);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return NextResponse.json({ error: '缺少坐标' }, { status: 400 });
      }
      const button = body['button'];
      await mouseInput({
        type: action === 'down' ? 'down' : action === 'up' ? 'up' : action === 'wheel' ? 'wheel' : 'move',
        x,
        y,
        ...(button === 'left' || button === 'right' || button === 'middle' ? { button } : {}),
      });
      return NextResponse.json({ ok: true });
    }
    if (type === 'text') {
      await keyInput({ type: 'text', text: String(body['text'] ?? '') });
      return NextResponse.json({ ok: true });
    }
    if (type === 'key') {
      await keyInput({ type: 'key', key: String(body['key'] ?? '') });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: '未知输入类型' }, { status: 400 });
  } catch (err) {
    if (isBrowserError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_started' ? 409 : 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '输入失败' }, { status: 500 });
  }
}
