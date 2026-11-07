/**
 * 懒生成会话短标题（B 方案）。
 *
 * 前端在打开旧会话、或第一轮结束后调用；生成失败时保持第一句话兜底，
 * 不阻塞聊天，也不把失败写成“已生成”。
 */

import { createHash } from 'node:crypto';

import type { NextRequest } from 'next/server';
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

function inputHash(text: string): string {
  return createHash('sha256')
    .update(text.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 24);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = record(await req.json());
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  if (typeof body['title'] !== 'string') {
    return NextResponse.json({ error: 'title 必须是字符串' }, { status: 400 });
  }
  const title = body['title'].replace(/\s+/g, ' ').trim();
  if (title.length === 0 || title.length > 60) {
    return NextResponse.json({ error: '标题长度需在 1–60 字之间' }, { status: 400 });
  }

  const rt = await getRuntime();
  const session = rt.bootstrapped.chat.getSession(id);
  if (session === undefined) {
    return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
  }
  const firstUser = rt.bootstrapped.chat.messagesOf(id).find((m) => m.role === 'user');
  await patchSessionDisplay(dataDirOf(rt), id, {
    title,
    titleManual: true,
    titleGeneratedAt: Date.now(),
    ...(firstUser !== undefined ? { titleInputHash: inputHash(firstUser.text) } : {}),
  });
  return NextResponse.json({ ok: true, title, manual: true });
}

export async function POST(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;
  const session = chat.getSession(id);
  if (session === undefined) {
    return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
  }

  const dir = dataDirOf(rt);
  const existing = await readSessionDisplay(dir, id);
  const messages = chat.messagesOf(id);
  const firstUser = messages.find((m) => m.role === 'user');
  if (firstUser === undefined) {
    return NextResponse.json(
      { ok: false, generated: false, title: sessionTitle(session, messages) },
      { status: 400 },
    );
  }

  const hash = inputHash(firstUser.text);
  if (typeof existing.title === 'string' && existing.title.length > 0) {
    // 手动标题永久优先；自动标题只有输入 hash 一致时才复用。
    if (existing.titleManual === true || existing.titleInputHash === hash) {
      return NextResponse.json({ ok: true, title: existing.title, generated: true });
    }
  }

  const generated = await generateSessionTitle(rt.model, {
    userText: firstUser.text,
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
    titleInputHash: hash,
    titleManual: false,
  });
  return NextResponse.json({ ok: true, generated: true, title: generated });
}
