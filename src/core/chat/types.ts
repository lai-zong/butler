/**
 * 会话与消息模型 —— 界面读写的状态
 *
 * 设计依据：方案 § 5.2（"产出物必须与**对话**、任务状态一同快照并同步回退"）
 *
 * ★ 为什么放在 core 而不是 app 层：
 *   方案原文把"对话"列为回退必须覆盖的三方之一。既然回退要处理它，
 *   它就必须是**可持久化、可重放**的状态 —— 而那是 core 的职责。
 *   放在 app 层会变成"只有界面知道的一段 UI 状态"，回退就做不了。
 *
 * ★ 消息与事件的关系：
 *   消息是**给人看的投影**，事件是**真相源**。一条用户消息对应一条
 *   `session.message` 事件；管家的回复对应 `butler.reply`。
 *   于是重放时能重建出完整对话 —— 这与记忆、产出物同一套约定。
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { DomainId } from '../execution/types.js';
import { parseAgentTrace, parseExecutionReports } from './parse.js';
import type { TaskContract } from '../butler/contract.js';

// ═══════════════════════════════════════════════════════════
// 消息
// ═══════════════════════════════════════════════════════════

export type MessageRole =
  /** 用户 */
  | 'user'
  /** 管家 */
  | 'butler'
  /** 某个仆人 */
  | 'servant'
  /** 系统提示（拦截、错误等） */
  | 'system';

export type MessageStatus =
  /** 完整 */
  | 'done'
  /** 正在生成（流式） */
  | 'streaming'
  /** 生成中断（保留了已生成部分） */
  | 'interrupted'
  /** 失败 */
  | 'failed';

/**
 * 一条消息。
 *
 * ⚠️ 刻意**不**包含"审核状态"这类流程字段 —— 那些属于任务，
 *    不属于单条消息。混在一起会让"一条消息在多个任务里"变得无法表达。
 */
export interface AuditRange {
  readonly fromSeq: number;
  readonly toSeq: number;
}

/**
 * 手动复核所需的 turn 快照。
 *
 * ★ 只存监督员真正需要的输入：用户目标、契约、硬约束、产出摘要。
 *   不存整段工具 trace —— 复核的是“交付物是否符合契约”，不是重放执行。
 */
export interface ReviewSnapshot {
  readonly userGoal: string;
  readonly contract: TaskContract;
  readonly hardConstraints: readonly string[];
  readonly outputSummary: string;
}

export type ReviewRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface ReviewRunReport {
  readonly criteriaChecks: readonly {
    readonly criterion: string;
    readonly met: boolean;
    readonly note?: string | undefined;
  }[];
  readonly findings: readonly {
    readonly viewpoint: 'contract' | 'domain' | 'global';
    readonly severity: 'info' | 'warn' | 'block';
    readonly message: string;
    readonly evidence: readonly string[];
  }[];
  readonly summary: string;
}

