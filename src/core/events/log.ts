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
import { scrubEventForMemory } from './scrub.js';

export interface AppendInput<T extends EventType = EventType, P = unknown> {
  readonly type: T;
  readonly payload: P;
  readonly actor: EventActor;
  readonly parentEventId?: string;
  /** ⚠️ 历史字段，新代码不要传 —— 见 `SessionEvent.servantId` 的说明 */
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
  /**
   * 还有多少条事件在落盘缓冲里（供界面显示"未落盘"）。
   *
   * ⚠️ 可选：纯内存实现没有缓冲，不应假装有；没有实现时
   *    `EventLog` 回退到自己的计数（只对 NULL 端口有意义）。
   */
  pending?(): number;
  /**
   * 用给定的事件数组**整体重写**文件（遗忘权抹除内容时用）。
   *
   * ⚠️ 参数是**取数函数**而不是数组：实现应先在内部 `flush()`，
   *    再取当前全量事件并同步写入 —— 这样在 await 期间新追加的事件
   *    不会被一次"旧快照"覆盖掉。
   */
  rewrite?(getEvents: () => readonly SessionEvent[]): Promise<void>;
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
  /** 落盘尚未确认的事件数（供界面显示"未落盘"）。 */
  private pendingPersist = 0;
  /** 有待完成的"整体重写"（遗忘权抹除；flush 时一起等）。 */
  private pendingRewrite: Promise<void> | null = null;

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
    // 端口自己知道缓冲长度时以它为准；`pendingPersist` 只用于没有缓冲概念的端口。
    return this.persistence.pending?.() ?? this.pendingPersist;
  }

  /**
   * 遗忘权：把某条记忆的原文从事件载荷里抹掉。
   *
   * ★ 与 `store.forget()` 的分工：
   *   store 负责"状态上删除 + 记墓碑"；这里负责"历史里不再有原文"。
   *   两边都做，才算"删除"在**重启后仍然成立**。
   *
   * 返回被改动的事件数（0 表示本来就没有原文，通常是旧数据迁移）。
   */
  scrubForMemory(memoryId: string, content: string): number {
    let changed = 0;
    const next: SessionEvent[] = [];
    for (const e of this.events) {
      const hit = scrubEventForMemory(e, memoryId, content);
      if (hit === null) {
        next.push(e);
        continue;
      }
      next.push(hit.event);
      changed += 1;
    }
    if (changed === 0) return 0;

    this.events = next;
    /**
     * 重写磁盘：先 flush，再由端口取当前全量事件同步写。
     * 这里不 await —— 调用方（forget 路由）随后会 `flushPersistence()`，
     * 那一步会等这个 Promise 完成，因此"删除已落盘"仍有保证。
     */
    const port = this.persistence;
    if (port.rewrite !== undefined) {
      this.pendingRewrite = (this.pendingRewrite ?? Promise.resolve())
        .then(() => port.rewrite?.(() => this.events))
        .catch(() => undefined);
    }
    this.pendingPersist = 0;
    return changed;
  }

  /** 刷盘（进程退出前调用）。 */
  async flushPersistence(): Promise<void> {
    await this.persistence.flush();
    // 抹除后的整体重写排在 flush 之后；一起等，保证"删除已落盘"。
    if (this.pendingRewrite !== null) {
      const rewrite = this.pendingRewrite;
      this.pendingRewrite = null;
      await rewrite;
    }
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

    /**
     * ⚠️ **历史不变量**：旧架构里 `actor: 'servant'` 必须带 `servantId` 才能定位是哪个。
     *
     *    保留它是因为**重放旧日志时仍要校验**；新代码不会走到这里
     *    （`EventActor` 里 `'servant'` 已标 `@deprecated`，没有生产者）。
     */
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
        ...(real.pending !== undefined ? { pending: () => real.pending?.() ?? 0 } : {}),
        ...(real.rewrite !== undefined
          ? { rewrite: (getEvents: () => readonly SessionEvent[]) => real.rewrite?.(getEvents) ?? Promise.resolve() }
          : {}),
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
      // 端口能报"缓冲里还有几条"时，以自己的计数为准（那个数才是真的）。
      if (this.persistence.pending === undefined) this.pendingPersist += events.length;
    } catch {
      /**
       * ⚠️ 落盘通知失败**不能**让编排崩掉 —— 内存状态依然是对的。
       *    但要留下痕迹：界面能看到"未落盘"，用户能看出异常。
       */
      this.pendingPersist += events.length;
    }
  }
}
