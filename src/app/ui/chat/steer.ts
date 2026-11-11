/**
 * 运行中发送消息（steering）的纯逻辑 —— 不依赖 DOM，可直接单测。
 *
 * ★ 契约（后端 /api/chat/steer）：
 *   · 普通运行中：{ sessionId, text }
 *   · 有 pending 审批时直接发消息：再加 cancelApprovals: true
 *   · 审批按钮（可带文字）：{ sessionId, approvalId, allow, text? }
 *   · 没有活跃轮次：HTTP 409 { code: 'no_active_turn' }
 *
 * ★ 为什么单独成模块：
 *   请求体、409 恢复、SSE 去重这三件事都是“错了也只表现为界面错乱”的
 *   逻辑；拆成纯函数才能在无 jsdom 的环境里覆盖。
 */

import { ApiError } from '../lib/api.js';
import type { LiveSteeringMessage } from '../lib/types.js';

export interface RunningSteerBody {
  readonly sessionId: string;
  readonly text: string;
  /** 只在本轮确实还有待确认操作时出现；值为 true。 */
  readonly cancelApprovals?: true;
}

export interface ApprovalSteerBody {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly allow: boolean;
  /** 只有输入框里确实有文字时才出现。 */
  readonly text?: string;
}

/**
 * 运行中发消息的请求体。
 *
 * `hasPendingApprovals` 为 true 时表示“这条消息视为取消本轮所有待确认操作”；
 * 没有审批时**不能**带这个字段，否则会无端打断正在跑的工具。
 */
export function runningSteerBody(
  sessionId: string,
  text: string,
  hasPendingApprovals: boolean,
): RunningSteerBody {
  return {
    sessionId,
    text: text.trim(),
    ...(hasPendingApprovals ? { cancelApprovals: true as const } : {}),
  };
}

/** 审批按钮的请求体；文字为空时省略 text（与契约一致）。 */
export function approvalSteerBody(
  sessionId: string,
  approvalId: string,
  allow: boolean,
  text: string,
): ApprovalSteerBody {
  const trimmed = text.trim();
  return {
    sessionId,
    approvalId,
    allow,
    ...(trimmed.length > 0 ? { text: trimmed } : {}),
  };
}

/** 409 且 code=no_active_turn：本轮在服务端已经结束。 */
export function isNoActiveTurnError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const data = err.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>)['code'] === 'no_active_turn'
  );
}

export interface SteerFailureRecovery {
  /** 放回输入框的文字；绝不丢用户刚输入的内容。 */
  readonly input: string;
  /**
   * 非 null 表示：等当前 SSE 收尾后，用普通 /api/chat 把这段文字发出去。
   * 只用于 no_active_turn（服务端已经没有活跃轮次，不能继续 steer）。
   */
  readonly resumeAfterTurn: string | null;
  /** 本轮已不存在，所有本地审批卡都必须清掉（服务端也已全部拒绝）。 */
  readonly clearApprovals: boolean;
}

/**
 * steer 失败后的恢复动作。
 *
 * ★ 为什么 409 要恢复输入：
 *   用户是在轮次刚结束的窗口里按了发送；消息没进服务端，不能静默丢掉。
 */
export function recoverFromSteerFailure(err: unknown, sentText: string): SteerFailureRecovery {
  const input = sentText.trim();
  if (isNoActiveTurnError(err)) {
    return { input, resumeAfterTurn: input, clearApprovals: true };
  }
  return { input, resumeAfterTurn: null, clearApprovals: false };
}

function nextSeq(messages: readonly LiveSteeringMessage[]): number {
  return (messages[messages.length - 1]?.seq ?? 0) + 1;
}

/** 乐观追加一条“等待当前步骤结束”的用户消息。 */
export function addPendingSteering(
  messages: readonly LiveSteeringMessage[],
  text: string,
): readonly LiveSteeringMessage[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return messages;
  return [...messages, { seq: nextSeq(messages), text: trimmed, delivered: false }];
}

/**
 * SSE `steering` 事件 → 确认最早一条同文本的乐观消息。
 *
 * · 找到未确认的同文本消息：只把它标成 delivered，不新增；
 * · 已经确认过同文本：完全忽略（服务端重复事件不会产生第二条）；
 * · 没有本地乐观消息（例如另一个页面发出）：作为已确认消息补进来。
 */
export function confirmSteering(
  messages: readonly LiveSteeringMessage[],
  text: string,
): readonly LiveSteeringMessage[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return messages;

  const index = messages.findIndex((m) => !m.delivered && m.text === trimmed);
  if (index >= 0) {
    const next = [...messages];
    const current = next[index];
    if (current === undefined) return messages;
    next[index] = { ...current, delivered: true };
    return next;
  }

  if (messages.some((m) => m.delivered && m.text === trimmed)) return messages;
  return [...messages, { seq: nextSeq(messages), text: trimmed, delivered: true }];
}

/** 请求失败时撤掉还没被服务端确认的乐观消息。 */
export function removePendingSteering(
  messages: readonly LiveSteeringMessage[],
  text: string,
): readonly LiveSteeringMessage[] {
  const trimmed = text.trim();
  const index = messages.findIndex((m) => !m.delivered && m.text === trimmed);
  if (index < 0) return messages;
  return messages.filter((_, i) => i !== index);
}

/**
 * 消息旁的短状态。
 *
 * ★ 不在 SSE 收尾时把状态改成 delivered：
 *   POST 可能同时返回 409（本轮刚结束），那条消息其实没被接收；
 *   若先改 delivered，失败路径就删不掉它，还会和新恢复的输入重复。
 *   因此“本轮已结束”只在渲染时用来显示“已发送”，数据本身保持真实。
 */
export function steeringStatusLabel(delivered: boolean, turnEnded: boolean): string {
  return delivered || turnEnded ? '已发送' : '等待当前步骤结束';
}