export interface ReviewRun {
  readonly id: string;
  readonly sessionId: string;
  /** 本轮 turn 标识；当前用被复核的 assistant message id。 */
  readonly turnIds: readonly string[];
  readonly status: ReviewRunStatus;
  readonly model: string;
  readonly promptVersion: string;
  readonly snapshotHash: string;
  readonly stages: readonly { readonly name: string; readonly status: 'done' | 'failed' }[];
  readonly report: ReviewRunReport | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly error?: string;
  readonly createdAt: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MessageRole;
  /** role === 'servant' 时是哪个仆人 */
  readonly servant?: DomainId;
  /** 正文（markdown） */
  readonly text: string;
  /**
   * 这条回复对应的本轮事件区间（用于刷新后的“本轮依据”）。
   * 旧消息没有这个字段，界面应回退到“会话依据”。
   */
  readonly auditRange?: AuditRange;
  /** 手动复核所需的输入快照；旧消息没有。 */
  readonly reviewSnapshot?: ReviewSnapshot;
  /**
   * 思考过程（英文原文）。
   *
   * ★ 与正文分开存 —— 原始功能「翻译英文思考」要能**切换查看原文**，
   *   所以原文与译文都必须留住。
   */
  readonly reasoning?: string;
  /** 思考的增量译文（与 reasoning 同步增长） */
  readonly reasoningTranslated?: string;
  readonly status: MessageStatus;
  readonly createdAt: number;
  /** 这条回复引用了哪些记忆（界面上要能点开看「凭什么这么说」） */
  readonly memoryRefs?: readonly { readonly id: string; readonly content: string }[];
  /**
   * ★★ 这条回复背后的**工具循环过程**（「思考 → 工具 → 再思考」）。
   *
   * ⚠️ 为什么要持久化，而不是只在调用方内存里留一份：
   *    工具调用过程是「它到底干了什么」的唯一记录 ——
   *    **刷新就没了的话，用户想回看"它刚才读了哪个文件、结果是什么"**
   *    就做不到。而「可审计」是本项目的立身之本，
   *    过程不该只在流式期间可见。
   *
   * ★ 只存必要字段：工具结果已截断（1200 字/条），
   *   整套 trace 通常几 KB，可以进事件。
   */
  readonly agentTrace?: AgentTraceData;
  /**
   * ★★ 这条回复背后**每个仆人各自的产出**。
   *
   * ★ 为什么它与 `agentTrace` 必须分开：
   *   · `agentTrace` 是**工具循环过程**（思考 + 调了什么工具）——
   *     回答「它是怎么做的」
   *   · `servantReports` 是**各仆人的结论**（产出物 + 发现 + 不确定）——
   *     回答「它得出了什么、依据是什么」
   *
   *   ⚠️ 两者不能合并：一个仆人可能没走工具循环（纯推理），
   *      也可能多个仆人各跑一遍工具循环。**按仆人归属**才对得上
   *      界面上「仆人面板」那个分栏。
   *
   * ⚠️ 之前**完全没有收集它** —— 于是界面上无从显示"某个仆人说了什么"，
   *    只能显示管家汇总后的结果。而方案 § 2.2 强调的是
   *    **仆人只提交发现、管家才做裁决** —— 那个区分必须在界面上看得见。
   */
  readonly servantReports?: readonly ExecutionReportData[];
}

/**
 * 一次执行的产出（**可持久化形状** —— 存在事件日志的消息 payload 里）。
 *
 * ★★★ 读这个类型时**不要**据此推断架构：
 *
 *   | 字段名 | 实际含义 | 为什么还叫这个 |
 *   |---|---|---|
 *   | `servant` | **领域标识**（life/health/…）| ⚠️ 是**持久化键**，改名会让旧消息读不出 |
 *   | `servantReports`（在 `StoredMessage` 上）| 本轮的执行产出 | 同上 |
 *
 *   ⚠️ 这是**历史遗留的键名**，不是"系统里有仆人"的证据。
 *      当前架构是**单执行者（管家）+ 监督员**：一次会话只有一份执行产出。
 *
 *   ★ 若要彻底改名，需要"双读迁移"（同时接受新旧两个键 + 回写），
 *     属于事件线格式变更（批次F），不能顺手改 —— 见 `docs/refactor-status.md`。
 *
 * ⚠️ 旧的注释说"仆人只提交发现、管家才做裁决" —— 那个区分现在体现为
 *    **执行产出里的 `findings` 交给监督员复核**，不再是"多执行者各自提交"。
 */
export interface ExecutionReportData {
  /** ⚠️ 历史键名；装的是**领域标识**（见上方说明）*/
  readonly servant: string;
  readonly taskId: string;
  readonly status: 'done' | 'failed' | 'blocked';
  /**
   * ★★ 该对**用户**说的那段话 —— 界面上仆人消息的正文。
   *
   * ⚠️ 与 `artifacts` / `findings` 的分工：
   *   · `reply`     —— 给人看的（界面主体）
   *   · `artifacts` —— 给管家核对用的结构化产出
   *   · `findings`  —— 给管家裁决用的发现
   *
   *   结构**不能删**：管家做机械硬约束校验靠它，
   *   失败打回重做也靠它。两者并存、各司其职。
   */
  readonly reply: string;
  /** 指令 —— 引擎内部用；**界面不显示**（用户不关心调度细节） */
  readonly instruction: string;
  /**
   * ★ 这个仆人的**工具循环过程**（思考 + 工具调用）。
   *
   * ⚠️ 它是仆人窗口里「折叠的过程块」的数据源 ——
   *    有了它，仆人窗口才与管家窗口结构一致
   *    （先过程、再最终回复）。
   *
   * ⚠️ 当前实现是**整轮的 trace**（见
eports.ts 的说明），
   *    因为 AgentProgressEvent 里没有仆人标识。
   *    要按仆人拆分，需要给事件加 servant 字段。
   */
  readonly agentTrace?: AgentTraceData;
  readonly artifacts: readonly {
    readonly kind: string;
    /** 已截断的正文（清单类已合并成字符串） */
    readonly text: string;
    readonly itemCount: number;
  }[];
  readonly findings: readonly {
    readonly kind: string;
    readonly statement: string;
    readonly evidence: readonly string[];
  }[];
  readonly uncertainties: readonly string[];
  readonly needsButlerDecision?: string;
  /** 注入给这个仆人的约束（可审计） */
  readonly injectedConstraints: readonly {
    readonly content: string;
    readonly negotiable: boolean;
  }[];
}

