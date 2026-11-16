/**
 * 做题与批改的类型（v8 批次A）。
 *
 * ★★ 这里有一条必须守住的边界：**答案不出现在任何"给调用方"的类型里**。
 *
 *   答案的存放位置是 `quiz.created` 事件（`.butler-data` 受保护，
 *   模型的文件工具读不到）。本文件里：
 *     · `QuizItem`      —— 给调用方（题目 + 已有批改结果，**无答案**）
 *     · `QuizAnswerKey` —— 只在服务端内部流转（**有答案**）
 *
 *   两者是不同接口，不是同一个接口加可选字段 ——
 *   "答案漏进调用方"因此在类型层面就写不出来。
 */

import type { QuizQuestion } from '../execution/types.js';

/** 一道题的批改结果 */
export interface QuizItemResult {
  readonly questionId: string;
  readonly stem: string;
  /** 用户选了什么（未作答为 undefined） */
  readonly picked?: string;
  /** 正确答案 —— ⚠️ 只在该题**已批改**时下发给调用方 */
  readonly correct?: string;
  readonly right: boolean;
  /** 主观题得分（choice 题也有，用于统一显示） */
  readonly score?: number;
  readonly maxScore?: number;
  readonly feedback?: string;
  readonly reference?: string;
}

/** 一次批改的完整结果 */
export interface QuizGrade {
  readonly total: number;
  readonly right: number;
  readonly items: readonly QuizItemResult[];
  /** 主观题参与后的总分；纯客观题时等于 right/total。 */
  readonly score?: number;
  readonly maxScore?: number;
}

/**
 * 一份题（给调用方）。
 *
 * `id` 是 `quiz.created` 事件的 `seq` —— 事件日志全局单调递增，
 * 因此它天然唯一，不需要新造 id，也不需要给产出物加字段。
 */
export interface QuizItem {
  readonly id: number;
  readonly sessionId: string;
  readonly questions: readonly QuizQuestion[];
  /** 已批改过则带上结果（未批改为 undefined） */
  readonly grade?: QuizGrade;
  /**
   * 是否还能批改。
   *
   * ★ v9：导出时答案卷不落文件；从脱敏备份导入的**未批改**练习
   *   会缺答案 → `false`。界面据此禁用提交并说明原因，
   *   而不是让用户做完才发现批改端点 404。
   */
  readonly gradable?: boolean;
}

/** 服务端内部的答案表（**绝不**直接返回给调用方）。 */
export interface QuizAnswerKey {
  readonly id: number;
  readonly sessionId: string;
  readonly questions: readonly QuizQuestion[];
  /** questionId → 正确选项字母 */
  readonly correct: ReadonlyMap<string, string>;
  /** questionId → 解析（可选） */
  readonly explanations: ReadonlyMap<string, string>;
  /** questionId → 主观题参考答案 */
  readonly references?: ReadonlyMap<string, string>;
  /** questionId → 主观题评分标准 */
  readonly rubrics?: ReadonlyMap<string, string>;
  /** questionId → 分值 */
  readonly points?: ReadonlyMap<string, number>;
}

/** 用户提交的作答：questionId → 选项字母 */
export type QuizSubmission = Readonly<Record<string, string>>;
