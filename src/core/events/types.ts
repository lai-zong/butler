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

  // ── 族 1.5 · 工作区（用户在工作区面板里保存文件）──
  /**
   * 用户在面板里保存了文件。
   *
   * ★ 为什么要落事件：AI 写文件有 `tool.call` 留痕，用户手改如果什么都不记，
   *   事后就分不清"这个文件是谁改成这样的"。事件只记路径/大小/指纹，不记内容。
   */
  | 'file.edited'

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
  | 'conflict.judgeFailed'
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
  | 'memory.restored'
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
  // ── 族 8b · 每日日记 ──
  | 'diary.created'
  | 'diary.failed'
  | 'profile.snapshot'
  | 'activity.sampled'
  | 'activity.aggregated'
  | 'attachment.parsed'
  | 'pattern.derived'
  | 'pattern.invalidated'

  // ── 族 9 · 人工干预 / 安全 / 生命周期 ──
  | 'intervention.pause'
  | 'intervention.resume'
  | 'intervention.correct'
  | 'intervention.reroute'
  | 'intervention.weightAdjusted'
  | 'intervention.forgotten'
  /** 移入存档区（第一步删除）：记忆库不再持有，原文交给存档区 */
  | 'intervention.archivedOut'
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
  | 'user-task.run'
  | 'user-task.completed'
  | 'user-task.snoozed'
  | 'user-task.updated'
  | 'session.forked'
  /** 会话选择的模型；随事件重放，保证刷新后仍能恢复 */
  | 'session.model'
  /**
   * 会话级设置变更 / 每轮设置快照。
   *
   * ★ 事件只记摘要（设置 hash、人格长度/hash、推理档位与实际映射），
   *   **不写人格正文** —— 正文存 session 状态，另有 sidecar 负责跨重启。
   */
  | 'session.settings'
  /** 用户主动取消：记录取消阶段、已发生的工具调用/结果数，供回放 */
  | 'session.cancelled'
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
  | 'session.verdict'
  // ── 手动复核（v10 后端）──
  | 'review.run'
  // ── 题目与批改（v8 新增）──
  //
  // ★★ `quiz.created` 存的是**正确答案**，它必须与产出物分离：
  //   · 产出物（`ExecutionArtifact`）走 `session.reply` → **进调用方**；
  //   · 答案走这里 → **只给服务端**（`.butler-data` 对模型的文件工具是受保护路径）。
  //
  //   ⚠️ 为什么答案不能塞进产出物：一旦进了产出物，它会随消息一起
  //      重放给调用方，"做题视图"就等于把答案直接印在题目下面。
  | 'quiz.created'
  | 'quiz.graded';

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

/**
 * 族划分，便于 UI 分组与统计。
 *
 * ⚠️ **只放当前架构会产生的事件**。
 *
 * ★ v8 修正：原 `routing` 族里混着 7 个历史事件（`route.decided` /
 *   `route.clarify` / `route.rerouted` / `dispatch.*`），
 *   原 `reporting` 族则**三个成员全是历史事件**（`servant.report` 等）。
 *   这与本文件开头「历史事件必须显式隔离」的意图**直接矛盾** ——
 *   读者按族浏览时会以为"汇报族"还是活的。
 *
 *   现在：历史的 10 个事件只在 `LEGACY_EVENT_TYPES` 里；
 *   `reporting` 族删除；`routing` 改名 `execution`（`routing` 这个词已死）。
 */
