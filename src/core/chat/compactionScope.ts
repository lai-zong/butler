/**
 * 上下文压缩事件的会话隔离。
 *
 * EventLog 是整个运行时共享的一份（外层 sessionId 是 `s_...`，不是聊天会话），
 * 所以读取摘要时必须按 `chatSessionId` 过滤，不能取“全局最后一条”。
 * 旧事件没有 chatSessionId，视为没有可复用摘要。
 */

import type { SessionEvent } from '../events/types.js';

export interface PriorCompaction {
  readonly summaryText?: string;
  readonly throughMessageId?: string;
}

/** 取当前聊天会话最近一次成功落盘的压缩摘要。 */
export function latestCompactionForChat(
  events: readonly SessionEvent[],
  chatSessionId: string,
): PriorCompaction {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || event.type !== 'context.compacted') continue;
    const payload =
      typeof event.payload === 'object' && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    if (payload['chatSessionId'] !== chatSessionId) continue;
    const summaryText =
      typeof payload['summaryText'] === 'string' ? payload['summaryText'] : undefined;
    const throughMessageId =
      typeof payload['throughMessageId'] === 'string'
        ? payload['throughMessageId']
        : undefined;
    return {
      ...(summaryText !== undefined ? { summaryText } : {}),
      ...(throughMessageId !== undefined ? { throughMessageId } : {}),
    };
  }
  return {};
}
