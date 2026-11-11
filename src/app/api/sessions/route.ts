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
import { dataDirOf, scopeDefaultsOf } from '@/app/server/sessionScope.js';
import { loadSessionDisplays } from '@/app/server/sessionDisplayStore.js';
import {
  getMarkedPetSessionId,
  normalSessions,
  sidebarSessions,
} from '@/app/server/petSession.js';
import { toSessionDto } from '@/app/server/uiData.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;
  const scopeDefaults = scopeDefaultsOf(rt);
  const displays = await loadSessionDisplays(dataDirOf(rt));
  const petSessionId = await getMarkedPetSessionId();

  const sessions = (await sidebarSessions(chat))
    .map((s) => {
      const display = displays.get(s.id);
      return toSessionDto(s, chat.messagesOf(s.id), chat.verdictsOf(s.id), {
        scopeDefaults,
        isPet: s.id === petSessionId,
        ...(display !== undefined ? { display } : {}),
      });
    });

  return NextResponse.json({ ok: true, sessions });
}

export async function POST(): Promise<NextResponse> {
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;

  // 新对话只保留一个未发送草稿；已有空会话时直接复用，
  // 避免每次点击“新对话”都新建一个空会话并计入历史。
  // 桌宠会话不是普通草稿，不能复用。
  const draft = (await normalSessions(chat)).find((s) => chat.messagesOf(s.id).length === 0);
  const session = draft ?? chat.createSession();

  if (draft === undefined) {
    await rt.bootstrapped.log.flushPersistence().catch(() => undefined);
  }

  return NextResponse.json({
    ok: true,
    session: toSessionDto(session, [], [], { scopeDefaults: scopeDefaultsOf(rt) }),
  });
}
