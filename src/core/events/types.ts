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

/**
 * 事件发起者。
 *
 * ★★★ 读这个类型时不要据此推断架构：
 *
 *   | 值 | 现在会不会产生 | 说明 |
 *   |---|---|---|
 *   | `'user'` / `'butler'` / `'system'` / `'scheduler'` / `'supervisor'` | 会 | 当前架构 |
 *   | **`'servant'`** | **不会** | ⚠️ **历史遗留**：v8 之前的多执行者架构用过 |
 *
 *   ⚠️ 为什么 `'servant'` 不删：**旧日志里有它**（配 `servantId` 定位是哪个）。
 *      删了类型，那些日志读出来就是"未知 actor"，审计视图会报错。
 *
 *   ★ 当前架构是**单执行者（管家）+ 监督员**：
 *     管家自己干活（`actor: 'butler'`），监督员复核（`actor: 'supervisor'`）。
 *     不存在"派给某个仆人"这一步。
 */
export type EventActor =
  | 'user'
  | 'butler'
  /** @deprecated 历史值，当前代码不再产生 —— 只为读旧日志保留 */
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

  // ── 族 2 · 理解与契约（v8：只剩"写契约"，不再有"派发"）──
  /** @deprecated 历史值 —— 独立路由调用已在 v8 砍掉（置信度并入契约） */
  | 'route.decided'
  /** v7：任务契约已写下（监督员核对的唯一标准，本身也要可审计） */
  | 'contract.written'
  /** v7：管家执行完成（替代 servant.report 的「汇报给上级」语义） */
  | 'butler.executed'
  /**
   * @deprecated 用 `route.assumed` 取代（v7 · D-4）。
   *
   * ★ 为什么改名：旧语义是"**停下来问用户**"（clarify），
   *   而现在是"**带着最可能的假设继续干**"（assume）。
   *   保留旧名会让审计视图与实现语义脱节 ——
   *   看到 `route.clarify` 的人会以为这轮什么都没做。
   *
   * ⚠️ 保留类型是为了能读**历史事件**（旧数据里确实有它）。
   */
  | 'route.clarify'
  /** 置信度不足，但**不阻断** —— 记录"按什么假设继续干的" */
  | 'route.assumed'
  /** @deprecated 历史值 —— 多执行者时代"改派给另一个仆人" */
  | 'route.rerouted'
  /** 关键事件：本任务注入了哪些约束（可审计，对应 § 2.2⑥） */
  | 'constraint.injected'

  // ═══════════════════════════════════════════════════════════
  // ⚠️⚠️ 历史事件（只读重放）—— 当前代码**不会产生**这些
  //
  //   ⚠️ 六族里原本的「派发」与「仆人汇报」两组，属于 v8 之前的多执行者架构。
  //      代码已经删干净（`core/execution/execute.ts` 里的 `runServant` 等都没了），
  //      但**事件类型必须留着**：旧日志里确实有它们，删了就无法重放。
  //
  //   ★★ 读到这里的人请注意：
  //      **这些类型的存在不是"系统里还有仆人"的证据**，而是"这个系统曾经那样过"。
  //      当前架构：管家自己干（`butler.executed`）→ 监督员复核（`supervisor.*`）。
  //
  //   ★ 判定一个事件类型是否为历史遗留：用下方 `LEGACY_EVENT_TYPES`。
  // ═══════════════════════════════════════════════════════════
  | 'dispatch.created'
  | 'dispatch.stepStarted'
  | 'dispatch.stepDone'
  | 'dispatch.stepFailed'
  | 'servant.report'
  | 'servant.blocked'
  | 'servant.needsDecision'
  // ═══ 历史事件到此为止 ═══

  // ── 族 4 · 管家监督与裁决 ──
  | 'supervisor.observe'
  | 'supervisor.omissionDetected'
  | 'supervisor.principleViolated'
  | 'conflict.detected'
  | 'conflict.resolved'
  /** 关键事件：硬约束命中，管家机械拦截（不是某个执行者的权力） */
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

/**
 * ⚠️ **历史事件类型**（v8 之前的多执行者架构产生）—— 当前代码不再产生。
 *
 * ★★ 为什么留这份清单，而不是让它们混在 `EventType` 里：
 *
 *   一个读者翻到 `EventType` 里赫然列着 `servant.report` / `dispatch.stepStarted`，
 *   很容易断定"系统里有多执行者、管家会派活给仆人"。
 *   **而那是过去的架构** —— 现在的代码里没有 `runServant`、没有派发、没有仆人。
 *
 *   ✅ 这份清单的作用：把"历史遗留"与"当前词汇"**显式分开**。
 *      任何人（包括未来的我）看到 `isLegacyEventType(x) === true`，
 *      立刻知道"这个类型只可能出现在旧日志里"。
 *
 * ⚠️ 这些类型**不能从 `EventType` 删除**：
 *    事件是 append-only 的唯一真相源，旧日志里有它们，
 *    删了 `checkpoint` 重放与审计视图就会不认识那些 seq。
 *
 * ★ 当前架构的事件只有：
 *     `butler.executed`（管家自己干完了）· `supervisor.*`（监督员复核）
 *     · `contract.written`（承诺了什么）
 */
export const LEGACY_EVENT_TYPES = [
  'dispatch.created',
  'dispatch.stepStarted',
  'dispatch.stepDone',
  'dispatch.stepFailed',
  'servant.report',
  'servant.blocked',
  'servant.needsDecision',
  'route.decided',
  'route.clarify',
  'route.rerouted',
] as const satisfies readonly EventType[];

/** 这个事件类型是否只可能出现在**历史日志**里（当前代码不产生）。 */
export function isLegacyEventType(t: EventType): boolean {
  return (LEGACY_EVENT_TYPES as readonly string[]).includes(t);
}

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
    'contract.written',
    'butler.executed',
    'route.clarify',
    'route.assumed',
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
  /**
   * ⚠️ **历史字段** —— v8 之前：`actor === 'servant'` 时指哪个仆人。
   *
   *    当前代码**不再写这个字段**：单执行者架构下没有「哪个执行者」这回事。
   *    保留只因为旧日志里有它（`bootstrap` 重放时原样带出）。
   *
   *    ★ 现在表达「这件事属于哪个领域」的是 `payload.domains`
   *      （见 `contract.written`）。
   */
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
