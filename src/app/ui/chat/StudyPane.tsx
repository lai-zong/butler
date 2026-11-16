'use client';

/**
 * 学习右栏：当前会话的练习历史；手动入口和 AI 出题后的自动打开共用。
 *
 * ★ 题目来自现有 quiz.created 事件；出题仍由左侧 AI 对话触发。
 * ★ 批改、答案隔离沿用 QuizSection / /api/quiz/grade。
 */

import { Icon } from '../components/Icon';
import type { QuizItem, ToastMessage } from '../lib/types.js';
import { QuizSection } from './Quiz';

interface StudyPaneProps {
  readonly sessionId: string | null;
  readonly quizzes: readonly QuizItem[];
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}

export function StudyPane({
  sessionId,
  quizzes,
  notify,
}: StudyPaneProps): JSX.Element {
  const questionCount = quizzes.reduce((sum, quiz) => sum + quiz.questions.length, 0);
  // 最近生成的练习排在最前，方便先看刚出的一套。
  const ordered = [...quizzes].sort((a, b) => b.id - a.id);

  return (
    <div className="study-pane">
      <header className="study-head">
        <div className="study-head-main">
          <p className="study-overline">练习历史</p>
          <h2>
            <Icon name="book" size={17} />
            学习
          </h2>
          <p className="study-meta">
            {sessionId === null
              ? '还没开始对话'
              : questionCount > 0
                ? `${quizzes.length} 套 · ${questionCount} 题 · 最近在前`
                : '还没有练习记录'}
          </p>
        </div>

      </header>

      <div className="study-body">
        {sessionId === null || quizzes.length === 0 ? (
          <div className="study-empty">
            <span className="study-empty-icon">
              <Icon name="book" size={26} />
            </span>
            <h3>还没有练习记录</h3>
            <p>
              在左侧明确让 AI 出题，例如：“帮我出 3 道特征值题，一道选择、一道简答。”
              新练习会自动出现在这里；以后点「新建 → 学习」可以回看当前对话的全部题目和作答。
            </p>
            <ul>
              <li>选择题由服务端确定性判分</li>
              <li>简答和主观题由 AI 按评分标准批改</li>
              <li>答案不会提前出现在题目里</li>
            </ul>
          </div>
        ) : (
          <QuizSection sessionId={sessionId} quizzes={ordered} notify={notify} embedded />
        )}
      </div>
    </div>
  );
}
