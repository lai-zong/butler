/**
 * 会话列表端点
 *
 * `GET  /api/sessions` → 最近会话（按更新时间倒序，带摘要）
 * `POST /api/sessions` → 新建一个会话
 *
 * ★ 标题不在核心层存：由第一条用户消息推导（见 uiData.sessionTitle）。
 *   多存一份标题就多一个会漂移的真相源。
 */

import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { toSessionDto } from '@/app/server/uiData.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;

  const sessions = chat
    .listSessions()
    .map((s) => toSessionDto(s, chat.messagesOf(s.id), chat.verdictsOf(s.id)));

  return NextResponse.json({ ok: true, sessions });
}

export async function POST(): Promise<NextResponse> {
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;

  // 新对话只保留一个未发送草稿；已有空会话时直接复用，
  // 避免每次点击“新对话”都新建一个空会话并计入历史。
  const draft = chat.listSessions().find((s) => chat.messagesOf(s.id).length === 0);
  const session = draft ?? chat.createSession();

  if (draft === undefined) {
    await rt.bootstrapped.log.flushPersistence().catch(() => undefined);
  }

  return NextResponse.json({
    ok: true,
    session: toSessionDto(session, [], []),
  });
}
