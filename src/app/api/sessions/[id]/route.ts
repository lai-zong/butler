/**
 * 单个会话的完整快照
 *
 * `GET /api/sessions/[id]` → 会话 + 消息 + 复核结论 + 练习
 *
 * ★ 为什么不复用 `/api/chat` 的流式数据：
 *   流式只覆盖“这一次”，刷新后要能看到历史 —— 必须从事件重放出的
 *   SessionStore 读。两条路径最终读的是同一份状态。
 *
 * ⚠️ 这里的消息已包含 `agentTrace` / `servantReports`（持久化形状），
 *   界面据此在刷新后仍能展开“它当时调了什么工具”。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { toMessageDto, toSessionDto, toVerdictDto } from '@/app/server/uiData.js';
import { readQuizzes } from '@/core/quiz/read.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;
  const session = chat.getSession(id);

  if (session === undefined) {
    return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
  }

  const messages = chat.messagesOf(id);
  const verdicts = chat.verdictsOf(id);
  const quizzes = readQuizzes(rt.bootstrapped.log, id);

  return NextResponse.json({
    ok: true,
    session: toSessionDto(session, messages, verdicts),
    messages: messages.map(toMessageDto),
    verdicts: verdicts.map(toVerdictDto),
    quizzes,
  });
}
