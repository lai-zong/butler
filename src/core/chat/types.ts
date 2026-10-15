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
import type { ServantId } from '../servants/types.js';

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
export interface ChatMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MessageRole;
  /** role === 'servant' 时是哪个仆人 */
  readonly servant?: ServantId;
  /** 正文（markdown） */
  readonly text: string;
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
  /** 这条回复引用了哪些记忆（界面上要能点开看"凭什么这么说"） */
  readonly memoryRefs?: readonly { readonly id: string; readonly content: string }[];
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
  readonly issues: readonly VerdictIssue[];
  /** 本次实际执行了哪些步骤 */
  readonly steps: readonly { readonly stepId: string; readonly servant: ServantId; readonly ok: boolean }[];
  readonly durationMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
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
  readonly servant?: ServantId;
  readonly text: string;
  readonly reasoning?: string;
  readonly reasoningTranslated?: string;
  readonly status?: MessageStatus;
  readonly memoryRefs?: readonly { readonly id: string; readonly content: string }[];
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
        steps: input.steps,
        durationMs: input.durationMs,
        artifactIds: input.artifactIds,
      },
      createdAt: now,
    });

    return verdict;
  }

  verdictsOf(sessionId: string): readonly Verdict[] {
    return this.verdicts.get(sessionId) ?? [];
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
}

// ═══════════════════════════════════════════════════════════
// 重放
// ═══════════════════════════════════════════════════════════

/** 与会话状态相关的事件类型。 */
export const SESSION_STATE_EVENTS: readonly string[] = [
  'session.forked',
  'session.message',
  'session.reply',
  'session.verdict',
];

export interface ReplaySessionResult {
  readonly sessions: readonly ChatSession[];
  readonly messages: readonly ChatMessage[];
  readonly verdicts: readonly Verdict[];
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

    if (sessionId === null) continue;

    if (e.type === 'session.message') {
      const messageId = p['messageId'];
      if (typeof messageId !== 'string') continue;
      const role = p['role'];
      messages.push({
        id: messageId,
        sessionId,
        role: (typeof role === 'string' ? role : 'butler') as MessageRole,
        text: typeof p['text'] === 'string' ? p['text'] : '',
        status: (typeof p['status'] === 'string' ? p['status'] : 'done') as MessageStatus,
        createdAt: e.createdAt,
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
        steps: Array.isArray(p['steps'])
          ? (p['steps'] as { stepId: string; servant: ServantId; ok: boolean }[])
          : [],
        durationMs: typeof p['durationMs'] === 'number' ? p['durationMs'] : 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        artifactIds: Array.isArray(p['artifactIds']) ? (p['artifactIds'] as string[]) : [],
        createdAt: e.createdAt,
      });
      const s = sessions.get(sessionId);
      if (s) sessions.set(sessionId, { ...s, turnCount: s.turnCount + 1, updatedAt: e.createdAt });
      continue;
    }
  }

  return {
    sessions: [...sessions.values()],
    messages,
    verdicts,
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