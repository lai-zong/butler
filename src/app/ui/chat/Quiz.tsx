'use client';

/**
 * 练习卡 —— 作答与批改
 *
 * ★ 批改由服务端的**确定性比对**完成，不调用模型（D-23）。
 *   界面上因此可以立即给出结果，而不是再等一次推理。
 *
 * ⚠️ 答案只在提交之后才下发 —— 题目列表本身没有答案字段。
 */

import { useState } from 'react';

import { Badge } from '../components/Common';
import { Icon } from '../components/Icon';
import { postJson, errorMessage } from '../lib/api.js';
import type { QuizGrade, QuizItem, ToastMessage } from '../lib/types.js';

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
            <Icon name="file" size={17} /> 练习
          </h2>
          <p>批改走确定性比对，不调用模型。答案只在你提交后显示。</p>
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

function QuizCard({
  quiz,
  sessionId,
  notify,
}: {
  readonly quiz: QuizItem;
  readonly sessionId: string;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}): JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grade, setGrade] = useState<QuizGrade | null>(quiz.grade ?? null);
  const [busy, setBusy] = useState(false);

  const answered = Object.keys(answers).length;
  const graded = grade !== null;
  const notGradable = quiz.gradable === false;

  async function submit(): Promise<void> {
    if (graded || busy || notGradable) {
      if (notGradable) notify('这份练习来自脱敏备份，答案未导出，无法批改', 'warning');
      return;
    }
    if (answered === 0) {
      notify('先选一个答案', 'warning');
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
      notify(`批改完成：答对 ${res.grade.right}/${res.grade.total}`, res.grade.right === res.grade.total ? 'success' : 'default');
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
            <strong>{grade.right}</strong>
            <span>/ {grade.total}</span>
          </span>
        )}
      </header>

      <ol className="quiz-questions">
        {quiz.questions.map((q, qi) => {
          const picked = answers[q.id];
          const result = grade?.items.find((i) => i.questionId === q.id);
          return (
            <li key={q.id} className="quiz-question">
              <p className="quiz-stem">
                <span className="quiz-index mono">{String(qi + 1).padStart(2, '0')}</span>
                {q.stem}
              </p>
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
            </li>
          );
        })}
      </ol>

      <footer className="quiz-foot">
        {graded ? (
          <span className="quiz-done">
            <Icon name="checkCircle" size={14} />
            已批改 · 答案来自服务端
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
