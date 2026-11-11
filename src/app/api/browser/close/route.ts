/** 浏览器面板 —— 关闭浏览器进程。`POST /api/browser/close` */

import { NextResponse } from 'next/server';

import { closeBrowser } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  await closeBrowser();
  return NextResponse.json({ ok: true });
}
