/**
 * 确认队列的纯逻辑（不依赖 DOM，可直接单测）。
 *
 * ★ 语义（与后端契约一致）：
 *   · SSE 的 `approval` 事件**没有 timeoutMs**；这里也绝不读取它。
 *     旧事件即使多带了该字段，也会被忽略，不产生任何倒计时。
 *   · 队列只因用户明确“允许/拒绝”或本轮流结束而出队；页面关闭由后端清理本轮 pending。
 *   · 前端不做超时、不做自动拒绝、不设进度条。
 */

/** `approval` SSE 事件里界面需要的字段。 */
export interface ApprovalEventLike {
  readonly id: string;
  readonly toolName: string;
  readonly tier: string;
  readonly summary: string;
  readonly preview?: string;
}

/** 队列里的一项；刻意没有 timeoutMs / receivedAt 这类时间字段。 */
export interface ApprovalItem {
  readonly id: string;
  readonly toolName: string;
  readonly tier: string;
  readonly summary: string;
  readonly preview?: string;
}

/**
 * 事件 → 队列项。
 *
 * 只挑白名单字段：不把 timeoutMs 之类旧字段带进界面状态，
 * 避免以后又长出一个倒计时。
 */
export function approvalFromEvent(ev: ApprovalEventLike): ApprovalItem {
  return {
    id: ev.id,
    toolName: ev.toolName,
    tier: ev.tier,
    summary: ev.summary,
    ...(ev.preview !== undefined ? { preview: ev.preview } : {}),
  };
}

/** 追加到队尾；同一时刻只展示队首。 */
export function enqueueApproval(
  queue: readonly ApprovalItem[],
  item: ApprovalItem,
): readonly ApprovalItem[] {
  return [...queue, item];
}

/** 当前展示的确认请求；没有就是 null（不伪造空弹窗）。 */
export function currentApproval(
  queue: readonly ApprovalItem[],
): ApprovalItem | null {
  return queue[0] ?? null;
}

/** 用户答复后移出队首；队列为空时仍是空数组。 */
export function dequeueApproval(
  queue: readonly ApprovalItem[],
): readonly ApprovalItem[] {
  return queue.slice(1);
}

/**
 * 只移除指定 id 的确认请求。
 *
 * ★ 审批按钮带文字时，等待响应期间可能有新的 approval 事件入队；
 *   按 id 删除才能保证“只处理当前这张卡”，不会误删下一条。
 */
export function removeApproval(
  queue: readonly ApprovalItem[],
  id: string,
): readonly ApprovalItem[] {
  return queue.filter((item) => item.id !== id);
}
