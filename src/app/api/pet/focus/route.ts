/**
 * 桌宠请求 Web 页面聚焦到某条会话。
 *
 * POST /api/pet/focus { sessionId }
 *   - 只登记请求，不打开浏览器；由已打开的 Web 页面轮询消费。
 * GET /api/pet/focus
 *   - 取走一条待处理请求（一次性、短 TTL）。
 */

import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { requestPetFocus, takePetFocus } from '@/app/server/petFocus.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, focus: takePetFocus() });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: '请求体格式不正确' }, { status: 400 });
  }
  const sessionId = (body as Record<string, unknown>)['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return NextResponse.json({ error: '缺少 sessionId' }, { status: 400 });
  }

  const rt = await getRuntime();
  if (rt.bootstrapped.chat.getSession(sessionId) === undefined) {
    return NextResponse.json({ error: '会话不存在' }, { status: 404 });
  }

  const focus = requestPetFocus(sessionId);
  return NextResponse.json({ ok: true, focus });
}
