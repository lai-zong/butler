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
 *      · `readQuizzes()` 返回 `QuizItem`（**无答案**）—— 给调用方
 *      · `readAnswerKey()` 返回 `QuizAnswerKey`（有答案）—— 只给批改逻辑
 *      两者是不同接口，"答案漏进调用方"写不出来。
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
  const options = Array.isArray(rawOptions)
    ? rawOptions.filter((o): o is string => typeof o === 'string' && o.length > 0)
    : [];
  const type =
    rec['type'] === 'short' || rec['type'] === 'essay' ? rec['type'] : 'choice';
  if (type === 'choice' && options.length < 2) return null;
  const rawPoints = rec['points'];
  const points =
    typeof rawPoints === 'number' && Number.isFinite(rawPoints) && rawPoints > 0
      ? Math.min(100, Math.round(rawPoints))
      : 1;
  return { id, stem, options: type === 'choice' ? options : [], type, points };
}

interface ParsedAnswer {
  readonly id: string;
  readonly correct?: string;
  readonly reference?: string;
  readonly rubric?: string;
  readonly explanation?: string;
  readonly points: number;
}

/** 解析 `quiz.created` 的 payload；**任一必需结构缺失就整体作废** */
function parseCreated(
  payload: unknown,
): { questions: QuizQuestion[]; answers: ParsedAnswer[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const rec = payload as Record<string, unknown>;

  const rawQuestions = rec['questions'];
  if (!Array.isArray(rawQuestions)) return null;
  const questions = rawQuestions
    .map(parseQuestion)
    .filter((q): q is QuizQuestion => q !== null);
  if (questions.length === 0) return null;

  const rawAnswers = rec['answers'];
  const answers: ParsedAnswer[] = [];
  if (Array.isArray(rawAnswers)) {
    for (const a of rawAnswers) {
      if (typeof a !== 'object' || a === null) continue;
      const r = a as Record<string, unknown>;
      const id = asText(r['id']);
      if (id.length === 0) continue;
      const correct = asText(r['correct']);
      const reference = asText(r['reference']);
      const rubric = asText(r['rubric']);
      const explanation = asText(r['explanation']);
      const rawPoints = r['points'];
      const points =
        typeof rawPoints === 'number' && Number.isFinite(rawPoints) && rawPoints > 0
          ? Math.min(100, Math.round(rawPoints))
          : 1;
      if (correct.length === 0 && reference.length === 0 && rubric.length === 0) continue;
      answers.push({
        id,
        points,
        ...(correct.length > 0 ? { correct } : {}),
        ...(reference.length > 0 ? { reference } : {}),
        ...(rubric.length > 0 ? { rubric } : {}),
        ...(explanation.length > 0 ? { explanation } : {}),
      });
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
    const score = typeof r['score'] === 'number' && Number.isFinite(r['score']) ? r['score'] : undefined;
    const maxScore =
      typeof r['maxScore'] === 'number' && Number.isFinite(r['maxScore']) ? r['maxScore'] : undefined;
    const feedback = asText(r['feedback']);
    const reference = asText(r['reference']);
    items.push({
      questionId,
      stem: asText(r['stem']),
      ...(picked.length > 0 ? { picked } : {}),
      ...(correct.length > 0 ? { correct } : {}),
      ...(score !== undefined ? { score } : {}),
      ...(maxScore !== undefined ? { maxScore } : {}),
      ...(feedback.length > 0 ? { feedback } : {}),
      ...(reference.length > 0 ? { reference } : {}),
      right: r['right'] === true,
    });
  }
  if (items.length === 0) return null;

  const score = items.reduce((sum, i) => sum + (i.score ?? (i.right ? (i.maxScore ?? 1) : 0)), 0);
  const maxScore = items.reduce((sum, i) => sum + (i.maxScore ?? 1), 0);
  return {
    total: items.length,
    right: items.filter((i) => i.right).length,
    items,
    score,
    maxScore,
  };
}

/**
 * 读出某会话的全部题（**不含答案**）。
 *
 * `id` 用 `quiz.created` 事件的 `seq`：事件日志全局单调递增 ⇒ 天然唯一。
 * 这样调用方不必依赖"第几轮/第几个产出物"这类当前架构并不明确的量。
 *
 * ★★ 一个必须分清的字段（曾经写错，见下方注释）：
 *
 *   · `SessionEvent.sessionId` = **事件日志**的 id
 *     （`EventLog` 构造时传入；`log.ts` 里 `sessionId: this.sessionId` 填的是它）
 *   · **聊天会话** id 在 `payload.taskId` 里
 *     （`orchestrator.ts` 传 `taskId: args.sessionId` 给 `runButler`）
 *
 *   ⚠️ 所以按 `e.sessionId` 过滤**永远查不到** —— 生产环境里所有事件共用
 *      同一个日志 id，与聊天会话 id 是两个不同的字符串。
 *      这个错误在单元测试里看不出来（测试里两者恰好传了同一个值），
 *      只有对着真实调用链才暴露。
 */
export function readQuizzes(log: EventLog, sessionId: string): readonly QuizItem[] {
  /** 取事件 payload 里的聊天会话 id */
  const chatSessionOf = (payload: unknown): string => {
    if (typeof payload !== 'object' || payload === null) return '';
    const v = (payload as Record<string, unknown>)['taskId'];
    return typeof v === 'string' ? v : '';
  };

  const created = log
    .byType('quiz.created')
    .filter((e) => chatSessionOf(e.payload) === sessionId)
    .slice()
    .sort((a, b) => a.seq - b.seq);

  // 批改结果按 quizId 归组（同一份题可能被批改多次，取最后一条）
  const gradedByQuiz = new Map<number, QuizGrade>();
  for (const e of log.byType('quiz.graded')) {
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
      // ⚠️ 不是 `e.sessionId`（那是日志 id）—— 回填入参里的聊天会话 id
      sessionId,
      questions: parsed.questions,
      // 答案卷不存在（如从脱敏备份导入）→ 明确标记不可批改
      gradable: parsed.answers.length > 0,
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
  /**
   * ⚠️ 会话归属看 `payload.taskId`，不是 `e.sessionId`（后者是日志 id）。
   *    `seq` 是全局唯一的，所以理论上只按 seq 就能定位；
   *    但仍校验会话归属 —— 防止跨会话拿到别人的答案表。
   */
  const event = log.byType('quiz.created').find((e) => {
    if (e.seq !== quizId) return false;
    const p = e.payload;
    if (typeof p !== 'object' || p === null) return false;
    return (p as Record<string, unknown>)['taskId'] === sessionId;
  });
  if (!event) return undefined;

  const parsed = parseCreated(event.payload);
  if (!parsed) return undefined;

  const correct = new Map<string, string>();
  const explanations = new Map<string, string>();
  const references = new Map<string, string>();
  const rubrics = new Map<string, string>();
  const points = new Map<string, number>();
  for (const a of parsed.answers) {
    if (a.correct !== undefined) correct.set(a.id, a.correct);
    if (a.explanation !== undefined) explanations.set(a.id, a.explanation);
    if (a.reference !== undefined) references.set(a.id, a.reference);
    if (a.rubric !== undefined) rubrics.set(a.id, a.rubric);
    points.set(a.id, a.points);
  }

  // 一题答案都没有 ⇒ 无法批改，当作不存在
  if (correct.size === 0 && references.size === 0) return undefined;

  return {
    id: event.seq,
    sessionId,
    questions: parsed.questions,
    correct,
    explanations,
    references,
    rubrics,
    points,
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
