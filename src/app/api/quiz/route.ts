/**
 * 做题端点 —— 让用户作答与批改（v8 批次A）。
 *
 * 设计依据：
 *   · 学习预设的两条路径
 *     —— 「直接批改」走**服务端确定性比对，零 LLM 调用**
 *   · 方案 D-23（客观判定不交给模型）、D-24（错题不喂 fitness 负反馈）
 *
 * ★ 两个用法：
 *   GET  /api/quiz?sessionId=xxx   → 该会话的题（**不含答案**）
 *   GET  /api/quiz                 → 全部会话的题（审计/调试用，同样不含答案）
 *   POST /api/quiz/grade           → 提交作答，确定性批改并落事件
 *
 * ⚠️ 答案只在 `quiz.created` 事件里（`.butler-data` 受保护）。
 *    本端点返回的类型（`QuizItem`）**没有答案字段** —— 见 `core/quiz/types.ts`。
 *    唯一会返回答案的时机是**用户提交之后**（批改结果里的 `correct`），
 *    那是正常的产品行为（像任何做题应用），不是泄漏。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { readQuizzes } from '@/core/quiz/read.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const log = rt.bootstrapped.log;

  const sessionId = req.nextUrl.searchParams.get('sessionId');

  if (sessionId !== null) {
    return NextResponse.json({ ok: true, quizzes: readQuizzes(log, sessionId) });
  }

  /**
   * 没给 sessionId → 全部会话的题。
   *
   * ⚠️ 这不构成越权：返回值里没有答案（`QuizItem` 类型就没有该字段），
   *    而题目本身在对话消息里本来就是明文可见的。
   */
  const sessions = new Set<string>();
  for (const e of log.byType('quiz.created')) {
    // ⚠️ e.sessionId 是事件日志 id，不是聊天会话 id；聊天会话在 payload.taskId。
    const payload = e.payload;
    const chatSessionId =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)['taskId']
        : undefined;
    if (typeof chatSessionId === 'string' && chatSessionId.length > 0) {
      sessions.add(chatSessionId);
    }
  }
  const quizzes = [...sessions].flatMap((s) => readQuizzes(log, s));

  return NextResponse.json({ ok: true, quizzes });
}
