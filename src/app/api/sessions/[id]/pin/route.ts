/**
 * 置顶 / 取消置顶。
 *
 * 时间模式使用 pinnedAt 排序；工作区模式只在该会话当前工作区展示置顶。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { dataDirOf, scopeDefaultsOf } from '@/app/server/sessionScope.js';
import { patchSessionDisplay } from '@/app/server/sessionDisplayStore.js';
import { sessionSettingsOf } from '@/core/chat/settings.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = record(await req.json());
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  if (typeof body['pinned'] !== 'boolean') {
    return NextResponse.json({ error: 'pinned 必须是布尔值' }, { status: 400 });
  }

  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;
  const session = chat.getSession(id);
  if (session === undefined) {
    return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
  }

  const settings = sessionSettingsOf(session);
  const workspace = settings.workspace ?? scopeDefaultsOf(rt).workspace;
  const display = await patchSessionDisplay(dataDirOf(rt), id, {
    pinnedAt: body['pinned'] === true ? Date.now() : null,
    pinnedWorkspace: body['pinned'] === true ? workspace : null,
  });
  return NextResponse.json({ ok: true, pinnedAt: display.pinnedAt ?? null, pinnedWorkspace: display.pinnedWorkspace ?? null });
}
