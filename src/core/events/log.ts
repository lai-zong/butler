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

/**
 * 事件持久化端口。
 *
 * 设计依据：方案 § 4.1（事件是唯一真相源）、ADR 0004（核心层框架无关）
 *
 * ★ 为什么是端口而不是直接写文件：
 *   核心层不许碰文件系统。这个接口只声明"事件产生后要通知谁"，
 *   真实实现（JSONL 追加写）放在 adapters/。
 *
 * ★ 为什么是**追加**而不是覆盖：
 *   事件流的本质就是追加的。覆盖写会让"长驻进程每秒都在写"
 *   变成每秒重写整个历史 —— 而且中途崩溃会丢掉全部历史。
 *
 * ⚠️ 实现必须**同步可见、异步落盘**：
 *   `onAppend` 不该阻塞事件产生（否则磁盘慢会拖住整个编排）。
 *   实现应当先入缓冲、后台刷盘。丢最后几条可接受（有截断保护），
 *   阻塞整个系统不可接受。
 */
export interface EventPersistencePort {
  /** 有事件被追加。实现负责缓冲与刷盘。 */
  onAppend(events: readonly SessionEvent[]): void;
  /**
   * 事件流被截断（检查点回退）。
   *
   * ★ 落盘侧**必须**处理它 —— 否则磁盘上留着已被回退的事件，
   *   下次启动重放会把回退掉的历史又装回来。
   *   实现应当重写文件到 `keepSeq` 为止。
   */
  onTruncate(keepSeq: number): void;
  /** 进程退出前把缓冲刷干净。 */
  flush(): Promise<void>;
}

/** 空实现：不需要持久化时用（测试、纯内存场景）。 */
export const NULL_PERSISTENCE: EventPersistencePort = {
  onAppend: () => undefined,
  onTruncate: () => undefined,
  flush: async () => undefined,
};

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
  private persistence: EventPersistencePort = NULL_PERSISTENCE;
  /** 落盘尚未确认的事件数（供界面显示"保存中"）。 */
  private pendingPersist = 0;

  constructor(readonly sessionId: string) {}

  /**
   * 挂上持久化端口。
   *
   * ⚠️ 必须在**开始产生事件之前**挂上 —— 中途挂会丢掉之前的事件。
   *    （这条约束比"能中途换端口"更重要：中途换端口意味着有一段历史
   *      在内存里而不在盘上，重启后状态会少一截且无从发现。）
   */
  attachPersistence(port: EventPersistencePort): void {
    this.persistence = port;
  }

  /** 还有多少事件在落盘缓冲里。 */
  pendingPersistence(): number {
    return this.pendingPersist;
  }

  /** 刷盘（进程退出前调用）。 */
  async flushPersistence(): Promise<void> {
    await this.persistence.flush();
    this.pendingPersist = 0;
  }

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

    // ★ 落盘通知放在最后 —— 事件先在内存里成立，
    //   磁盘慢不该拖住编排。（实现负责缓冲与后台刷盘。）
    this.persistAppended([event as SessionEvent]);

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
      /**
       * ⚠️ 逐条 append 会各自通知一次落盘。追加顺序本身没问题，
       *    但会让「批量」的原子性在落盘侧失效 —— 一批里前几条已落、
       *    后几条崩了。
       *
       *    这里先挂起通知，整批成功后再一次性交给端口。
       */
      const held: SessionEvent[] = [];
      const real = this.persistence;
      this.persistence = {
        onAppend: (evs) => held.push(...evs),
        onTruncate: (seq) => real.onTruncate(seq),
        flush: () => real.flush(),
      };

      const out = inputs.map((i) => this.append(i));

      this.persistence = real;
      real.onAppend(out as readonly SessionEvent[]);
      return out;
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

    // ★ 通知落盘侧截断。
    //
    //   ⚠️ 不通知的后果很隐蔽：磁盘上留着已被回退的事件，
    //      **下次启动重放会把回退掉的历史又装回来** ——
    //      用户明明回退了，重启后状态却"复活"了。
    this.persistence.onTruncate(target.seq);

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

  private persistAppended(events: readonly SessionEvent[]): void {
    if (events.length === 0) return;
    try {
      this.persistence.onAppend(events);
      this.pendingPersist += events.length;
    } catch {
      /**
       * ⚠️ 落盘通知失败**不能**让编排崩掉 —— 内存状态依然是对的。
       *    但要留下痕迹：`pendingPersist` 会持续增长，
       *    界面显示"保存中"时用户能看出异常。
       */
      this.pendingPersist += events.length;
    }
  }
}
