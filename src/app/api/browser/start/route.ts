/**
 * 浏览器面板 —— 启动（懒启动：第一次打开页签才调）
 *
 * `POST /api/browser/start`
 */

import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { BrowserError, browserStatus, ensureBrowser } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  try {
    const rt = await getRuntime();
    const result = await ensureBrowser(rt.dataDir);
    return NextResponse.json({
      ok: true,
      executable: result.executable,
      reused: result.reused,
      engine: 'chromium',
    });
  } catch (err) {
    if (err instanceof BrowserError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'no_browser' ? 409 : 500 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '启动浏览器失败', status: browserStatus() },
      { status: 500 },
    );
  }
}
