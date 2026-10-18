/**
 * 批改端点 —— 确定性比对，**零 LLM 调用**（v8 批次A）。
 *
 * 设计依据：
 *   · 方案 §13.10：「直接批改」走服务端确定性比对；「解析答案」才交给管家
 *   · 方案 D-23：客观判定不交给模型（与 `verifyHardConstraints` 同一原则）
 *   · 方案 D-24：⚠️ 批改结果**不能**直接当 `fitness` 的负反馈（语义陷阱）
 *
 * ★ 三条不变量：
 *   ① **不调模型** —— 选择题的对错是确定的事
 *   ② **批改结果必须落事件**（`quiz.graded`）—— 否则会话结束后的反思
 *      不知道"用户做过这套题、错在哪"，"后续对话知道做题结果"就断链了
 *   ③ **不写记忆** —— 批改是行为，不是记忆；记忆走反思链路
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { gradeQuiz } from '@/core/quiz/grade.js';
import { readAnswerKey } from '@/core/quiz/read.js';
import type { QuizSubmission } from '@/core/quiz/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 请求体形状（宽松解析，逐字段校验） */
interface GradeBody {
  readonly sessionId?: unknown;
  readonly quizId?: unknown;
  readonly answers?: unknown;
}

function asAnswers(raw: unknown): QuizSubmission | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: GradeBody;
  try {
    body = (await req.json()) as GradeBody;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const sessionId = body.sessionId;
  const quizId = body.quizId;
  const answers = asAnswers(body.answers);

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return NextResponse.json({ error: 'sessionId 必须是非空字符串' }, { status: 400 });
  }
  if (typeof quizId !== 'number' || !Number.isInteger(quizId) || quizId < 1) {
    return NextResponse.json({ error: 'quizId 必须是正整数（即 quiz.created 的 seq）' }, { status: 400 });
  }
  if (answers === undefined) {
    return NextResponse.json({ error: 'answers 必须是 { 题目id: 选项字母 } 形式的对象' }, { status: 400 });
  }

  const rt = await getRuntime();
  const log = rt.bootstrapped.log;

  const answerKey = readAnswerKey(log, sessionId, quizId);
  if (!answerKey) {
    // ⚠️ 区分"不存在"与"存在但无答案"对调用方没意义 —— 两者都不能批改
    return NextResponse.json(
      { error: `找不到可批改的题目（sessionId=${sessionId}, quizId=${quizId}）` },
      { status: 404 },
    );
  }

  const grade = gradeQuiz({ answerKey, submission: answers });

  /**
   * ★ 落事件。
   *
   * ⚠️ `actor: 'user'` —— 这是用户主动提交触发的，不是管家自己想做的。
   *    与 `observe.ts` 里那些用户侧事件同一口径。
   *
   * ⚠️ 事件里带 `correct`：批改完成后答案对用户就不再是秘密
   *    （这正是做题应用的行为）。但**落盘的位置仍是服务端事件**，
   *    不新增任何"把答案塞进消息"的路径。
   */
  log.append({
    type: 'quiz.graded',
    actor: 'user',
    payload: {
      quizId,
      total: grade.total,
      right: grade.right,
      items: grade.items,
      explanations: [...answerKey.explanations.entries()].map(([questionId, explanation]) => ({
        questionId,
        explanation,
      })),
    },
    createdAt: rt.clock.now(),
  });

  /**
   * ⚠️ 必须 flush：事件在内存里 append 完不等落盘，
   *    进程重启就丢。`/api/chat` 也是这个做法。
   */
  await log.flushPersistence().catch(() => undefined);

  return NextResponse.json({ ok: true, grade });
}