/**
 * 一轮工具循环的可持久化记录。
 *
 * ⚠️ 与 `servantReports` 的区别：这是**过程**（怎么做的），
 *    那个是**结论**（得出了什么）。两者都要，且不能互相替代。
 */
export interface AgentTraceData {
  readonly rounds: readonly {
    readonly round: number;
    /** 该轮的思考（可能为空 —— 实测模型按任务难度分配思考量） */
    readonly reasoning: string;
    /** 该轮模型的正文（对用户说的话） */
    readonly text: string;
    readonly toolCalls: readonly {
      readonly callId: string;
      readonly name: string;
      readonly argsText: string;
      readonly ok: boolean;
      readonly denied: boolean;
      /** 已截断的结果（完整内容看审计视图） */
      readonly output: string;
      readonly durationMs: number;
    }[];
  }[];
  /**
   * 工具循环的真实 token 用量（跨工具轮次累计）。
   *
   * ⚠️ 这是**执行阶段**的用量，不含之后监督/反思的调用；
   *    完整的一轮用量以 verdict.usage 为准。
   */
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly finished: {
    readonly rounds: number;
    readonly reason: string;
  } | null;
}

// ═══════════════════════════════════════════════════════════
// 审查结论（管家的决策点）
// ═══════════════════════════════════════════════════════════

/**
 * 问题的严重度。
 *
 * ★ 这个分级决定了**打回还是照常汇报**，是本项目安全设计的核心区分：
 *
 *   🔴 `blocking`  —— 硬约束冲突。**打回**，并告知用户原因与可选下一步。
 *   🟡 `advisory`  —— 软约束 / 原则违背。**照常汇报**，但在结果上标注。
 *   ⚪ `info`      —— 仅提示，无需动作。
 *
 *   ⚠️ 为什么 `advisory` 不打回：**偏好不是禁令**。
 *      用户偶尔就想吃顿油的，打回等于管家替他做了决定。
 *      而 `blocking` 之所以打回，是因为它涉及安全（如过敏原），
 *      不是偏好。
 */
export type VerdictSeverity = 'blocking' | 'advisory' | 'info';

export interface VerdictIssue {
  readonly severity: VerdictSeverity;
  readonly kind: 'hardConstraint' | 'softConstraint' | 'principle' | 'conflict' | 'omission';
  readonly statement: string;
  /** 涉及哪条记忆（界面要能点开） */
  readonly memoryId?: string;
  readonly memoryContent?: string;
  /** 建议的下一步 */
  readonly suggestion?: string;
}

export type VerdictOutcome =
  /** 通过 —— 管家直接汇报，不需要用户逐个确认 */
  | 'accepted'
  /** 打回 —— 有问题，已告知用户 */
  | 'rejected';

/**
 * 一次审查的结论。
 *
 * ★ 这是**唯一的决策点**（按用户确认的设计）：
 *   执行过程中管家只旁注提醒、不中断；执行完毕才审查并决定通过/打回。
 *   只有一个决策点，就不会出现"执行中被提醒过、结果又变了"这类
 *   无法回答的状态。
 */
