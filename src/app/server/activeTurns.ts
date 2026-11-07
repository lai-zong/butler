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
