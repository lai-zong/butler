/**
 * 桌宠读取“主界面正在执行的对话”。
 *
 * 只返回会话 id、开始时间与用户输入前 80 字；不返回 reasoning、工具或
 * 任何消息正文。桌宠用它在桌板里显示跳转提示，并让右键菜单打开那一条对话。
 */

import { NextResponse } from 'next/server';

import { listActiveTurns } from '@/app/server/activeTurns.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    active: listActiveTurns(),
  });
}
