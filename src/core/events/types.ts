/**
 * 事件模型 —— 整个系统的地基
 *
 * 设计依据：参赛方案 v6.5 § 4.1
 *
 * 核心不变量（inventories）：
 *   I1. 每个 session 内 seq 从 1 开始、单调递增、无空洞
 *   I2. parentEventId 只能指向同 session 中 seq 更小的事件
 *   I3. 事件一经写入不可修改、不可删除（append-only）
 *   I4. 任何状态都可由事件流重放得到；快照仅作加速缓存
 *
 * 参见：docs/architecture/event-model.md
 */

/** 事件发起者。注意 'servant' 也需要 servantId 才能定位到具体仆人。 */
export type EventActor =
  | 'user'
  | 'butler'
  | 'servant'
  | 'supervisor'
  | 'scheduler'
  | 'system';

/**
 * 事件类型总表 —— 九个事件族。
 *
 * 分组只是为了可读性，运行时统一按字符串匹配。
 */
export type EventType =
  // ── 族 1 · 推理与规划 ──
  | 'thought.delta'
  | 'thought.done'
  | 'plan.created'
  | 'plan.revised'
  | 'tool.call'
  | 'tool.result'
  /**
   * 上下文压缩（§3.1b 三层记忆的层②）。
   *
   * ★ 为什么要落事件而不是只写日志：
   *   "压缩省了多少 token"是可核对的事实，不该只有口头说明。
   *   payload 里有 `beforeTokens / afterTokens / ok / failure`。
   */
  | 'context.compacted'

  // ── 族 2 · 路由与派发（管家 → 仆人）──
  | 'route.decided'
  | 'route.clarify'
  | 'route.rerouted'
  | 'dispatch.created'
  | 'dispatch.stepStarted'
  | 'dispatch.stepDone'
  | 'dispatch.stepFailed'
  /** 关键事件：本任务给某仆人注入了哪些约束（可审计，对应 § 2.2⑥） */
  | 'constraint.injected'

  // ── 族 3 · 仆人汇报（仆人 → 管家）──
  | 'servant.report'
  | 'servant.blocked'
  | 'servant.needsDecision'

  // ── 族 4 · 管家监督与裁决 ──
  | 'supervisor.observe'
  | 'supervisor.omissionDetected'
  | 'supervisor.principleViolated'
  | 'conflict.detected'
  | 'conflict.resolved'
  /** 关键事件：硬约束命中，管家机械拦截（不是某个仆人的权力） */
  | 'constraint.hardBlocked'

  // ── 族 5 · 记忆生命周期 ──
  | 'memory.created'
  | 'memory.recalled'
  | 'memory.candidate'
  | 'memory.approved'
  | 'memory.rejected'
  | 'memory.revised'
  | 'memory.archived'
  | 'memory.merged'
  | 'principle.derived'
  | 'principle.applied'
  | 'principle.effectMeasured'

  // ── 族 6 · 记忆分权（§ 2.2⑥）──
  /** 仆人尝试写全局层 —— 应全部被拒，此事件用于审计 */
  | 'memory.writeAttempted'
  | 'grant.requested'
  | 'grant.approved'
  | 'grant.denied'
  | 'grant.used'
  | 'grant.expired'

  // ── 族 7 · 记忆演化（§ 8）──
  | 'fitness.updated'
  | 'memory.dormant'
  | 'memory.revived'
  | 'evolution.thresholdAdapted'

  // ── 族 8 · 反思与行为观察 ──
  | 'reflection.started'
  | 'reflection.done'
  | 'profile.snapshot'
  | 'activity.sampled'
  | 'activity.aggregated'
  | 'pattern.derived'
  | 'pattern.invalidated'

  // ── 族 9 · 人工干预 / 安全 / 生命周期 ──
  | 'intervention.pause'
  | 'intervention.resume'
  | 'intervention.correct'
  | 'intervention.reroute'
  | 'intervention.weightAdjusted'
  | 'intervention.forgotten'
  | 'credential.authorized'
  | 'credential.used'
  | 'action.classified'
  | 'action.blocked'
  | 'injection.detected'
  | 'artifact.created'
  | 'artifact.revised'
  | 'artifact.superseded'
  | 'checkpoint.created'
  | 'session.rollback'
  | 'schedule.triggered'
  | 'session.forked'
  | 'session.ended'

  // ── 族 10 · MCP 集成（方案第十章）──
  //
  // ⚠️ 方案第十章详细写了 MCP 客户端，但事件类型里原本一个都没有 ——
  //    这是审查时发现的方案缺口，这里补上。
  //
  // ★ MCP 工具的**调用**复用 tool.call / tool.result（它们走同一个闸门），
  //   这一族只记**服务器生命周期**与**外部工具挂载**，不重复记调用。
  | 'mcp.serverAdded'
  | 'mcp.serverRemoved'
  | 'mcp.serverConnected'
  | 'mcp.serverDisconnected'
  | 'mcp.serverFailed'
  | 'mcp.toolsDiscovered'
  | 'mcp.policyChanged'

  // ── 族 11 · 会话与消息 ──
  //
  // ★ 为什么单独成族：方案 § 5.2 明确要求「产出物必须与**对话**、
  //   任务状态一同快照并同步回退」—— 既然回退要处理对话，
  //   对话就必须是**可持久化、可重放**的状态，而不只是界面里的一段 UI 状态。
  | 'session.message'
  | 'session.reply'
  | 'session.verdict';

