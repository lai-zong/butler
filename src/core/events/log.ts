/**
 * 事件日志 —— append-only，带不变量校验。
 *
 * 设计依据：参赛方案 v6.5 § 4.1、§ 5.1
 *
 * 这个模块是整个系统的地基：检查点回退、审计日志、证据链、跨会话一致性
 * 全部建立在它之上。因此不变量校验不是"可选的防御性代码"，而是核心功能。
 */

import {
  EventInvariantError,
  type EventActor,
  type EventType,
  type RollbackTarget,
  type SessionEvent,
} from './types.js';

export interface AppendInput<T extends EventType = EventType, P = unknown> {
  readonly type: T;
  readonly payload: P;
  readonly actor: EventActor;
  readonly parentEventId?: string;
  readonly servantId?: string;
  readonly createdAt?: number;
  readonly id?: string;
}

export type EventListener = (event: SessionEvent) => void;

let idCounter = 0;
function defaultId(): string {
  idCounter += 1;
  return `evt_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * 单会话的事件日志。
 *
 * 不可变性：内部数组只追加、只截断（截断用于回退），单条事件永不修改。
 */
export class EventLog {
  private events: SessionEvent[] = [];
  private readonly listeners = new Set<EventListener>();

  constructor(readonly sessionId: string) {}

  get length(): number {
    return this.events.length;
  }

  /** 返回只读视图。调用方不应依赖其身份稳定。 */
  all(): readonly SessionEvent[] {
    return this.events;
  }

  last(): SessionEvent | undefined {
    return this.events[this.events.length - 1];
  }

  /** 下一个可用的 seq（从 1 开始）。 */
  nextSeq(): number {
    return this.events.length + 1;
  }

  findById(id: string): SessionEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** 截取 seq 区间 [from, to]，含两端。用于检查点与回退预览。 */
  range(from: number, to: number): readonly SessionEvent[] {
    return this.events.filter((e) => e.seq >= from && e.seq <= to);
  }

  byType(type: EventType): readonly SessionEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  /**
   * 追加一条事件。
   *
   * 违反以下任一条即抛 EventInvariantError：
   *   I1  seq 必须等于 nextSeq()（无空洞、单调）
   *   I2  parentEventId 必须存在且 seq 更小
   *   I3  parentEventId 不可跨 session（通过 findById 隐含保证）
   *   I4  actor === 'servant' 时 servantId 必填
   */
  append<T extends EventType, P>(input: AppendInput<T, P>): SessionEvent<T, P> {
    const seq = this.nextSeq();

    if (input.parentEventId !== undefined) {
      const parent = this.findById(input.parentEventId);
      if (!parent) {
        throw new EventInvariantError(
          `parentEventId "${input.parentEventId}" 在本会话中不存在（不可跨 session 引用）`,
          'PARENT_NOT_FOUND',
        );
      }
      if (parent.seq >= seq) {
        throw new EventInvariantError(
          `parentEventId 必须指向更早的事件：parent.seq=${parent.seq} >= seq=${seq}`,
          'PARENT_NOT_EARLIER',
        );
      }
    }

    if (input.actor === 'servant' && !input.servantId) {
      throw new EventInvariantError(
        "actor 为 'servant' 时必须提供 servantId",
        'SERVANT_ID_REQUIRED',
      );
    }

    const event: SessionEvent<T, P> = {
      id: input.id ?? defaultId(),
      sessionId: this.sessionId,
      seq,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt ?? Date.now(),
      actor: input.actor,
      ...(input.parentEventId !== undefined ? { parentEventId: input.parentEventId } : {}),
      ...(input.servantId !== undefined ? { servantId: input.servantId } : {}),
    };

    this.events.push(event as SessionEvent);
    this.emit(event as SessionEvent);
    return event;
  }

  /**
   * 批量追加，保证全部成功或全部不追加。
   *
   * 用途：一次推理往往同时产出多条事件（thought.done + plan.created 等），
   * 半途失败会留下不一致的中间态。
   */
  appendMany(inputs: readonly AppendInput[]): readonly SessionEvent[] {
    const snapshot = this.events.length;
    try {
      return inputs.map((i) => this.append(i));
    } catch (err) {
      this.events.length = snapshot;
      throw err;
    }
  }

  /**
   * 回退：截断到 target.seq（含），并返回被丢弃的事件。
   *
   * 注意语义 —— **截断不是删除**：调用方（CheckpointManager）负责把被丢弃的事件
   * 归档，以便"被取代"的产出物仍可查看（见 § 5.2）。
   */
  truncateTo(target: RollbackTarget): readonly SessionEvent[] {
    if (target.sessionId !== this.sessionId) {
      throw new EventInvariantError(
        `回退目标属于会话 ${target.sessionId}，当前日志是 ${this.sessionId}`,
        'CROSS_SESSION_PARENT',
      );
    }
    if (target.seq < 0 || target.seq > this.events.length) {
      throw new EventInvariantError(
        `回退目标 seq=${target.seq} 超出范围 [0, ${this.events.length}]`,
        'SEQ_GAP',
      );
    }
    const discarded = this.events.slice(target.seq);
    this.events = this.events.slice(0, target.seq);
    return discarded;
  }

  /** 订阅新事件。返回取消订阅函数。 */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: SessionEvent): void {
    for (const l of this.listeners) l(event);
  }
}
