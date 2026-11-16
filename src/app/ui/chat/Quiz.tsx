'use client';

/**
 * 练习卡 —— 作答与批改
 *
 * ★ 选择题由服务端的确定性比对完成，不调用模型（D-23）。
 * ★ 简答/主观题由服务端按参考答案与 rubric 调用模型批改；客户端只拿到分数与反馈。
 *
 * ⚠️ 答案只在提交之后才下发 —— 题目列表本身没有答案、参考或 rubric。
 */

import { useState } from 'react';

import { Badge } from '../components/Common';
import { Icon } from '../components/Icon';
import { postJson, errorMessage } from '../lib/api.js';
import type { QuizGrade, QuizItem, QuizItemResult, QuizQuestion, ToastMessage } from '../lib/types.js';

interface GradeResponse {
  readonly ok: boolean;
  readonly grade: QuizGrade;
}

interface QuizSectionProps {
  readonly sessionId: string;
  readonly quizzes: readonly QuizItem[];
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  /** 作为卡片内容嵌入时，隐藏自己的标题与间隔 */
  readonly embedded?: boolean;
}

export function QuizSection({ sessionId, quizzes, notify, embedded = false }: QuizSectionProps): JSX.Element | null {
  if (quizzes.length === 0) return null;
  return (
    <section className={`quiz-section ${embedded ? 'is-embedded' : ''}`}>
      {!embedded && (
        <div className="quiz-section-head">
          <h2>
            <Icon name="book" size={17} /> 练习
          </h2>
          <p>选择题确定性判分；简答与主观题按评分标准交给 AI 批改。答案只在提交后显示。</p>
        </div>
      )}
      <div className="quiz-list">
        {quizzes.map((quiz) => (
          <QuizCard key={quiz.id} quiz={quiz} sessionId={sessionId} notify={notify} />
        ))}
      </div>
    </section>
  );
}

function isSubjective(question: QuizQuestion): boolean {
  return question.type === 'short' || question.type === 'essay' || question.options.length === 0;
}

function typeLabel(question: QuizQuestion): string {
  if (question.type === 'essay') return '主观题';
  if (question.type === 'short' || question.options.length === 0) return '简答题';
  return '选择题';
}

function resultScore(result: QuizItemResult | undefined): string | null {
  if (result?.score === undefined || result.maxScore === undefined) return null;
  return `${result.score} / ${result.maxScore}`;
}

