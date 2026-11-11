/**
 * 正在执行的对话轮次（进程内、只读投影）。
 *
 * 桌宠需要知道“主界面是否有别的对话正在执行”，并在点击时跳到对应会话。
 * `activeTurns` 计数器只能回答“有没有”，不能回答“是哪一条”，所以这里
 * 为每一轮登记一个短生命周期条目：SSE 流开始时写入，finally 中移除。
 *
 * ★ 这是展示用的投影，不参与运行时判断；进程重启后自然清空。
 */

export interface ActiveTurn {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly text: string;
}

let nextId = 1;
const active = new Map<number, ActiveTurn>();

/** 登记一轮；返回的函数必须在该轮 finally 中调用。 */
export function trackActiveTurn(turn: {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly text: string;
}): () => void {
  const id = nextId;
  nextId += 1;
  active.set(id, {
    sessionId: turn.sessionId,
    startedAt: turn.startedAt,
    text: turn.text.slice(0, 80),
  });
  return () => {
    active.delete(id);
  };
}

export function listActiveTurns(): readonly ActiveTurn[] {
  return [...active.values()];
}

// ═══════════════════════════════════════════════════════════
// 会话级互斥
// ═══════════════════════════════════════════════════════════

/**
 * 正在执行轮次的会话（**参与判定**，与上面的展示投影不同）。
 *
 * ★ 为什么必须有这把锁（实测过的真实后果）：
 *   双击发送、前端重试、两个标签页同时发 —— 同一个 session 会并行跑两轮
 *   `runTurn`，于是：steering 队列被后一轮覆盖、事件交错写入、
 *   两个 ToolFramework 各一份熔断计数（写次数上限失效）、模型被调两次。
 *
 * ⚠️ 与 `activeTurns` 计数器的区别：计数器只能说"全局有没有"，
 *    这把锁回答"**这个会话**有没有"，因此不会误伤并发使用不同会话的正常场景。
 */
const busySessions = new Set<string>();

/**
 * 尝试占用一个会话的执行权。
 *
 * 返回 `null` 表示该会话已有轮次在跑；返回函数用于释放（可重复调用）。
 */
export function acquireSessionTurn(sessionId: string): (() => void) | null {
  if (busySessions.has(sessionId)) return null;
  busySessions.add(sessionId);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    busySessions.delete(sessionId);
  };
}

/** 该会话是否正在执行（供 steer 与状态接口查询）。 */
export function isSessionBusy(sessionId: string): boolean {
  return busySessions.has(sessionId);
}