export interface Verdict {
  readonly id: string;
  readonly sessionId: string;
  /** 对应的用户请求 */
  readonly forMessageId: string;
  readonly outcome: VerdictOutcome;
  /** 一句话说明（用户看的就是这句） */
  readonly summary: string;
  /** 本轮是否真正进行过监督审查；手动模式下为 false */
  readonly reviewed?: boolean;
  readonly issues: readonly VerdictIssue[];
  /**
   * ★★ v8（批次D）：监督员对**契约判据的逐条核对**。
   *
   * ⚠️ 这是"可核对"最直接的证据：契约里写了几条判据，
   *    监督员就逐条回答"满足了没、差在哪"。
   *    用户展开右栏就能看到——不需要相信管家的自述。
   *
   * ⚠️ 旧结论（v8 之前落的 `session.verdict`）没有这个字段，
   *    重放时补空数组，所以类型上**不能**是必填的 optional 语义混淆 ——
   *    统一按"没有就是 `[]`"处理。
   */
  readonly criteriaChecks: readonly {
    /** 契约里的某一条判据（原文） */
    readonly criterion: string;
    readonly met: boolean;
    /** 没满足时差在哪 */
    readonly note?: string;
  }[];
  /** 本次实际执行了哪些步骤 */
  readonly steps: readonly { readonly stepId: string; readonly servant: string; readonly ok: boolean }[];
  readonly durationMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /**
   * 包含本轮在内的**会话累计**用量。
   *
   * 旧结论没有这个字段；界面按“没有就不显示累计”处理。
   */
  readonly sessionUsage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** 产出物 id（可点开查看） */
  readonly artifactIds: readonly string[];
  readonly createdAt: number;
}

// ═══════════════════════════════════════════════════════════
// 会话
// ═══════════════════════════════════════════════════════════

export interface ChatSession {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 已完成的任务数（用于"第 N 次会话"这类展示） */
  readonly turnCount: number;
  /** 当前会话选定的模型；未选择时由最近使用模型解析。 */
  readonly modelProfileId?: string;
  readonly modelId?: string;
}

/** 界面一次读到的完整状态。 */
export interface SessionSnapshot {
  readonly session: ChatSession;
  readonly messages: readonly ChatMessage[];
  readonly verdicts: readonly Verdict[];
}

// ═══════════════════════════════════════════════════════════
// 仓储
// ═══════════════════════════════════════════════════════════

export interface AppendMessageInput {
  readonly id?: string;
  readonly role: MessageRole;
  readonly servant?: DomainId;
  readonly text: string;
  readonly reasoning?: string;
  readonly reasoningTranslated?: string;
  readonly status?: MessageStatus;
  readonly memoryRefs?: readonly { readonly id: string; readonly content: string }[];
  readonly agentTrace?: AgentTraceData;
  readonly servantReports?: readonly ExecutionReportData[];
  readonly auditRange?: AuditRange;
  readonly reviewSnapshot?: ReviewSnapshot;
}

/**
 * 会话仓储。
 *
 * ⚠️ 与 `MemoryStore` 同一套约定：
 *   · 每次状态变更**落事件**（供重放）
 *   · 提供 `restore*` 注入路径供重放器使用（不发事件）
 */
export class SessionStore {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly messages = new Map<string, ChatMessage[]>();
  private readonly verdicts = new Map<string, Verdict[]>();
  private readonly reviewRuns = new Map<string, ReviewRun[]>();
  private seq = 0;

  constructor(
    private readonly log: EventLog,
    private readonly clock: ClockPort,
    private readonly userId: string,
  ) {}

  // ── 会话 ──

  createSession(id?: string): ChatSession {
    const now = this.clock.now();
    const session: ChatSession = {
      id: id ?? `chat_${(++this.seq).toString(36)}_${now.toString(36)}`,
      userId: this.userId,
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    this.verdicts.set(session.id, []);

    this.log.append({
      type: 'session.forked',
      actor: 'user',
      payload: { sessionId: session.id, note: '新建对话' },
      createdAt: now,
    });

    return session;
  }

  getSession(id: string): ChatSession | undefined {
    return this.sessions.get(id);
  }

  /** 记录会话选择的模型；模型选择是会话状态，不改变消息内容。 */
  setSessionModel(sessionId: string, profileId: string, modelId: string): ChatSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    const now = this.clock.now();
    const next: ChatSession = {
      ...session,
      modelProfileId: profileId,
      modelId,
      updatedAt: now,
    };
    this.sessions.set(sessionId, next);
    this.log.append({
      type: 'session.model',
      actor: 'user',
      payload: { sessionId, profileId, modelId },
      createdAt: now,
    });
    return next;
  }

  /** 取最近一个会话；没有则新建。 */
  latestOrCreate(): ChatSession {
    const all = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return all[0] ?? this.createSession();
  }

  listSessions(): readonly ChatSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ── 消息 ──

