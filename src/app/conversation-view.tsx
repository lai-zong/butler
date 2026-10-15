'use client';

/**
 * 对话界面 —— 本次的重点
 *
 * 设计依据：用户手绘布局 + 方案 § 13.3（流式呈现）、§ 13.4（状态可视化）
 *
 * ★ 版式（用户图一）：
 *     ┌──────────────────────────────┐
 *     │ 顶栏（空壳，可收起）           │
 *     ├────┬─────────────────────────┤
 *     │ 侧 │  对话（消息流 + 输入框）  │
 *     │ 栏 │                          │
 *     └────┴─────────────────────────┘
 *
 * ★★ 滚动结构（最容易踩的坑，见下方注释）：
 *     页面不滚 → 消息区自己滚 → 输入框固定在面板底部
 *     如果让页面滚，用户打了半句话往上翻记录，**输入框就跑出视口了**。
 *
 * ★ 一处刻意的设计：**不用逐字符动画**
 *   方案 § 13.3 写了"字符级流式，每 tick 1—4 字符"。
 *   但当前后端是**阶段级进度**（整段返回），不是 token 级流。
 *   伪造逐字动画会让"流式"变成假的 —— 用户以为在实时生成，
 *   实际整段早已返回。所以现在展示**真实进度**（阶段 + 步骤），
 *   等接上 token 级流式（core/stream 已实现，待接）再上逐字渲染。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { CollapsibleRegion } from './collapsible-region';
import { RichContent } from './rich-content';

// ═══════════════════════════════════════════════════════════
// 类型（与服务端一致）
// ═══════════════════════════════════════════════════════════

interface Message {
  readonly id: string;
  readonly role: 'user' | 'butler' | 'servant' | 'system';
  readonly text: string;
  readonly status: string;
  readonly createdAt: number;
  readonly memoryRefs?: readonly { readonly id: string; readonly content: string }[];
  /** ★ 工具循环过程（随消息持久化，刷新后仍可见） */
  readonly agentTrace?: PersistedTrace;
}

interface VerdictIssue {
  readonly severity: 'blocking' | 'advisory' | 'info';
  readonly kind: string;
  readonly statement: string;
  readonly memoryContent?: string;
  readonly suggestion?: string;
}

interface Verdict {
  readonly id: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly summary: string;
  readonly issues: readonly VerdictIssue[];
  readonly steps: readonly { readonly stepId: string; readonly servant: string; readonly ok: boolean }[];
  readonly durationMs: number;
}

/** 本轮的 seq 区间 —— 界面据此按需拉取审计依据。 */
interface AuditRange {
  readonly fromSeq: number;
  readonly toSeq: number;
}

/**
 * 流式叙述状态（与 core/stream/narrate.ts 的 NarrationState 一致）。
 *
 * ⚠️ easoning 可能为空 —— 实测模型思考量波动很大（0—844 字，
 *    偶发为 0）。**界面不能假设一定有思考**，要按空处理。
 */
interface NarrationState {
  readonly reasoning: string;
  readonly reasoningTranslated: string;
  readonly answer: string;
  readonly firstChunkMs: number | null;
  readonly done: boolean;
}

/**
 * 工具调用（界面卡片的一条）。
 *
 * ★ 这是 dsh / codex 那种画面的核心元素：
 *   「▸ 调用 read_file → ⚙ 执行 → ✓ 结果 26 字（2ms）」。
 *
 * ⚠️ 参数是**分片拼出来的**，所以要能表现"还在长"的状态
 *    （`partial: true` 时参数不完整，界面不该尝试解析它）。
 */
interface ToolCallView {
  readonly callId: string;
  readonly name: string;
  /** 累积的参数 JSON 字符串（分片拼接） */
  readonly argsText: string;
  /** 参数是否拼完了 */
  readonly argsComplete: boolean;
  readonly started: boolean;
  readonly result?: {
    readonly ok: boolean;
    readonly denied: boolean;
    readonly output: string;
    readonly durationMs: number;
  };
}

/** 一轮 Agent 循环（界面上是一个可折叠的分组）。 */
interface AgentRound {
  readonly round: number;
  readonly maxRounds: number;
  readonly reasoning: string;
  readonly text: string;
  readonly toolCalls: readonly ToolCallView[];
}

/**
 * 本轮的 Agent 过程（「思考 → 工具 → 再思考」）。
 *
 * ⚠️ 与 `narration` 的区别（两者都在界面上出现，容易混）：
 *   · `narration` —— 管家在**仆人干活期间**说的那段话（另一次调用，1.6—2.4s）
 *   · `agent`     —— **仆人真正干活的工具循环**（思考 + 调工具 + 看结果）
 *
 *   前者是"交代安排"，后者是"实际动作"。用户想看的画面主要是后者。
 */
interface AgentTrace {
  readonly rounds: readonly AgentRound[];
  readonly finished: {
    readonly rounds: number;
    readonly hitRoundLimit: boolean;
    readonly reason: string;
  } | null;
}

