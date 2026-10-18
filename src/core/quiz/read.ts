/**
 * 从事件流读出「题目」与「答案」（v8 批次A）。
 *
 * ★★ 两条纪律，都有事故依据：
 *
 *   ① **持久化边界的数据是不可信输入** —— 这里每个字段都做类型判定，
 *      不用 `as` 断言。项目有过一次真实事故：给产出物加必填字段后，
 *      旧落盘数据缺该字段，`as X` 只贴标签不检查，首页直接 500。
 *
 *   ② **答案与题目在返回类型上就分开**：
 *      · `readQuizzes()` 返回 `QuizItem`（**无答案**）—— 给前端
 *      · `readAnswerKey()` 返回 `QuizAnswerKey`（有答案）—— 只给批改逻辑
 *      两者是不同接口，"答案漏进前端"写不出来。
 */

import type { EventLog } from '../events/log.js';
import type { QuizQuestion } from '../execution/types.js';
import type { QuizAnswerKey, QuizGrade, QuizItem, QuizItemResult } from './types.js';

/** 取字符串字段（宽容：非字符串一律当空） */
function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 解析一道题；结构不对返回 null（宁可少一题，不要半条数据） */
function parseQuestion(raw: unknown): QuizQuestion | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const id = asText(rec['id']);
  const stem = asText(rec['stem']);
  const rawOptions = rec['options'];
  if (id.length === 0 || stem.length === 0) return null;
  if (!Array.isArray(rawOptions)) return null;
  const options = rawOptions.filter((o): o is string => typeof o === 'string' && o.length > 0);
  if (options.length < 2) return null;
  return { id, stem, options };
}

/** 解析 `quiz.created` 的 payload；**任一必需结构缺失就整体作废** */
function parseCreated(
  payload: unknown,
): { questions: QuizQuestion[]; answers: { id: string; correct: string; explanation?: string }[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const rec = payload as Record<string, unknown>;

  const rawQuestions = rec['questions'];
  if (!Array.isArray(rawQuestions)) return null;
  const questions = rawQuestions
    .map(parseQuestion)
    .filter((q): q is QuizQuestion => q !== null);
  if (questions.length === 0) return null;

  const rawAnswers = rec['answers'];
  const answers: { id: string; correct: string; explanation?: string }[] = [];
  if (Array.isArray(rawAnswers)) {
    for (const a of rawAnswers) {
      if (typeof a !== 'object' || a === null) continue;
      const r = a as Record<string, unknown>;
      const id = asText(r['id']);
      const correct = asText(r['correct']);
      if (id.length === 0 || correct.length === 0) continue;
      const explanation = asText(r['explanation']);
      answers.push(explanation.length > 0 ? { id, correct, explanation } : { id, correct });
    }
  }

  return { questions, answers };
}

/** 解析 `quiz.graded` 的 payload（宽容：结构不对就当没批改过） */
function parseGraded(payload: unknown): QuizGrade | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const rec = payload as Record<string, unknown>;
  const rawItems = rec['items'];
  if (!Array.isArray(rawItems)) return null;

  const items: QuizItemResult[] = [];
  for (const it of rawItems) {
    if (typeof it !== 'object' || it === null) continue;
    const r = it as Record<string, unknown>;
    const questionId = asText(r['questionId']);
    if (questionId.length === 0) continue;
    const picked = asText(r['picked']);
    const correct = asText(r['correct']);
    items.push({
      questionId,
      stem: asText(r['stem']),
      ...(picked.length > 0 ? { picked } : {}),
      ...(correct.length > 0 ? { correct } : {}),
      right: r['right'] === true,
    });
  }
  if (items.length === 0) return null;

  return {
    total: items.length,
    right: items.filter((i) => i.right).length,
    items,
  };
}

/**
 * 读出某会话的全部题（**不含答案**）。
 *
 * `id` 用 `quiz.created` 事件的 `seq`：事件日志全局单调递增 ⇒ 天然唯一。
 * 这样前端不必依赖"第几轮/第几个产出物"这类当前架构并不明确的量。
 */
export function readQuizzes(log: EventLog, sessionId: string): readonly QuizItem[] {
  const created = log
    .byType('quiz.created')
    .filter((e) => e.sessionId === sessionId)
    .slice()
    .sort((a, b) => a.seq - b.seq);

  // 批改结果按 quizId 归组（同一份题可能被批改多次，取最后一条）
  const gradedByQuiz = new Map<number, QuizGrade>();
  for (const e of log.byType('quiz.graded')) {
    if (e.sessionId !== sessionId) continue;
    const payload = e.payload;
    if (typeof payload !== 'object' || payload === null) continue;
    const quizId = (payload as Record<string, unknown>)['quizId'];
    if (typeof quizId !== 'number') continue;
    const grade = parseGraded(payload);
    if (grade) gradedByQuiz.set(quizId, grade);
  }

  const out: QuizItem[] = [];
  for (const e of created) {
    const parsed = parseCreated(e.payload);
    if (!parsed) continue;
    const grade = gradedByQuiz.get(e.seq);
    out.push({
      id: e.seq,
      sessionId: e.sessionId,
      questions: parsed.questions,
      ...(grade !== undefined ? { grade } : {}),
    });
  }
  return out;
}

/**
 * 读出某份题的**答案表**（服务端专用）。
 *
 * ⚠️ 只有这个函数返回带答案的结构 —— 调用方应当是批改逻辑，
 *    **不要把它的返回值直接放进 HTTP 响应**。
 */
export function readAnswerKey(
  log: EventLog,
  sessionId: string,
  quizId: number,
): QuizAnswerKey | undefined {
  const event = log
    .byType('quiz.created')
    .find((e) => e.sessionId === sessionId && e.seq === quizId);
  if (!event) return undefined;

  const parsed = parseCreated(event.payload);
  if (!parsed) return undefined;

  const correct = new Map<string, string>();
  const explanations = new Map<string, string>();
  for (const a of parsed.answers) {
    correct.set(a.id, a.correct);
    if (a.explanation !== undefined) explanations.set(a.id, a.explanation);
  }

  // 一题答案都没有 ⇒ 无法批改，当作不存在
  if (correct.size === 0) return undefined;

  return {
    id: event.seq,
    sessionId,
    questions: parsed.questions,
    correct,
    explanations,
  };
}

/**
 * 取某份题的解析（只在用户点「解析答案」时用）。
 *
 * ⚠️ 解析**不进批改结果** —— 它属于"讲解"，要用户主动要才给。
 */
export function readExplanations(
  key: QuizAnswerKey,
): readonly { questionId: string; explanation: string }[] {
  const out: { questionId: string; explanation: string }[] = [];
  for (const q of key.questions) {
    const explanation = key.explanations.get(q.id);
    if (explanation !== undefined) out.push({ questionId: q.id, explanation });
  }
  return out;
}
