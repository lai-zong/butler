/**
 * 浏览器面板 —— 标签页
 *
 * `GET  /api/browser/tabs`                  列出标签（标题/URL 实时取）
 * `POST /api/browser/tabs {action,id?}`     action: new | activate | close
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { activateTab, BrowserError, closeTab, listTabs, newTab, isBrowserError } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUS: Record<BrowserError['code'], number> = {
  no_browser: 409,
  launch_failed: 500,
  timeout: 504,
  not_started: 409,
  cdp_error: 400,
};

export async function GET(): Promise<NextResponse> {
  try {
    const tabs = await listTabs();
    return NextResponse.json({ ok: true, tabs });
  } catch (err) {
    if (isBrowserError(err)) {
      return NextResponse.json({ ok: true, tabs: [], code: err.code }, { status: 200 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '读取标签失败' }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { action?: unknown; id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const action = String(body.action ?? '');
  const id = typeof body.id === 'string' ? body.id : '';

  try {
    if (action === 'new') {
      const created = await newTab();
      return NextResponse.json({ ok: true, id: created.id });
    }
    if (action === 'activate') {
      if (id.length === 0) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
      const ok = await activateTab(id);
      return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
    }
    if (action === 'close') {
      if (id.length === 0) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
      await closeTab(id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: '未知动作' }, { status: 400 });
  } catch (err) {
    if (isBrowserError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: STATUS[err.code] ?? 500 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '标签操作失败' }, { status: 500 });
  }
}