/**
 * 持久化形状（与 `core/chat/types.ts` 的 `AgentTraceData` 对应）。
 *
 * ⚠️ 与 `AgentTrace` 的区别只在**工具调用**：
 *   持久化时不需要 `argsComplete` / `started` ——
 *   那两个是**流式期间**的中间状态（「参数还在长」「刚开始执行」），
 *   存下来没有意义。
 *
 *   → 由 `normalizeTrace()` 把它转成渲染形状，
 *     组件因此只需处理**一种**形状（否则渲染里到处要判两种形状）。
 */
interface PersistedTrace {
  readonly rounds: readonly {
    readonly round: number;
    readonly maxRounds: number;
    readonly reasoning: string;
    readonly text: string;
    readonly toolCalls: readonly {
      readonly callId: string;
      readonly name: string;
      readonly argsText: string;
      readonly ok: boolean;
      readonly denied: boolean;
      readonly output: string;
      readonly durationMs: number;
    }[];
  }[];
  readonly finished: AgentTrace['finished'];
}

/**
 * 把持久化形状归一化成渲染形状。
 *
 * ★ 已完成的调用一律 `argsComplete: true, started: true` ——
 *   能从事件流里存下来的，必然是已经执行过的。
 */
function normalizeTrace(t: PersistedTrace): AgentTrace {
  return {
    rounds: t.rounds.map((r) => ({
      round: r.round,
      maxRounds: r.maxRounds,
      reasoning: r.reasoning,
      text: r.text,
      toolCalls: r.toolCalls.map((tc) => ({
        callId: tc.callId,
        name: tc.name,
        argsText: tc.argsText,
        argsComplete: true,
        started: true,
        result: {
          ok: tc.ok,
          denied: tc.denied,
          output: tc.output,
          durationMs: tc.durationMs,
        },
      })),
    })),
    finished: t.finished,
  };
}

// ═══════════════════════════════════════════════════════════
// 审计依据（`/api/audit` 的返回形状）
// ═══════════════════════════════════════════════════════════

interface AuditData {
  readonly recalls: readonly {
    readonly seq: number;
    readonly count: number;
    readonly items: readonly {
      readonly memoryId: string;
      readonly memClassLabel: string;
      readonly relevancePercent: number;
      readonly forced: boolean;
    }[];
  }[];
  readonly injections: readonly {
    readonly seq: number;
    readonly servantLabel: string;
    readonly content: string;
    readonly sourceLabel: string;
    readonly negotiable: boolean;
    readonly reason: string;
  }[];
  readonly hardChecks: readonly {
    readonly seq: number;
    readonly content: string;
    readonly unhandledByLabels: readonly string[];
    readonly deterministic: boolean;
    readonly note: string;
  }[];
  readonly grants: readonly {
    readonly seq: number;
    readonly kindLabel: string;
    readonly toServantLabel: string;
    readonly reason: string;
    readonly expired: boolean;
  }[];
  readonly writeAttempts: readonly {
    readonly seq: number;
    readonly actor: string;
    readonly reason: string;
    readonly rejected: boolean;
  }[];
  readonly summary: string;
}

interface ProgressLine {
  readonly id: string;
  readonly kind: 'stage' | 'step' | 'done';
  readonly text: string;
  readonly tone: 'run' | 'ok' | 'warn';
}

const SERVANT_LABEL: Record<string, string> = {
  life: '生活仆人',
  health: '健康仆人',
  study: '学习仆人',
  work: '办公仆人',
  code: '代码仆人',
  butler: '管家',
};

const SEVERITY_LABEL: Record<string, string> = {
  blocking: '不可协商',
  advisory: '需留意',
  info: '提示',
};

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════

