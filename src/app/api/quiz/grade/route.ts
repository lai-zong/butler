/**
 * 批改端点 —— 选择题确定性比对，简答/主观题按 rubric 交给 AI。
 *
 * 设计依据：
 *   · 客观判定不交给模型（方案 D-23）
 *   · 主观题没有唯一字符串答案，必须依据参考答案与评分标准批改
 *   · 方案 D-24：⚠️ 批改结果**不能**直接当 `fitness` 的负反馈（语义陷阱）
 *
 * ★ 三条不变量：
 *   ① 选择题不调模型；主观题一次提交合并成一次模型调用
 *   ② **批改结果必须落事件**（`quiz.graded`）—— 否则会话结束后的反思
 *      不知道"用户做过这套题、错在哪"，"后续对话知道做题结果"就断链了
 *   ③ **不写记忆** —— 批改是行为，不是记忆；记忆走反思链路
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { gradeQuiz } from '@/core/quiz/grade.js';
import { gradeSubjective } from '@/core/quiz/aiGrade.js';
import { readAnswerKey } from '@/core/quiz/read.js';
import type { QuizAnswerKey, QuizGrade, QuizItemResult, QuizSubmission } from '@/core/quiz/types.js';
import type { QuizQuestion } from '@/core/execution/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 一次提交的作答规模上限：防止超长/超多文本拖垮模型或事件日志。 */
const MAX_ANSWER_KEYS = 200;
const MAX_ANSWER_CHARS = 20_000;

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
  const answerEntries = Object.entries(answers);
  const answerChars = answerEntries.reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  if (answerEntries.length > MAX_ANSWER_KEYS || answerChars > MAX_ANSWER_CHARS) {
    return NextResponse.json(
      { error: `作答规模超限：最多 ${MAX_ANSWER_KEYS} 项 / ${MAX_ANSWER_CHARS} 字符` },
      { status: 413 },
    );
  }

  const rt = await getRuntime();
  const log = rt.bootstrapped.log;

  const answerKey = readAnswerKey(log, sessionId, quizId);
  if (!answerKey) {
    /**
     * ★ 区分两种"不能批改"：
     *   · 题目根本不存在 → 404（调用方参数错了）
     *   · 题目存在但答案卷缺失（从脱敏备份导入）→ 409 + 明确原因
     *     （让界面能说"这一轮不能批改"，而不是含糊的"找不到题目"）
     */
    const created = log.byType('quiz.created').find((e) => {
      if (e.seq !== quizId) return false;
      const p = e.payload;
      if (typeof p !== 'object' || p === null) return false;
      return (p as Record<string, unknown>)['taskId'] === sessionId;
    });
    if (created !== undefined) {
      return NextResponse.json(
        {
          error: '这份练习来自脱敏备份：答案没有随文件导出，因此无法再批改。',
          code: 'answers_unavailable',
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: `找不到可批改的题目（sessionId=${sessionId}, quizId=${quizId}）` },
      { status: 404 },
    );
  }

  function subjective(q: QuizQuestion): boolean {
    return q.type === 'short' || q.type === 'essay' || q.options.length === 0;
  }

  const choiceQuestions = answerKey.questions.filter((q) => !subjective(q));
  const choiceKey: QuizAnswerKey = {
    ...answerKey,
    questions: choiceQuestions,
  };
  const choiceGrade = gradeQuiz({ answerKey: choiceKey, submission: answers });
  const choiceById = new Map(choiceGrade.items.map((item) => [item.questionId, item]));

  const subjectiveQuestions = answerKey.questions.filter(subjective);
  let subjectiveItems = [] as readonly {
    readonly questionId: string;
    readonly right: boolean;
    readonly score: number;
    readonly maxScore: number;
    readonly feedback?: string;
    readonly reference?: string;
  }[];
  if (subjectiveQuestions.length > 0) {
    if (rt.model === null) {
      return NextResponse.json(
        { error: '主观题批改需要先配置对话模型', code: 'model_unavailable' },
        { status: 503 },
      );
    }
    try {
      const result = await gradeSubjective({
        model: rt.model,
        answerKey,
        submission: answers,
      });
      subjectiveItems = result?.items ?? [];
    } catch (err) {
      return NextResponse.json(
        {
          error: `主观题批改失败：${err instanceof Error ? err.message : String(err)}`,
          code: 'ai_grade_failed',
        },
        { status: 502 },
      );
    }
  }
  const subjectiveById = new Map(subjectiveItems.map((item) => [item.questionId, item]));

  const items: QuizItemResult[] = answerKey.questions.map((q) => {
    const points = Math.max(1, answerKey.points?.get(q.id) ?? q.points ?? 1);
    if (subjective(q)) {
      const got = subjectiveById.get(q.id);
      return {
        questionId: q.id,
        stem: q.stem,
        right: got?.right ?? false,
        score: got?.score ?? 0,
        maxScore: points,
        ...(got?.feedback !== undefined ? { feedback: got.feedback } : {}),
        ...(got?.reference !== undefined ? { reference: got.reference } : {}),
        picked: answers[q.id] ?? '',
      };
    }
    const got = choiceById.get(q.id);
    return {
      ...(got ?? { questionId: q.id, stem: q.stem, right: false }),
      score: got?.right === true ? points : 0,
      maxScore: points,
    };
  });
  const score = items.reduce((sum, item) => sum + (item.score ?? 0), 0);
  const maxScore = items.reduce((sum, item) => sum + (item.maxScore ?? 1), 0);
  const grade: QuizGrade = {
    total: items.length,
    right: items.filter((item) => item.right).length,
    items,
    score,
    maxScore,
  };

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
      score: grade.score,
      maxScore: grade.maxScore,
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
   *
   * ★ 不能吞掉失败：旧实现返回“批改完成”，但重启后成绩消失。
   *   这里把持久化失败如实告诉用户，让 ta 知道需要重试/检查磁盘。
   */
  try {
    await log.flushPersistence();
  } catch {
    return NextResponse.json(
      {
        error: '批改结果未能写入磁盘，请检查磁盘空间后重试',
        code: 'grade_persist_failed',
      },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true, grade });
}
