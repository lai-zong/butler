/**
 * 浏览器面板 —— 让 AI 看当前页面
 *
 * `POST /api/browser/read`
 * 返回 { url, title, text, screenshot }
 *
 * ★ 页面内容是**不可信输入**：调用方（对话）必须按"外部数据"处理，
 *   现有的注入防护会把它包成数据块；这里只负责取，不做判断。
 */

import { NextResponse } from 'next/server';

import { readPage, isBrowserError } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  try {
    const page = await readPage();
    return NextResponse.json({ ok: true, ...page });
  } catch (err) {
    if (isBrowserError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_started' ? 409 : 500 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : '读取页面失败' }, { status: 500 });
  }
}
