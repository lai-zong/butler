/** 浏览器面板 —— 后退 / 前进 / 刷新 / 停止。`POST /api/browser/action { action }` */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { goBack, goForward, reload, stopLoading, isBrowserError } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const action = String(body.action ?? '');

  try {
    if (action === 'back') await goBack();
    else if (action === 'forward') await goForward();
    else if (action === 'reload') await reload();
    else if (action === 'stop') await stopLoading();
    else return NextResponse.json({ error: '未知动作' }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isBrowserError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_started' ? 409 : 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '操作失败' }, { status: 500 });
  }
}
