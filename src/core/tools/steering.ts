/**
 * 当前轮的中途消息（steering）。
 *
 * ★ 与普通消息队列的区别：
 *   · 普通队列在本轮结束后才发下一轮；
 *   · steering 在当前工具返回后、下一次模型调用前注入当前轮。
 *
 * ★ 审批取消：
 *   用户在审批 pending 时直接发消息，视为“取消本轮所有待确认操作”，
 *   同时把消息放进队列。工具得到 denied 结果后，剩余工具不再执行，
 *   下一轮模型看到“操作被取消 + 用户新消息”。
 *
 * ⚠️ 登记表必须挂在进程级 globalThis 上：
 *   Next.js 会把 /api/chat 与 /api/chat/steer 编进不同的 route chunk，
 *   模块级 Map 在两个 chunk 里可能各有一份。
 */

export interface TurnSteeringOptions {
  /** 取消本 asker 当前所有 pending；返回取消数量。 */
  readonly cancelApprovals?: () => number;
  /** 消息被接收时调用（持久化 + SSE 通知）。 */
  readonly onMessage?: (text: string) => void;
}

interface SteeringEntry {
  readonly queue: string[];
  cancelRemainingTools: boolean;
  readonly cancelApprovals?: () => number;
  readonly onMessage?: (text: string) => void;
}

interface SteeringGlobal {
  __butlerTurnSteering?: Map<string, SteeringEntry>;
}

function steeringMap(): Map<string, SteeringEntry> {
  const scope = globalThis as typeof globalThis & SteeringGlobal;
  const existing = scope.__butlerTurnSteering;
  if (existing !== undefined) return existing;
  const created = new Map<string, SteeringEntry>();
  scope.__butlerTurnSteering = created;
  return created;
}

/** 登记当前轮；返回清理函数，必须在该轮 finally 调用。 */
export function beginTurnSteering(
  sessionId: string,
  options: TurnSteeringOptions = {},
): () => void {
  const entry: SteeringEntry = {
    queue: [],
    cancelRemainingTools: false,
    ...(options.cancelApprovals !== undefined
      ? { cancelApprovals: options.cancelApprovals }
      : {}),
    ...(options.onMessage !== undefined ? { onMessage: options.onMessage } : {}),
  };
  steeringMap().set(sessionId, entry);
  return () => {
    if (steeringMap().get(sessionId) === entry) steeringMap().delete(sessionId);
  };
}

export interface SteerResult {
  readonly ok: boolean;
  readonly cancelled: number;
  readonly queued: boolean;
}

/**
 * 接收一条中途消息。
 * 没有活跃轮次时返回 ok=false，调用方应退回普通 /api/chat。
 */
export function steerTurn(
  sessionId: string,
  text: string,
  options: { readonly cancelApprovals?: boolean } = {},
): SteerResult {
  const entry = steeringMap().get(sessionId);
  const trimmed = text.trim();
  if (entry === undefined || trimmed.length === 0) {
    return { ok: false, cancelled: 0, queued: false };
  }

  // 先取消 pending，再入队；工具会以 denied 返回，随后进入下一次模型调用。
  let cancelled = 0;
  if (options.cancelApprovals === true) {
    entry.cancelRemainingTools = true;
    try {
      cancelled = entry.cancelApprovals?.() ?? 0;
    } catch {
      cancelled = 0;
    }
  }

  entry.queue.push(trimmed);
  try {
    entry.onMessage?.(trimmed);
  } catch {
    // 持久化/SSE 通知失败不能丢这条已经接收的消息
  }
  return { ok: true, cancelled, queued: true };
}

/** 取走当前已排队的消息（保持顺序）。 */
export function drainSteering(sessionId: string): readonly string[] {
  const entry = steeringMap().get(sessionId);
  if (entry === undefined || entry.queue.length === 0) return [];
  return entry.queue.splice(0, entry.queue.length);
}

/** 只取消本轮所有 pending approval（不追加消息）。 */
export function cancelTurnApprovals(sessionId: string): number {
  const entry = steeringMap().get(sessionId);
  if (entry === undefined) return 0;
  entry.cancelRemainingTools = true;
  try {
    return entry.cancelApprovals?.() ?? 0;
  } catch {
    return 0;
  }
}

/** 当前轮是否要求取消剩余工具调用。 */
export function shouldCancelRemainingTools(sessionId: string): boolean {
  return steeringMap().get(sessionId)?.cancelRemainingTools === true;
}

/** 已补完剩余工具的取消结果后清除标记。 */
export function clearCancelRemainingTools(sessionId: string): void {
  const entry = steeringMap().get(sessionId);
  if (entry !== undefined) entry.cancelRemainingTools = false;
}

/** 是否有活跃轮次（steer API 用来区分 409）。 */
export function hasActiveTurn(sessionId: string): boolean {
  return steeringMap().has(sessionId);
}