  appendMessage(sessionId: string, input: AppendMessageInput): ChatMessage {
    const now = this.clock.now();
    const msg: ChatMessage = {
      id: input.id ?? `msg_${(++this.seq).toString(36)}_${now.toString(36)}`,
      sessionId,
      role: input.role,
      ...(input.servant !== undefined ? { servant: input.servant } : {}),
      text: input.text,
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.reasoningTranslated !== undefined
        ? { reasoningTranslated: input.reasoningTranslated }
        : {}),
      status: input.status ?? 'done',
      createdAt: now,
      ...(input.memoryRefs !== undefined ? { memoryRefs: input.memoryRefs } : {}),
      /**
       * ⚠️ 这一行**必须**有。
       *
       *   我第一版只做了两件事：给 `ChatMessage` 加字段、
       *   在事件 payload 里 spread 它 —— 却**漏了在 `msg` 对象里赋值**。
       *   于是 `msg.agentTrace` 永远是 `undefined`，payload 里的 spread
       *   静默跳过，落盘检查报 `hasAgentTrace=False`，
       *   而内存里的消息明明是有的。
       *
       *   ⚠️ 这类"三处要改只改了两处"的缺口在 TypeScript 下不会报错：
       *      字段是可选的，缺了就是 `undefined`，类型完全合法。
       *      唯一能发现它的方式是**端到端检查落盘结果**。
       */
      ...(input.agentTrace !== undefined ? { agentTrace: input.agentTrace } : {}),
      ...(input.servantReports !== undefined ? { servantReports: input.servantReports } : {}),
      ...(input.auditRange !== undefined ? { auditRange: input.auditRange } : {}),
      ...(input.reviewSnapshot !== undefined ? { reviewSnapshot: input.reviewSnapshot } : {}),
    };

    const list = this.messages.get(sessionId) ?? [];
    list.push(msg);
    this.messages.set(sessionId, list);

    const s = this.sessions.get(sessionId);
    if (s) this.sessions.set(sessionId, { ...s, updatedAt: now });

    this.log.append({
      type: 'session.message',
      actor: input.role === 'user' ? 'user' : input.role === 'servant' ? 'servant' : 'butler',
      ...(input.servant !== undefined ? { servantId: input.servant } : {}),
      payload: {
        sessionId,
        messageId: msg.id,
        role: msg.role,
        text: msg.text.slice(0, 2000),
        status: msg.status,
        hasReasoning: msg.reasoning !== undefined,
        memoryRefCount: msg.memoryRefs?.length ?? 0,
        /**
         * ★ 工具循环过程随消息落盘 —— 刷新后仍能看到「它读了哪个文件」。
         *
         * ⚠️ 我第一版给 `ChatMessage` 加了 `agentTrace` 字段、也在 `runTurn`
         *    里填了值，**但忘了写进事件 payload** ——
         *    于是**内存里有、磁盘上没有**，刷新就丢。
         *    症状是落盘检查报 `hasAgentTrace=False`，而界面上明明有。
         *
         *    这类「加了字段但没落盘」的缺口很隐蔽：
         *    功能在当次会话里表现完全正常，只在重启后才暴露。
         */
        ...(msg.agentTrace !== undefined ? { agentTrace: msg.agentTrace } : {}),
        ...(msg.servantReports !== undefined ? { servantReports: msg.servantReports } : {}),
        ...(msg.auditRange !== undefined ? { auditRange: msg.auditRange } : {}),
        ...(msg.reviewSnapshot !== undefined ? { reviewSnapshot: msg.reviewSnapshot } : {}),
      },
      createdAt: now,
    });