export function ConversationView({
  initialMessages,
  sessionId: initialSessionId,
  modelConfigured,
  restoreSummary,
}: {
  readonly initialMessages: readonly Message[];
  readonly sessionId: string | null;
  readonly modelConfigured: boolean;
  readonly restoreSummary: string;
}) {
  const [messages, setMessages] = useState<Message[]>([...initialMessages]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  /** 本轮的 seq 区间 —— 用于按需拉取审计依据 */
  const [auditRange, setAuditRange] = useState<AuditRange | null>(null);
  /**
   * 流式叙述状态。
   *
   * ★ 这是「流式输出渲染」的落点 —— 内容**逐字**到达，
   *   而不是等全部生成完再一次性显示。
   *
   *   实测：首片延迟 629—947ms，叙述整体 1.6—2.4 秒；
   *   而仆人执行要 30—60 秒。所以叙述基本会在死时间里先说完。
   */
  const [narration, setNarration] = useState<NarrationState | null>(null);
  /** 思考区是否展开（默认收起：思考是过程，不是结论） */
  const [showReasoning, setShowReasoning] = useState(false);
  /**
   * ★★ 本轮的工具循环过程 —— 「思考 → 工具 → 再思考」画面。
   *
   *   这是用户真正想看的那个东西：仆人**实际在调什么工具、拿到什么结果**。
   */
  const [agent, setAgent] = useState<AgentTrace>({ rounds: [], finished: null });
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 自动滚到底 —— 但**用户手动上滚时暂停**（方案 § 13.3 明确要求）。
   * 否则用户想看历史记录，会被不断拉回底部。
   */
  const pinnedToBottom = useRef(true);

  const scrollToBottom = useCallback((force = false): void => {
    const el = scrollRef.current;
    if (!el) return;
    if (!pinnedToBottom.current && !force) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    // 距底部 40px 以内算"贴着底部"
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    scrollToBottom();
    // 叙述逐字增长也要跟随，否则内容在视口外长出来，用户看不到「流」
  }, [messages, progress, narration, agent, scrollToBottom]);

  // ── 发送 ──

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (text.length === 0 || busy) return;

    setBusy(true);
    setError(null);
    setVerdict(null);
    setAuditRange(null);
    setNarration(null);
    setShowReasoning(false);
    setAgent({ rounds: [], finished: null });
    setProgress([]);
    setInput('');
    pinnedToBottom.current = true;

    // 乐观追加用户消息（服务端会返回真实 id 覆盖）
    const tempId = `temp_${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: tempId, role: 'user', text, status: 'done', createdAt: Date.now() },
    ]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...(sessionId !== null ? { sessionId } : {}) }),
      });

      if (!res.ok || res.body === null) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `请求失败（HTTP ${res.status}）`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE：按空行切分事件
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            handleEvent(JSON.parse(line.slice(6)) as Record<string, unknown>);
          }
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress((p) => p.map((x) => (x.tone === 'run' ? { ...x, tone: 'ok' as const } : x)));
    }
  };

  const handleEvent = (e: Record<string, unknown>): void => {
    const type = e['type'];

    if (type === 'session') {
      const sid = e['sessionId'];
      if (typeof sid === 'string') setSessionId(sid);
      return;
    }

    if (type === 'progress') {
      const ev = e['event'] as Record<string, unknown> | undefined;
      if (!ev) return;
      const kind = ev['kind'];

      if (kind === 'stage') {
        const label = String(ev['label'] ?? '');
        setProgress((p) => [
          // 阶段是"当前状态"，替换上一次的 run 项而不是无限追加
          ...p.filter((x) => x.kind !== 'stage' || x.tone !== 'run'),
          { id: `st_${Date.now()}_${label}`, kind: 'stage', text: label, tone: 'run' },
        ]);
      } else if (kind === 'stepStarted') {
        const servant = SERVANT_LABEL[String(ev['servant'])] ?? String(ev['servant']);
        setProgress((p) => [
          ...p.map((x) => (x.tone === 'run' ? { ...x, tone: 'ok' as const } : x)),
          {
            id: `sp_${String(ev['stepId'])}`,
            kind: 'step',
            text: `派发给${servant}（第 ${String(ev['index'])}/${String(ev['total'])} 步）`,
            tone: 'run',
          },
        ]);
      } else if (kind === 'stepDone') {
        const servant = SERVANT_LABEL[String(ev['servant'])] ?? String(ev['servant']);
        setProgress((p) =>
          p.map((x) =>
            x.id === `sp_${String(ev['stepId'])}`
              ? {
                  ...x,
                  tone: 'ok' as const,
                  text: `${servant}完成（产出 ${String(ev['artifactCount'])} 项）`,
                }
              : x,
          ),
        );
      } else if (kind === 'stepFailed') {
        const servant = SERVANT_LABEL[String(ev['servant'])] ?? String(ev['servant']);
        setProgress((p) =>
          p.map((x) =>
            x.id === `sp_${String(ev['stepId'])}`
              ? { ...x, tone: 'warn' as const, text: `${servant}未能完成：${String(ev['reason'])}` }
              : x,
          ),
        );
      }
      return;
    }

    if (type === 'reply') {
      const text = String(e['text'] ?? '');
      const id = String(e['messageId'] ?? `butler_${Date.now()}`);
      setMessages((m) => [
        ...m,
        { id, role: 'butler', text, status: 'done', createdAt: Date.now() },
      ]);
      return;
    }

    if (type === 'verdict') {
      setVerdict(e['verdict'] as Verdict);
      return;
    }

    if (type === 'audit') {
      const r = e['range'] as AuditRange | undefined;
      if (r !== undefined) setAuditRange(r);
      return;
    }

    if (type === 'agent') {
      handleAgentEvent(e);
      return;
    }

    if (type === 'narration') {
      // ⚠️ 整体替换而不是累加 —— 服务端推的是**累计**内容。
      //    累加会变成重复文本，而这类 bug 在流式里很常见且很难一眼看出。
      setNarration({
        reasoning: String(e['reasoning'] ?? ''),
        reasoningTranslated: String(e['reasoningTranslated'] ?? ''),
        answer: String(e['answer'] ?? ''),
        firstChunkMs: typeof e['firstChunkMs'] === 'number' ? e['firstChunkMs'] : null,
        done: e['done'] === true,
      });
      return;
    }

    if (type === 'error') {
      setError(String(e['message'] ?? '未知错误'));
    }
  };

  /**
   * 处理工具循环的进度事件。
   *
   * ★★ 这是「思考 → 工具 → 再思考」画面的拼装处。
   *
   * ⚠️ 三条要点：
   *   ① 事件里带 `round` —— 界面据此把内容归到对应轮次（可折叠分组）
   *   ② `toolCall` 分片是**累积**的（`argsDelta` 逐段拼），
   *      所以这里也累积；而 `reasoning`/`text` 的 `accumulated`
   *      是服务端已经累好的，**整体替换**
   *   ③ 参数拼完（`partial: false`）才标记 `argsComplete` ——
   *      在那之前界面不该尝试解析或展示参数内容
   */
  const handleAgentEvent = (e: Record<string, unknown>): void => {
    const kind = String(e['kind'] ?? '');

    setAgent((prev) => {
      const rounds = [...prev.rounds];

      const ensureRound = (n: number): AgentRound => {
        const idx = rounds.findIndex((r) => r.round === n);
        if (idx >= 0) return rounds[idx]!;
        const fresh: AgentRound = {
          round: n,
          maxRounds: typeof e['maxRounds'] === 'number' ? e['maxRounds'] : 0,
          reasoning: '',
          text: '',
          toolCalls: [],
        };
        rounds.push(fresh);
        return fresh;
      };

      const putRound = (r: AgentRound): void => {
        const idx = rounds.findIndex((x) => x.round === r.round);
        if (idx >= 0) rounds[idx] = r;
      };

      if (kind === 'round') {
        ensureRound(typeof e['round'] === 'number' ? e['round'] : 1);
        return { rounds, finished: prev.finished };
      }

      if (kind === 'reasoning') {
        const r = ensureRound(typeof e['round'] === 'number' ? e['round'] : 1);
        // 整体替换（服务端已累好）
        putRound({ ...r, reasoning: String(e['accumulated'] ?? '') });
        return { rounds, finished: prev.finished };
      }

      if (kind === 'text') {
        const r = ensureRound(typeof e['round'] === 'number' ? e['round'] : 1);
        putRound({ ...r, text: String(e['accumulated'] ?? '') });
        return { rounds, finished: prev.finished };
      }

      if (kind === 'toolCall') {
        const r = ensureRound(typeof e['round'] === 'number' ? e['round'] : 1);
        const callId = String(e['callId'] ?? '');
        const name = String(e['name'] ?? '');
        const delta = String(e['argsDelta'] ?? '');
        const complete = e['partial'] === false;

        const list = [...r.toolCalls];
        const i = list.findIndex(
          (t) => t.callId === callId || (name.length > 0 && t.name === name && !t.argsComplete),
        );

        if (i < 0) {
          list.push({
            callId,
            name,
            argsText: delta,
            argsComplete: complete,
            started: false,
          });
        } else {
          const cur = list[i]!;
          list[i] = {
            ...cur,
            name: name.length > 0 ? name : cur.name,
            argsText: cur.argsText + delta,
            argsComplete: complete || cur.argsComplete,
          };
        }

        putRound({ ...r, toolCalls: list });
        return { rounds, finished: prev.finished };
      }

      if (kind === 'toolStarted' || kind === 'toolResult') {
        const r = ensureRound(typeof e['round'] === 'number' ? e['round'] : 1);
        const callId = String(e['callId'] ?? '');
        const list = r.toolCalls.map((t) => {
          if (t.callId !== callId) return t;
          if (kind === 'toolStarted') return { ...t, started: true };
          return {
            ...t,
            started: true,
            argsComplete: true,
            result: {
              ok: e['ok'] === true,
              denied: e['denied'] === true,
              output: String(e['output'] ?? ''),
              durationMs: typeof e['durationMs'] === 'number' ? e['durationMs'] : 0,
            },
          };
        });
        putRound({ ...r, toolCalls: list });
        return { rounds, finished: prev.finished };
      }

      if (kind === 'finished') {
        return {
          rounds,
          finished: {
            rounds: typeof e['rounds'] === 'number' ? e['rounds'] : rounds.length,
            hitRoundLimit: e['hitRoundLimit'] === true,
            reason: String(e['reason'] ?? ''),
          },
        };
      }

      return prev;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter 发送，Shift+Enter 换行 —— 聊天界面的通用约定
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="app-frame">
      {/* ── 顶栏：只做展开/收起的机构，内容留空（按用户要求）── */}
      <CollapsibleRegion
        id="topbar"
        edge="top"
        defaultOpen={false}
        collapsedSize={28}
        expandedSize={72}
        collapsedLabel="▼ 顶栏（待设计）"
        title="顶栏（待设计）"
      />

      <div className="app-body">
        {/* ── 侧栏：同样只做机构 ── */}
        <CollapsibleRegion
          id="sidebar"
          edge="left"
          defaultOpen={false}
          collapsedSize={44}
          expandedSize={208}
          collapsedLabel={<span className="stub-vertical">侧栏</span>}
          title="侧栏（待设计）"
        />

        {/* ── 中间：对话界面 ── */}
        <main className="chat-pane">
          <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="chat-inner">
              {messages.length === 0 && progress.length === 0 && (
                <div className="chat-empty">
                  <div className="chat-empty-title">对管家说点什么</div>
                  <div className="chat-empty-sub">
                    {restoreSummary}
                  </div>
                </div>
              )}

              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}

              {/* ── 实时进度（真实的阶段与步骤，不是伪造的逐字动画）── */}
              {progress.length > 0 && (
                <div className="progress-block">
                  {progress.map((p) => (
                    <div className="progress-line" key={p.id}>
                      <span className={`progress-dot progress-dot-${p.tone}`} />
                      <span className={p.tone === 'run' ? 'progress-text-run' : 'progress-text'}>
                        {p.text}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* ── 流式叙述：管家边说边想 ── */}
              {narration !== null &&
                (narration.answer.length > 0 || narration.reasoning.length > 0) && (
                  <NarrationBlock
                    state={narration}
                    showReasoning={showReasoning}
                    onToggleReasoning={() => setShowReasoning((v) => !v)}
                  />
                )}

              {/* ── ★ 工具循环过程：思考 → 工具 → 再思考 ── */}
              {agent.rounds.length > 0 && <AgentTraceView trace={agent} />}

              {/* ── 审查结论 ── */}
              {verdict !== null && (
                <VerdictCard
                  verdict={verdict}
                  {...(auditRange !== null ? { range: auditRange } : {})}
                />
              )}

              {error !== null && (
                <div className="notice notice-warn" style={{ marginTop: 12 }}>
                  <div>{error}</div>
                </div>
              )}
            </div>
          </div>

          {/* ── 输入框：固定在面板底部，不随消息滚动 ── */}
          <div className="composer">
            {!modelConfigured && (
              <div className="composer-hint composer-hint-warn">
                未配置模型（.env.local 缺 DEEPSEEK_API_KEY）—— 对话不可用，
                但「记忆库」等治理页面仍可使用。
              </div>
            )}
            <div className="composer-row">
              <textarea
                ref={inputRef}
                className="composer-input"
                placeholder={modelConfigured ? '对管家说…（Enter 发送，Shift+Enter 换行）' : '对话不可用'}
                value={input}
                disabled={!modelConfigured || busy}
                rows={1}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={!modelConfigured || busy || input.trim().length === 0}
                onClick={() => void send()}
              >
                {busy ? '执行中…' : '发送'}
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 流式叙述
// ═══════════════════════════════════════════════════════════

/**
 * 管家的「边说边想」—— 与仆人执行**并发**产生的逐字内容。
 *
 * ★ 为什么要有它（实测数据支撑）：
 *   仆人执行要 30—60 秒，而叙述只要 1.6—2.4 秒。
 *   没有它，用户在那 30—60 秒里只能盯着一行行进度文字。
 *
 * ★★ 三处处理是刻意的：
 *
 *   ① **思考默认收起**
 *      思考是过程不是结论。一直展开会让用户先读一段推理再读结论 ——
 *      而多数人只想要结论。
 *      但**要能看到** —— 这是「可审计」在推理层的形态。
 *
 *   ② **思考可能为空**（`reasoning.length === 0`）
 *      实测模型思考量波动极大（0—844 字，偶发为 0）。
 *      界面**不能假设一定有思考** —— 没有就只显示正文，
 *      而不是显示一个空的「思考中…」。
 *
 *   ③ **译文优先、原文保留**
 *      有译文说明原文是英文（用户看中文更方便），
 *      但原文始终可对照 —— 方案 § 13.3 要求「可切换」。
 */
function NarrationBlock({
  state,
  showReasoning,
  onToggleReasoning,
}: {
  readonly state: NarrationState;
  readonly showReasoning: boolean;
  readonly onToggleReasoning: () => void;
}) {
  const hasReasoning = state.reasoning.length > 0;
  const translated = state.reasoningTranslated;

  return (
    <div className="narration">
      {hasReasoning && (
        <div className="narration-thinking">
          <button
            type="button"
            className="narration-thinking-toggle"
            onClick={onToggleReasoning}
          >
            {showReasoning ? '▾' : '▸'} 思考过程
            {!state.done && <span className="narration-pulse" />}
            <span className="narration-meta mono">
              {state.reasoning.length} 字
              {state.firstChunkMs !== null && ` · 首字 ${state.firstChunkMs}ms`}
            </span>
          </button>

          {showReasoning && (
            <div className="narration-reasoning">
              {translated.length > 0 && (
                <>
                  <div className="narration-reasoning-label">译文</div>
                  <div className="narration-reasoning-text">{translated}</div>
                  <div className="narration-reasoning-label">原文</div>
                </>
              )}
              <div className="narration-reasoning-text narration-reasoning-raw">
                {state.reasoning}
              </div>
            </div>
          )}
        </div>
      )}

      {state.answer.length > 0 ? (
        <div className="narration-answer">
          <RichContent text={state.answer} />
          {/* 光标：流未结束时显示，让「还在生成」这件事可见 */}
          {!state.done && <span className="narration-cursor" />}
        </div>
      ) : (
        // 首片延迟 629—947ms，这段空窗要有交代，否则像是卡住了
        !hasReasoning && <div className="narration-waiting">管家正在安排…</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 工具循环过程（思考 → 工具 → 再思考）
// ═══════════════════════════════════════════════════════════

/**
 * 把工具循环渲染成 dsh / codex 那种画面。
 *
 * ★ 结构：
 *     第 1 轮 · 思考 4687 字
 *       ▸ list_dir        ⚙ ✓ 32 字 · 8ms
 *       ▸ stat_path       ⚙ ✓ 119 字 · 3ms
 *     第 2 轮
 *       ▸ read_file       ⚙ ✓ 26 字 · 2ms
 *     第 3 轮
 *       ▸ submit_report   ⚙ ✓ 13 字 · 20ms
 *
 * ★★ 三处刻意的设计：
 *
 *   ① **轮次可折叠** —— 一轮的思考可能有几千字（实测 4687 字），
 *      全部展开会把对话淹没。默认只展开工具调用，思考收起来。
 *
 *   ② **工具结果可展开** —— 结果可能几百到几千字，
 *      默认只显示长度与耗时，点开看内容。
 *
 *   ③ **参数用等宽字体** —— 它是 JSON，等宽才看得出结构。
 *      且参数**只在拼完后显示**（`argsComplete`），
 *      否则用户会看到一个残缺的 JSON 而不知道那是"还在生成"。
 */
function AgentTraceView({ trace }: { readonly trace: AgentTrace }) {
  const [openRounds, setOpenRounds] = useState<Record<number, boolean>>({});
  const [openResults, setOpenResults] = useState<Record<string, boolean>>({});

  const f = trace.finished;
  const totalCalls = trace.rounds.reduce((n, r) => n + r.toolCalls.length, 0);

  return (
    <div className="agent">
      <div className="agent-head">
        <span className="agent-title">
          执行过程
          <span className="agent-meta mono">
            {f !== null ? `${f.rounds} 轮` : `${trace.rounds.length} 轮进行中`} · {totalCalls} 次工具调用
          </span>
        </span>
        {f !== null && f.hitRoundLimit && (
          <span className="tag tag-warn">达到轮次上限</span>
        )}
      </div>

      {trace.rounds.map((r) => {
        const expanded = openRounds[r.round] === true;
        const hasReasoning = r.reasoning.length > 0;

        return (
          <div className="agent-round" key={r.round}>
            <button
              type="button"
              className="agent-round-head"
              onClick={() => setOpenRounds((s) => ({ ...s, [r.round]: !expanded }))}
            >
              <span className="agent-round-label">第 {r.round} 轮</span>
              {hasReasoning && (
                <span className="agent-meta mono">思考 {r.reasoning.length} 字</span>
              )}
              {r.toolCalls.length > 0 && (
                <span className="agent-meta mono">{r.toolCalls.length} 次调用</span>
              )}
            </button>

            {/* 思考（默认收起 —— 一轮可能几千字，全展开会淹没对话） */}
            {expanded && hasReasoning && (
              <div className="agent-reasoning">{r.reasoning}</div>
            )}

            {/* 工具调用卡片 */}
            {r.toolCalls.map((tc, i) => {
              const key = `${r.round}_${tc.callId}_${i}`;
              const showResult = openResults[key] === true;
              const res = tc.result;

              return (
                <div className="agent-tool" key={key}>
                  <div className="agent-tool-head">
                    {/* 状态图标：未执行 / 执行中 / 成功 / 失败 / 被拒 */}
                    <span
                      className={
                        res === undefined
                          ? tc.started
                            ? 'agent-dot agent-dot-run'
                            : 'agent-dot'
                          : res.denied
                            ? 'agent-dot agent-dot-deny'
                            : res.ok
                              ? 'agent-dot agent-dot-ok'
                              : 'agent-dot agent-dot-fail'
                      }
                    />
                    <span className="agent-tool-name mono">{tc.name || '（未知工具）'}</span>

                    {!tc.argsComplete && <span className="agent-meta">生成参数…</span>}

                    {res !== undefined && (
                      <>
                        <span className="agent-meta mono">
                          {res.output.length} 字 · {res.durationMs}ms
                        </span>
                        <button
                          type="button"
                          className="agent-tool-toggle"
                          onClick={() => setOpenResults((s) => ({ ...s, [key]: !showResult }))}
                        >
                          {showResult ? '收起' : '结果'}
                        </button>
                      </>
                    )}
                  </div>

                  {/* 参数：只在拼完后显示 —— 残缺的 JSON 会让用户困惑 */}
                  {tc.argsComplete && tc.argsText.length > 0 && (
                    <div className="agent-tool-args mono">{formatArgs(tc.argsText)}</div>
                  )}

                  {showResult && res !== undefined && (
                    <div className={`agent-tool-result ${res.ok ? '' : 'agent-tool-result-bad'}`}>
                      {res.denied && <div className="agent-tool-denied">已拒绝 —— 未执行</div>}
                      {res.output}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** 把参数 JSON 压成一行显示（太长就截断）。 */
function formatArgs(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  }
}

// ═══════════════════════════════════════════════════════════
// 子组件
// ═══════════════════════════════════════════════════════════

function MessageBubble({ message }: { readonly message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-body">{message.text}</div>
      </div>
    );
  }

  return (
    <div className="msg msg-butler">
      <div className="msg-role">管家</div>
      <div className="msg-body">
        <RichContent text={message.text} />
      </div>
      {/* ★ 工具循环过程：随消息持久化，刷新后仍能看到「它读了哪个文件」 */}
      {message.agentTrace !== undefined && message.agentTrace.rounds.length > 0 && (
        <AgentTraceView trace={normalizeTrace(message.agentTrace)} />
      )}

      {message.memoryRefs !== undefined && message.memoryRefs.length > 0 && (
        <details className="msg-refs">
          <summary>参考了 {message.memoryRefs.length} 条记忆</summary>
          <ul>
            {message.memoryRefs.map((r) => (
              <li key={r.id}>{r.content}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * 审查结论卡。
 *
 * ★ 这是「管家做验收」的界面落点：
 *   通过 → 一句话说明；打回 → 原因 + 可选下一步。
 *
 * ⚠️ 打回时**必须给用户留门**（"我确认，继续"）——
 *   他是最终决策者，管家说明风险，但门是开是关由他定。
 */
function VerdictCard({
  verdict,
  range,
}: {
  readonly verdict: Verdict;
  readonly range?: AuditRange;
}) {
  const rejected = verdict.outcome === 'rejected';
  const blocking = verdict.issues.filter((i) => i.severity === 'blocking');
  const advisory = verdict.issues.filter((i) => i.severity === 'advisory');

  return (
    <div className={`verdict ${rejected ? 'verdict-rejected' : 'verdict-accepted'}`}>
      <div className="verdict-head">
        <span className={rejected ? 'tag tag-danger' : 'tag tag-ok'}>
          {rejected ? '未通过审查' : '已通过'}
        </span>
        <span className="verdict-summary">{verdict.summary}</span>
      </div>

      {verdict.steps.length > 0 && (
        <div className="verdict-steps">
          {verdict.steps.map((s) => (
            <span key={s.stepId} className="verdict-step">
              {s.ok ? '✓' : '✗'} {SERVANT_LABEL[s.servant] ?? s.servant}
            </span>
          ))}
          <span className="verdict-meta">
            用时 {(verdict.durationMs / 1000).toFixed(1)}s
          </span>
        </div>
      )}

      {blocking.length > 0 && (
        <div className="verdict-group">
          <div className="verdict-group-title">不可协商的冲突</div>
          {blocking.map((i, n) => (
            <div className="verdict-issue" key={n}>
              <span className="tag tag-danger">{SEVERITY_LABEL[i.severity]}</span>
              <div>
                <div>{i.statement}</div>
                {i.memoryContent !== undefined && (
                  <div className="verdict-issue-sub">关联记忆：「{i.memoryContent}」</div>
                )}
                {i.suggestion !== undefined && (
                  <div className="verdict-issue-sub">建议：{i.suggestion}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {advisory.length > 0 && (
        <div className="verdict-group">
          <div className="verdict-group-title">需留意（不影响交付）</div>
          {advisory.map((i, n) => (
            <div className="verdict-issue" key={n}>
              <span className="tag tag-warn">{SEVERITY_LABEL[i.severity]}</span>
              <div>{i.statement}</div>
            </div>
          ))}
        </div>
      )}

      {rejected && (
        <div className="verdict-actions">
          <span className="verdict-actions-hint">
            你是最终决策者 —— 想继续的话直接说「我确认，继续」
          </span>
        </div>
      )}

      {/**
       * ★★ 「它凭什么这么说」—— 本项目的差异化卖点就在这里。
       *
       *   ⚠️ 默认折叠且**按需拉取**（点开才请求 `/api/audit`）：
       *      召回 + 注入 + 校验的内容可能不小，而多数轮次用户不会展开看。
       *      无条件拉取等于每轮都多付一次数据传输 ——
       *      而"审计可见"的价值在于**需要时看得到**，不在于一直摆在眼前。
       */}
      {range !== undefined && <AuditTrail range={range} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 审计痕迹
// ═══════════════════════════════════════════════════════════

function AuditTrail({ range }: { readonly range: AuditRange }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    if (data !== null || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/audit?from=${range.fromSeq}&to=${range.toSeq}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { audit?: AuditData };
      setData(j.audit ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

  return (
    <div className="audit">
      <button type="button" className="audit-toggle" onClick={toggle}>
        {open ? '▾' : '▸'} 它凭什么这么说
        <span className="audit-range mono">
          seq {range.fromSeq}—{range.toSeq}
        </span>
      </button>

      {open && (
        <div className="audit-body">
          {loading && <div className="audit-loading">读取依据中…</div>}
          {error !== null && <div className="audit-error">读取失败：{error}</div>}

          {data !== null && (
            <>
              <div className="audit-summary">{data.summary}</div>

              {/* ── 硬约束未被处理：最需要用户知道的一件事 ── */}
              {data.hardChecks.length > 0 && (
                <div className="audit-section">
                  <div className="audit-section-title audit-danger">
                    ⛔ 硬约束未被处理（{data.hardChecks.length} 处）
                  </div>
                  {data.hardChecks.map((h) => (
                    <div className="audit-item" key={h.seq}>
                      <div>{h.content}</div>
                      <div className="audit-item-sub">
                        未处理：{h.unhandledByLabels.join('、') || '（未知）'}
                      </div>
                      {h.deterministic && (
                        <div className="audit-item-sub">
                          {h.note || '确定性机械校验判定，非模型裁决'}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── 注入了哪些约束（自查清单点名要求可见）── */}
              {data.injections.length > 0 && (
                <div className="audit-section">
                  <div className="audit-section-title">
                    给仆人注入了什么（{data.injections.length} 条）
                  </div>
                  {data.injections.map((inj) => (
                    <div className="audit-item" key={inj.seq}>
                      <div className="audit-item-head">
                        <span className={inj.negotiable ? 'tag' : 'tag tag-danger'}>
                          {inj.negotiable ? '可协商' : '不可协商'}
                        </span>
                        <span className="audit-item-who">→ {inj.servantLabel}</span>
                        <span className="audit-item-why">{inj.reason}</span>
                      </div>
                      <div>{inj.content}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── 召回了什么 ── */}
              {data.recalls.length > 0 && (
                <div className="audit-section">
                  <div className="audit-section-title">
                    召回的记忆（
                    {data.recalls.reduce((n, r) => n + r.count, 0)} 条）
                  </div>
                  {data.recalls.flatMap((r) =>
                    r.items.map((it) => (
                      <div className="audit-item audit-item-inline" key={`${r.seq}_${it.memoryId}`}>
                        <span className={it.forced ? 'tag tag-danger' : 'tag'}>
                          {it.memClassLabel}
                        </span>
                        <span className="audit-relevance mono">
                          相关度 {it.relevancePercent}%
                        </span>
                        {it.forced && <span className="audit-item-sub">强制带回，不参与筛选</span>}
                      </div>
                    )),
                  )}
                </div>
              )}

              {/* ── 敏感域授权（方案要求"谁读了我的敏感信息"可查）── */}
              {data.grants.length > 0 && (
                <div className="audit-section">
                  <div className="audit-section-title">敏感域授权（{data.grants.length} 条）</div>
                  {data.grants.map((g) => (
                    <div className="audit-item" key={g.seq}>
                      <div className="audit-item-head">
                        <span className={g.expired ? 'tag tag-warn' : 'tag tag-ok'}>
                          {g.kindLabel}
                          {g.expired ? '（已过期）' : ''}
                        </span>
                        <span className="audit-item-who">→ {g.toServantLabel}</span>
                      </div>
                      {g.reason.length > 0 && <div className="audit-item-sub">{g.reason}</div>}
                    </div>
                  ))}
                </div>
              )}

              {/* ── 越权写入被拒（方案要求"应全部被拒"）── */}
              {data.writeAttempts.length > 0 && (
                <div className="audit-section">
                  <div className="audit-section-title">
                    越权写入尝试（{data.writeAttempts.length} 次）
                  </div>
                  {data.writeAttempts.map((w) => (
                    <div className="audit-item" key={w.seq}>
                      <div className="audit-item-head">
                        <span className={w.rejected ? 'tag tag-ok' : 'tag tag-danger'}>
                          {w.rejected ? '已拒绝' : '⚠️ 未被拒绝'}
                        </span>
                        <span className="audit-item-who">{w.actor}</span>
                      </div>
                      <div className="audit-item-sub">{w.reason}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
