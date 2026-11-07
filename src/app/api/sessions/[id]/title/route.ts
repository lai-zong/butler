/**
 * 懒生成会话短标题（B 方案）。
 *
 * 前端在打开旧会话、或第一轮结束后调用；生成失败时保持第一句话兜底，
 * 不阻塞聊天，也不把失败写成“已生成”。
 */

import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { dataDirOf } from '@/app/server/sessionScope.js';
import { readSessionDisplay, patchSessionDisplay } from '@/app/server/sessionDisplayStore.js';
import { generateSessionTitle } from '@/app/server/sessionTitleGenerator.js';
import { sessionTitle } from '@/app/server/uiData.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(_req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;
  const session = chat.getSession(id);
  if (session === undefined) {
    return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
  }

  const dir = dataDirOf(rt);
  const existing = await readSessionDisplay(dir, id);
  if (typeof existing.title === 'string' && existing.title.length > 0) {
    return NextResponse.json({ ok: true, title: existing.title, generated: true });
  }

  const messages = chat.messagesOf(id);
  const firstUser = messages.find((m) => m.role === 'user');
  const firstAssistant = messages.find((m) => m.role === 'butler');
  if (firstUser === undefined) {
    return NextResponse.json(
      { ok: false, generated: false, title: sessionTitle(session, messages) },
      { status: 400 },
    );
  }

  const generated = await generateSessionTitle(rt.model, {
    userText: firstUser.text,
    assistantText: firstAssistant?.text ?? '',
  });
  if (generated === null) {
    return NextResponse.json({
      ok: true,
      generated: false,
      title: sessionTitle(session, messages),
    });
  }

  await patchSessionDisplay(dir, id, {
    title: generated,
    titleGeneratedAt: Date.now(),
  });
  return NextResponse.json({ ok: true, generated: true, title: generated });
}