/** 族划分，便于 UI 分组与统计。 */
export const EVENT_FAMILIES = {
  reasoning: [
    'thought.delta',
    'thought.done',
    'plan.created',
    'plan.revised',
    'tool.call',
    'tool.result',
  ],
  routing: [
    'route.decided',
    'route.clarify',
    'route.rerouted',
    'dispatch.created',
    'dispatch.stepStarted',
    'dispatch.stepDone',
    'dispatch.stepFailed',
    'constraint.injected',
  ],
  reporting: ['servant.report', 'servant.blocked', 'servant.needsDecision'],
  supervision: [
    'supervisor.observe',
    'supervisor.omissionDetected',
    'supervisor.principleViolated',
    'conflict.detected',
    'conflict.resolved',
    'constraint.hardBlocked',
  ],
  memoryLifecycle: [
    'memory.created',
    'memory.recalled',
    'memory.candidate',
    'memory.approved',
    'memory.rejected',
    'memory.revised',
    'memory.archived',
    'memory.merged',
    'principle.derived',
    'principle.applied',
    'principle.effectMeasured',
  ],
  memoryPartition: [
    'memory.writeAttempted',
    'grant.requested',
    'grant.approved',
    'grant.denied',
    'grant.used',
    'grant.expired',
  ],
  evolution: ['fitness.updated', 'memory.dormant', 'memory.revived', 'evolution.thresholdAdapted'],
  reflection: [
    'reflection.started',
    'reflection.done',
    'profile.snapshot',
    'activity.sampled',
    'activity.aggregated',
    'pattern.derived',
    'pattern.invalidated',
  ],
  lifecycle: [
    'intervention.pause',
    'intervention.resume',
    'intervention.correct',
    'intervention.reroute',
    'intervention.weightAdjusted',
    'intervention.forgotten',
    'credential.authorized',
    'credential.used',
    'action.classified',
    'action.blocked',
    'injection.detected',
    'artifact.created',
    'artifact.revised',
    'artifact.superseded',
    'checkpoint.created',
    'session.rollback',
    'schedule.triggered',
    'session.forked',
    'session.ended',
  ],
  chat: [
    'session.message',
    'session.reply',
    'session.verdict',
  ],
  mcp: [
    'mcp.serverAdded',
    'mcp.serverRemoved',
    'mcp.serverConnected',
    'mcp.serverDisconnected',
    'mcp.serverFailed',
    'mcp.toolsDiscovered',
    'mcp.policyChanged',
  ],
} as const satisfies Record<string, readonly EventType[]>;

export type EventFamily = keyof typeof EVENT_FAMILIES;

/**
 * 一条会话事件。
 *
 * payload 故意保持 unknown —— 具体形状由各模块的 Zod schema 在写入前校验，
 * 而不是在这里收紧成一个大联合类型（那会让新增事件类型变得笨重）。
 */
export interface SessionEvent<T extends EventType = EventType, P = unknown> {
  readonly id: string;
  readonly sessionId: string;
  /** 单调递增，从 1 开始。回退 = 截断到某个 seq。 */
  readonly seq: number;
  readonly type: T;
  readonly payload: P;
  readonly createdAt: number;
  /** 因果链：这条事件由哪条触发。必须指向同 session 中更小的 seq。 */
  readonly parentEventId?: string;
  readonly actor: EventActor;
  /** actor === 'servant' 时必填 */
  readonly servantId?: string;
}

/** 会话的事件流（内存视图，持久化层另外实现）。 */
export interface EventStream {
  readonly sessionId: string;
  readonly events: readonly SessionEvent[];
}

/** 回退目标：截断到该 seq（含）。 */
export interface RollbackTarget {
  readonly sessionId: string;
  readonly seq: number;
  readonly reason: string;
}

/** 事件不符合不变量时抛出。 */
export class EventInvariantError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'SEQ_NOT_MONOTONIC'
      | 'SEQ_GAP'
      | 'PARENT_NOT_FOUND'
      | 'PARENT_NOT_EARLIER'
      | 'CROSS_SESSION_PARENT'
      | 'SERVANT_ID_REQUIRED'
      | 'IMMUTABLE',
  ) {
    super(message);
    this.name = 'EventInvariantError';
  }
}
