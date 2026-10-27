/**
 * 每日日记 —— 由当日原始对话派生、可重放、可查看的经历摘要。
 *
 * ★ 日记不是记忆节点，也不是新的真相源。
 *   真相源仍是原始消息与事件；日记只是当天的叙述性摘要，
 *   记忆节点从日记中提取，并必须回指到原始消息。
 *
 * ★ 每个作用域每天最多一篇。作用域当前用 session 标识；
 *   人格/群聊隔离在接入会话元数据后扩展，不在这里硬编码领域。
 */

import type { MemoryKind } from '../memory/types.js';

/** 日记只提炼可长期复用的三类语义，不直接产生 summary 或硬约束。 */
export type DiaryItemKind = Extract<MemoryKind, 'fact' | 'preference' | 'principle'>;

export interface DiaryDayWindow {
  /** 本地日界（04:00）后的日期键，YYYY-MM-DD */
  readonly dayKey: string;
  /** 窗口起点（本地 04:00） */
  readonly startAt: number;
  /** 窗口终点（次日本地 04:00） */
  readonly endAt: number;
}

export interface DiarySourceMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'butler' | 'servant' | 'system' | 'tool';
  readonly text: string;
  readonly createdAt: number;
}

export interface DiaryExtractedItem {
  /** 稳定 id：diary_<diaryId>_item_<n> */
  readonly id: string;
  readonly kind: DiaryItemKind;
  readonly content: string;
  readonly confidence: number;
  /** 原始消息 id；必须能在当天的 sourceMessageIds 中找到 */
  readonly evidence: readonly string[];
  readonly rationale: string;
  readonly principle?: {
    readonly condition: string;
    readonly action: string;
  };
}

export interface DiaryEntry {
  readonly id: string;
  /** 作用域键，当前为 session:<sessionId> */
  readonly scopeId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly dayKey: string;
  readonly startAt: number;
  readonly endAt: number;
  /** 当天日记正文 */
  readonly content: string;
  readonly items: readonly DiaryExtractedItem[];
  /** 当天参与生成的消息 id（按时间排序） */
  readonly sourceMessageIds: readonly string[];
  readonly model: string;
  readonly promptVersion: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly createdAt: number;
}