    return msg;
  }

  messagesOf(sessionId: string): readonly ChatMessage[] {
    return this.messages.get(sessionId) ?? [];
  }

  /** 更新一条消息（流式结束、翻译补齐等）。 */
  updateMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<Pick<ChatMessage, 'text' | 'reasoning' | 'reasoningTranslated' | 'status'>>,
  ): ChatMessage | undefined {
    const list = this.messages.get(sessionId);
    if (!list) return undefined;
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx < 0) return undefined;

    const next: ChatMessage = { ...list[idx]!, ...patch };
    list[idx] = next;
    this.messages.set(sessionId, list);

    this.log.append({
      type: 'session.reply',
      actor: 'butler',
      payload: {
        sessionId,
        messageId,
        role: next.role,
        updated: true,
        status: next.status,
        textLength: next.text.length,
        translatedLength: next.reasoningTranslated?.length ?? 0,
      },
      createdAt: this.clock.now(),
    });

    return next;
  }

  // ── 审查结论 ──

  addVerdict(
    sessionId: string,
    input: Omit<Verdict, 'id' | 'sessionId' | 'createdAt'>,
  ): Verdict {
    const now = this.clock.now();
    const verdict: Verdict = {
      ...input,
      id: `vd_${(++this.seq).toString(36)}_${now.toString(36)}`,
      sessionId,
      createdAt: now,
    };

    const list = this.verdicts.get(sessionId) ?? [];
    list.push(verdict);
    this.verdicts.set(sessionId, list);

    const s = this.sessions.get(sessionId);
    if (s) {
      this.sessions.set(sessionId, { ...s, turnCount: s.turnCount + 1, updatedAt: now });
    }

    /**
     * ★ 审查结论必须落事件 —— 它是**管家唯一的决策点**，
     *   也是回退时的判断依据（"这一步没通过，回退到出问题的那步"）。
     */
    this.log.append({
      type: 'session.verdict',
      actor: 'butler',
      payload: {
        sessionId,
        verdictId: verdict.id,
        forMessageId: input.forMessageId,
        outcome: input.outcome,
        summary: input.summary,
        issueCount: input.issues.length,
        blockingCount: input.issues.filter((i) => i.severity === 'blocking').length,
        criteriaChecks: input.criteriaChecks,
        steps: input.steps,
        durationMs: input.durationMs,
        usage: input.usage,
        ...(input.sessionUsage !== undefined ? { sessionUsage: input.sessionUsage } : {}),
        artifactIds: input.artifactIds,
      },
      createdAt: now,
    });

    return verdict;
  }

  verdictsOf(sessionId: string): readonly Verdict[] {
    return this.verdicts.get(sessionId) ?? [];
  }

  reviewRunsOf(sessionId: string): readonly ReviewRun[] {
    return this.reviewRuns.get(sessionId) ?? [];
  }

  /** 记录一次手动复核报告（ReviewRun）。 */
  appendReviewRun(input: Omit<ReviewRun, 'id' | 'createdAt'>): ReviewRun {
    const now = this.clock.now();
    const run: ReviewRun = {
      ...input,
      id: `review_${(++this.seq).toString(36)}_${now.toString(36)}`,
      createdAt: now,
    };
    const list = this.reviewRuns.get(run.sessionId) ?? [];
    list.push(run);
    this.reviewRuns.set(run.sessionId, list);
    this.log.append({
      type: 'review.run',
      actor: 'supervisor',
      payload: { sessionId: run.sessionId, run },
      createdAt: now,
    });
    return run;
  }

  // ── 快照与重放注入 ──

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return {
      session,
      messages: this.messagesOf(sessionId),
      verdicts: this.verdictsOf(sessionId),
    };
  }

  allSessionIds(): readonly string[] {
    return [...this.sessions.keys()];
  }

  /**
   * 重放注入。⚠️ 只应由重放器调用 —— 它**不发事件**。
   */
  restoreSession(session: ChatSession): void {
    this.sessions.set(session.id, session);
    if (!this.messages.has(session.id)) this.messages.set(session.id, []);
    if (!this.verdicts.has(session.id)) this.verdicts.set(session.id, []);
    if (!this.reviewRuns.has(session.id)) this.reviewRuns.set(session.id, []);
  }

  restoreMessage(msg: ChatMessage): void {
    const list = this.messages.get(msg.sessionId) ?? [];
    if (!list.some((m) => m.id === msg.id)) list.push(msg);
    this.messages.set(msg.sessionId, list);
  }

  restoreVerdict(v: Verdict): void {
    const list = this.verdicts.get(v.sessionId) ?? [];
    if (!list.some((x) => x.id === v.id)) list.push(v);
    this.verdicts.set(v.sessionId, list);
  }

  restoreReviewRun(run: ReviewRun): void {
    const list = this.reviewRuns.get(run.sessionId) ?? [];
    if (!list.some((x) => x.id === run.id)) list.push(run);
    this.reviewRuns.set(run.sessionId, list);
  }
}

// ═══════════════════════════════════════════════════════════
// 重放
// ═══════════════════════════════════════════════════════════

/** 与会话状态相关的事件类型。 */
export const SESSION_STATE_EVENTS: readonly string[] = [
  'session.forked',
  'session.model',
  'session.message',
  'session.reply',
  'session.verdict',
  'review.run',
];

export interface ReplaySessionResult {
  readonly sessions: readonly ChatSession[];
  readonly messages: readonly ChatMessage[];
  readonly verdicts: readonly Verdict[];
  readonly reviewRuns: readonly ReviewRun[];
  readonly consumedEvents: number;
}