export const EVENT_FAMILIES = {
  reasoning: [
    'thought.delta',
    'thought.done',
    'plan.created',
    'plan.revised',
    'tool.call',
    'tool.result',
  ],
  execution: ['contract.written', 'butler.executed', 'route.assumed', 'constraint.injected'],
  supervision: [
    'supervisor.observe',
    'supervisor.omissionDetected',
    'supervisor.principleViolated',
    'conflict.detected',
    'conflict.judgeFailed',
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
    'memory.restored',
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
  /**
   * 每日日记：每个活跃作用域每天一篇。
   *
   * ★ 日记不是记忆节点，也不是新的真相源；它是由原始消息派生、
   *   可重放、可删除的当日经历摘要。
   */
  diary: ['diary.created', 'diary.failed'],
  /**
   * ★ 多模态（v8.2 补登记）：附件解析留痕。
   *
   * ⚠️ 只记**字段个数与摘要长度**，不记原始内容 —— 附件可能含隐私
   *    （收据上有地址、截图里有私信）。这条纪律写在 `multimodal/parse.ts` 里。
   */
  multimodal: ['attachment.parsed'],
  lifecycle: [
    'intervention.pause',
    'intervention.resume',
    'intervention.correct',
    'intervention.reroute',
    'intervention.weightAdjusted',
    'intervention.forgotten',
    'intervention.archivedOut',
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
    'user-task.run',
    'user-task.completed',
    'user-task.snoozed',
    'user-task.updated',
    'session.forked',
    'session.model',
    'session.settings',
    'session.cancelled',
    'session.ended',
  ],
  chat: [
    'session.message',
    'session.reply',
    'session.verdict',
    'review.run',
    'quiz.created',
    'quiz.graded',
  ],
  /**
   * ★ 上下文压缩（v8 补登记）。
   *
   * ⚠️ `context.compacted` 早就存在（`chat/service.ts` 会产生、`validate:9` 断言它落地），
   *    但它**既不在任何事件族、也不在历史清单**里 —— 是编译期护栏
   *    （`UnregisteredEventType`）把它抓出来的：能落盘、按族却查不到。
   */
  workspace: ['file.edited'],
  context: ['context.compacted'],
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

// ═══════════════════════════════════════════════════════════
// ★ 扩展护栏：新增事件类型必须登记
// ═══════════════════════════════════════════════════════════

/**
 * 加一个新的 `EventType` 要动的地方（漏了会在这里被抓住）：
 *
 *   ① `EventType` 联合                      —— 必须
 *   ② 下方 `EVENT_FAMILIES` 里某个族         —— **漏了这条会编译报错**
 *   ③ 若为历史遗留 → `LEGACY_EVENT_TYPES`   —— 二选一，不能都漏
 *   ④ 重放分支（若该事件影响检查点状态）      —— 不影响则可忽略（`replay` 有 default）
 *   ⑤ 检查点白名单（若该时刻值得回退）        —— 见 `checkpoint/manager.ts`
 *   ⑥ `event-replay-safety.test.ts` 会自动覆盖它（遍历全部类型重放）
 */
type FamilyEventType = (typeof EVENT_FAMILIES)[keyof typeof EVENT_FAMILIES][number];
type LegacyEventType = (typeof LEGACY_EVENT_TYPES)[number];

/**
 * 既没登记进任何事件族、也不在历史清单里的事件类型。
 *
 * ★★ 这行的作用是**把纪律变成编译错误**：
 *    以前漏登记的表现是"事件能落盘，但按族查不到、按族遍历漏掉"——
 *    运行时完全正常，只有某天统计或清理时才发觉得到怪结果。
 *
 * ⚠️ 如果这里报错，说明你新加了 `EventType` 却没登记。去 ② 或 ③ 补上。
 */
type UnregisteredEventType = Exclude<EventType, FamilyEventType | LegacyEventType>;

/** 编译期断言：`UnregisteredEventType` 必须为空（`never`）。 */
const _assertEveryEventTypeIsRegistered: UnregisteredEventType extends never ? true : never = true;
void _assertEveryEventTypeIsRegistered;

/** 扁平的全部事件类型 —— 供测试与审计遍历（顺序稳定：先族内、后历史）。 */
export const ALL_EVENT_TYPES: readonly EventType[] = [
  ...Object.values(EVENT_FAMILIES).flat(),
  ...LEGACY_EVENT_TYPES,
] as readonly EventType[];

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