function QuizCard({
  quiz,
  sessionId,
  notify,
}: {
  readonly quiz: QuizItem;
  readonly sessionId: string;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}): JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    // 已批改的练习重新打开时，把服务端记录下来的作答带回输入区；
    // 否则用户只能看到分数，看不到自己当时写了什么。
    const restored: Record<string, string> = {};
    for (const item of quiz.grade?.items ?? []) {
      if (item.picked !== undefined) restored[item.questionId] = item.picked;
    }
    return restored;
  });
  const [grade, setGrade] = useState<QuizGrade | null>(quiz.grade ?? null);
  const [busy, setBusy] = useState(false);

  const answered = quiz.questions.filter((q) => (answers[q.id] ?? '').trim().length > 0).length;
  const graded = grade !== null;
  const notGradable = quiz.gradable === false;
  const totalScore = grade?.score;
  const maxScore = grade?.maxScore;

  async function submit(): Promise<void> {
    if (graded || busy || notGradable) {
      if (notGradable) notify('这份练习来自脱敏备份，答案未导出，无法批改', 'warning');
      return;
    }
    if (answered === 0) {
      notify('先作答至少一道题', 'warning');
      return;
    }
    setBusy(true);
    try {
      const res = await postJson<GradeResponse>('/api/quiz/grade', {
        sessionId,
        quizId: quiz.id,
        answers,
      });
      setGrade(res.grade);
      const summary =
        res.grade.score !== undefined && res.grade.maxScore !== undefined
          ? `得分 ${res.grade.score}/${res.grade.maxScore}`
          : `答对 ${res.grade.right}/${res.grade.total}`;
      notify(`批改完成：${summary}`, res.grade.right === res.grade.total ? 'success' : 'default');
    } catch (err) {
      notify(errorMessage(err), 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`quiz ${graded ? 'is-graded' : ''}`}>
      <header className="quiz-head">
        <div>
          <Badge tone="accent">练习 · {quiz.questions.length} 题</Badge>
          <span className="quiz-id mono">#{quiz.id}</span>
        </div>
        {grade !== null && (
          <span className={`quiz-score ${grade.right === grade.total ? 'is-perfect' : ''}`}>
            {totalScore !== undefined && maxScore !== undefined ? (
              <>
                <strong>{totalScore}</strong>
                <span>/ {maxScore} 分</span>
              </>
            ) : (
              <>
                <strong>{grade.right}</strong>
                <span>/ {grade.total}</span>
              </>
            )}
          </span>
        )}
      </header>

      <ol className="quiz-questions">
        {quiz.questions.map((q, qi) => {
          const picked = answers[q.id] ?? '';
          const result = grade?.items.find((i) => i.questionId === q.id);
          const subjective = isSubjective(q);
          const score = resultScore(result);
          return (
            <li key={q.id} className={`quiz-question ${subjective ? 'is-subjective' : ''}`}>
              <p className="quiz-stem">
                <span className="quiz-index mono">{String(qi + 1).padStart(2, '0')}</span>
                <span>{q.stem}</span>
                <span className="quiz-type-label">{typeLabel(q)}</span>
                {q.points !== undefined ? <span className="quiz-points mono">{q.points} 分</span> : null}
              </p>

              {subjective ? (
                <textarea
                  className={`quiz-textarea ${graded ? 'is-graded' : ''}`}
                  value={picked}
                  disabled={graded}
                  rows={q.type === 'essay' ? 6 : 3}
                  placeholder={q.type === 'essay' ? '写下你的论述…' : '写下你的答案…'}
                  onChange={(event) =>
                    setAnswers((prev) => ({ ...prev, [q.id]: event.target.value }))
                  }
                />
              ) : (
                <div className="quiz-options">
                  {q.options.map((opt, oi) => {
                    const letter = String.fromCharCode(65 + oi);
                    const isPicked = picked === letter;
                    const isCorrect = result?.correct === letter;
                    const wrongPick = graded && isPicked && result?.right === false;
                    return (
                      <button
                        key={letter}
                        type="button"
                        className={[
                          'quiz-option',
                          isPicked && !graded ? 'is-picked' : '',
                          graded && isCorrect ? 'is-correct' : '',
                          wrongPick ? 'is-wrong' : '',
                        ]
                          .filter((x) => x.length > 0)
                          .join(' ')}
                        disabled={graded}
                        onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: letter }))}
                      >
                        <span className="quiz-letter mono">{letter}</span>
                        <span>{opt}</span>
                        {graded && isCorrect && <Icon name="check" size={14} className="quiz-mark" />}
                        {wrongPick && <Icon name="close" size={14} className="quiz-mark" />}
                      </button>
                    );
                  })}
                </div>
              )}

              {graded && (result !== undefined || score !== null) ? (
                <div className={`quiz-result ${result?.right ? 'is-right' : 'is-not-right'}`}>
                  <div className="quiz-result-head">
                    <Icon name={result?.right ? 'checkCircle' : 'info'} size={14} />
                    <strong>
                      {subjective
                        ? result?.right
                          ? '主观题判定通过'
                          : '主观题已批改'
                        : result?.right
                          ? '回答正确'
                          : '回答有误'}
                    </strong>
                    {score !== null ? <span className="mono">{score}</span> : null}
                  </div>
                  {!subjective && !result?.right && result?.correct !== undefined ? (
                    <p className="quiz-result-line">正确答案：{result.correct}</p>
                  ) : null}
                  {result?.feedback !== undefined && result.feedback.length > 0 ? (
                    <p className="quiz-result-line">{result.feedback}</p>
                  ) : null}
                  {result?.reference !== undefined && result.reference.length > 0 ? (
                    <details className="quiz-reference">
                      <summary>查看参考答案</summary>
                      <p>{result.reference}</p>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <footer className="quiz-foot">
        {graded ? (
          <span className="quiz-done">
            <Icon name="checkCircle" size={14} />
            已批改 · 选择题确定性判分，主观题 AI 批改
          </span>
        ) : notGradable ? (
          <span className="quiz-done">
            <Icon name="alert" size={14} />
            来自脱敏备份，答案未导出，无法批改
          </span>
        ) : (
          <>
            <span className="quiz-progress mono">
              {answered}/{quiz.questions.length}
            </span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={busy}>
              {busy ? '批改中…' : '提交作答'}
            </button>
          </>
        )}
      </footer>
    </article>
  );
}