/**
 * 从事件流重建会话状态。
 *
 * ⚠️ 与记忆 / 产出物同一套约定：
 *   · 纯函数，不碰 store、不发事件
 *   · 不猜测缺失信息 —— 信息不足的事件如实跳过
 *
 * ★ 为什么对话也要能重放：
 *   方案 § 5.2 把"对话"列为回退必须覆盖的三方之一。
 *   如果对话只活在界面内存里，回退后就无法回答
 *   「当时用户到底说了什么、我为什么这么做」。
 */
export function replaySessions(
  events: readonly { readonly type: string; readonly payload: unknown; readonly createdAt: number }[],
): ReplaySessionResult {
  const sessions = new Map<string, ChatSession>();
  const messages: ChatMessage[] = [];
  const verdicts: Verdict[] = [];
  const reviewRuns: ReviewRun[] = [];
  let consumed = 0;

  for (const e of events) {
    if (!SESSION_STATE_EVENTS.includes(e.type)) continue;
    consumed += 1;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const sessionId = typeof p['sessionId'] === 'string' ? p['sessionId'] : null;

    if (e.type === 'session.forked') {
      if (sessionId === null) continue;
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          id: sessionId,
          userId: '',
          title: '新对话',
          createdAt: e.createdAt,
          updatedAt: e.createdAt,
          turnCount: 0,
        });
      }
      continue;
    }

    if (e.type === 'session.model') {
      if (sessionId === null) continue;
      const profileId = typeof p['profileId'] === 'string' ? p['profileId'] : null;
      const modelId = typeof p['modelId'] === 'string' ? p['modelId'] : null;
      if (profileId === null || modelId === null) continue;
      const session = sessions.get(sessionId);
      if (session !== undefined) {
        sessions.set(sessionId, {
          ...session,
          modelProfileId: profileId,
          modelId,
          updatedAt: e.createdAt,
        });
      }
      continue;
    }

    if (sessionId === null) continue;

    if (e.type === 'session.message') {
      const messageId = p['messageId'];
      if (typeof messageId !== 'string') continue;
      const role = p['role'];
      const trace = p['agentTrace'];
      /**
       * ⚠️ 这两处**必须走解析器，不能用 as 断言**。
       *
       *   事故记录：给仆人产出加必填字段 reply 之后，首页直接 500 ——
       *   旧落盘数据里没有该字段，而 as ExecutionReportData[] 只贴类型标签、
       *   不做任何检查，于是 cur.reply.length 在运行时炸掉。
       *
       *   ★ 纪律：**跨持久化边界的数据是不可信输入。**
       *     旧版本代码写下的数据，与新版本的假设必然不一致。
       *
       * ⚠️ 取局部变量再判定：`exactOptionalPropertyTypes` 下，
       *    在 spread 里**就地调用函数不会触发收窄** ——
       *    于是 { agentTrace: X | undefined } 不满足 { agentTrace?: X }。
       */
      const replayedTrace = parseAgentTrace(trace);
      const replayedReports = parseExecutionReports(p['servantReports']);
      const rawRange = p['auditRange'];
      const auditRange =
        typeof rawRange === 'object' &&
        rawRange !== null &&
        typeof (rawRange as { fromSeq?: unknown }).fromSeq === 'number' &&
        typeof (rawRange as { toSeq?: unknown }).toSeq === 'number'
          ? {
              fromSeq: (rawRange as { fromSeq: number }).fromSeq,
              toSeq: (rawRange as { toSeq: number }).toSeq,
            }
          : undefined;
      const rawSnapshot = p['reviewSnapshot'];
      const reviewSnapshot =
        typeof rawSnapshot === 'object' &&
        rawSnapshot !== null &&
        typeof (rawSnapshot as { userGoal?: unknown }).userGoal === 'string' &&
        typeof (rawSnapshot as { contract?: unknown }).contract === 'object' &&
        (rawSnapshot as { contract?: unknown }).contract !== null &&
        Array.isArray((rawSnapshot as { hardConstraints?: unknown }).hardConstraints) &&
        typeof (rawSnapshot as { outputSummary?: unknown }).outputSummary === 'string'
          ? (rawSnapshot as ReviewSnapshot)
          : undefined;

      messages.push({
        id: messageId,
        sessionId,
        role: (typeof role === 'string' ? role : 'butler') as MessageRole,
        text: typeof p['text'] === 'string' ? p['text'] : '',
        status: (typeof p['status'] === 'string' ? p['status'] : 'done') as MessageStatus,
        createdAt: e.createdAt,
        ...(replayedTrace !== undefined ? { agentTrace: replayedTrace } : {}),
        ...(replayedReports !== undefined ? { servantReports: replayedReports } : {}),
        ...(auditRange !== undefined ? { auditRange } : {}),
        ...(reviewSnapshot !== undefined ? { reviewSnapshot } : {}),
      });
      touch(sessions, sessionId, e.createdAt);
      continue;
    }

    if (e.type === 'session.reply') {
      // 回复是"更新已有消息"，重放时按 messageId 合并
      const messageId = p['messageId'];
      if (typeof messageId !== 'string') continue;
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx < 0) continue;
      const existing = messages[idx]!;
      messages[idx] = {
        ...existing,
        status: (typeof p['status'] === 'string' ? p['status'] : existing.status) as MessageStatus,
      };
      touch(sessions, sessionId, e.createdAt);
      continue;
    }

    if (e.type === 'session.verdict') {
      const verdictId = p['verdictId'];
      if (typeof verdictId !== 'string') continue;
      verdicts.push({
        id: verdictId,
        sessionId,
        forMessageId: typeof p['forMessageId'] === 'string' ? p['forMessageId'] : '',
        outcome: (p['outcome'] === 'rejected' ? 'rejected' : 'accepted') as VerdictOutcome,
        summary: typeof p['summary'] === 'string' ? p['summary'] : '',
        issues: [],
        criteriaChecks: Array.isArray(p['criteriaChecks'])
          ? (p['criteriaChecks'] as { criterion: string; met: boolean; note?: string }[])
          : [],
        steps: Array.isArray(p['steps'])
          ? (p['steps'] as { stepId: string; servant: DomainId; ok: boolean }[])
          : [],
        durationMs: typeof p['durationMs'] === 'number' ? p['durationMs'] : 0,
        usage: {
          inputTokens:
            typeof p['usage'] === 'object' && p['usage'] !== null &&
            typeof (p['usage'] as Record<string, unknown>)['inputTokens'] === 'number'
              ? ((p['usage'] as Record<string, unknown>)['inputTokens'] as number)
              : 0,
          outputTokens:
            typeof p['usage'] === 'object' && p['usage'] !== null &&
            typeof (p['usage'] as Record<string, unknown>)['outputTokens'] === 'number'
              ? ((p['usage'] as Record<string, unknown>)['outputTokens'] as number)
              : 0,
        },
        ...(typeof p['sessionUsage'] === 'object' && p['sessionUsage'] !== null &&
        typeof (p['sessionUsage'] as Record<string, unknown>)['inputTokens'] === 'number' &&
        typeof (p['sessionUsage'] as Record<string, unknown>)['outputTokens'] === 'number'
          ? {
              sessionUsage: {
                inputTokens: (p['sessionUsage'] as Record<string, unknown>)['inputTokens'] as number,
                outputTokens: (p['sessionUsage'] as Record<string, unknown>)['outputTokens'] as number,
              },
            }
          : {}),
        artifactIds: Array.isArray(p['artifactIds']) ? (p['artifactIds'] as string[]) : [],
        createdAt: e.createdAt,
      });
      const s = sessions.get(sessionId);
      if (s) sessions.set(sessionId, { ...s, turnCount: s.turnCount + 1, updatedAt: e.createdAt });
      continue;
    }

    if (e.type === 'review.run') {
      const rawRun = p['run'];
      if (
        typeof rawRun === 'object' &&
        rawRun !== null &&
        typeof (rawRun as { id?: unknown }).id === 'string' &&
        typeof (rawRun as { sessionId?: unknown }).sessionId === 'string'
      ) {
        reviewRuns.push(rawRun as ReviewRun);
        touch(sessions, sessionId, e.createdAt);
      }
      continue;
    }
  }

  return {
    sessions: [...sessions.values()],
    messages,
    verdicts,
    reviewRuns,
    consumedEvents: consumed,
  };
}

function touch(sessions: Map<string, ChatSession>, id: string, at: number): void {
  const s = sessions.get(id);
  if (s) sessions.set(id, { ...s, updatedAt: at });
  else
    sessions.set(id, {
      id,
      userId: '',
      title: '新对话',
      createdAt: at,
      updatedAt: at,
      turnCount: 0,
    });
}