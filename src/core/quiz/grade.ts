/**
 * 确定性批改（**零 LLM 调用**）。
 *
 * 依据：
 *   · 方案 §13.10「学习预设：两个按钮」——「直接批改」走**服务端确定性比对**，
 *     因为选择题的对错是**确定的事**，让 LLM 判 `2+2=4` 既是浪费也是风险
 *   · 方案 D-23 —— 同一原则（`verifyHardConstraints` 也是这么做的）
 *   · 方案 D-24 —— ⚠️ 批改结果**不能**直接当 `fitness` 的负反馈（语义陷阱）
 *
 * ★ 本模块是**纯函数**：不读事件、不写日志、不碰网络。
 *   事件读取在 `read.ts`，落事件在 API 层 —— 这样批改逻辑可以脱离环境单测。
 */

import type { QuizAnswerKey, QuizGrade, QuizItemResult, QuizSubmission } from './types.js';
import { toOptionLetter } from './letters.js';

/**
 * 批改一份题。
 *
 * ⚠️ 三个刻意的行为，都有理由：
 *
 *  1. **未作答的题算错**，但 `picked` 留空 ——
 *     不能把"没做"记成"选错了"，界面上要能区分这两件事。
 *  2. **无法归一化的作答算错**，且不猜测 ——
 *     如果用户提交了 "X" 或空串，宁可判错也不"尽量理解"。
 *  3. **答案表里没有的题直接判错**（而不是跳过）——
 *     跳题会让 `total` 变小，用户看到"3 题全对"其实有一题没判。
 */
export function gradeQuiz(args: {
  readonly answerKey: QuizAnswerKey;
  readonly submission: QuizSubmission;
}): QuizGrade {
  const items: QuizItemResult[] = [];

  for (const question of args.answerKey.questions) {
    const correct = args.answerKey.correct.get(question.id);
    const rawPicked = args.submission[question.id];

    // 作答归一化：允许小写、带前缀、数字下标（与模型侧同一套规则）
    const picked =
      rawPicked === undefined ? undefined : toOptionLetter(rawPicked, question.options);

    // 没有答案键的题 → 判错（不跳过，否则 total 会骗人）
    const right = correct !== undefined && picked !== undefined && picked === correct;

    items.push({
      questionId: question.id,
      stem: question.stem,
      ...(picked !== undefined ? { picked } : {}),
      ...(correct !== undefined ? { correct } : {}),
      right,
    });
  }

  return {
    total: items.length,
    right: items.filter((i) => i.right).length,
    items,
  };
}
