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
  /** ★ 仆人各自的产出（右侧面板的数据，刷新后仍可见） */
  readonly servantReports?: readonly ServantReport[];
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
// 仆人产出（右侧面板的数据）
// ═══════════════════════════════════════════════════════════

/**
 * 一个仆人的产出（与 `core/chat/types.ts` 的 `ServantReportData` 对应）。
 *
 * ★★ 这一块是「仆人面板」的内容 —— 它与管家的对话**并排**显示，
 *    而不是混在对话流里。
 *
 * ★ 为什么必须分开显示（方案 § 2.2 的核心）：
 *     **仆人只提交发现，管家才做裁决。**
 *     混在一起会让「谁说的」变得模糊，
 *     而那个区分恰恰是本项目「平等编排」的立论基础。
 */
interface ServantReport {
  readonly servant: string;
  readonly taskId: string;
  readonly status: 'done' | 'failed' | 'blocked';
  readonly instruction: string;
  readonly artifacts: readonly {
    readonly kind: string;
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
  readonly injectedConstraints: readonly {
    readonly content: string;
    readonly negotiable: boolean;
  }[];
}

/** 仆人的展示名。⚠️ 与 `core/chat/reports.ts` 的映射保持一致。 */
const SERVANT_NAME: Record<string, string> = {
  life: '生活仆人',
  health: '健康仆人',
  study: '学习仆人',
  work: '办公仆人',
  code: '代码仆人',
};

/** 产出物类型展示名。 */
const ARTIFACT_LABEL: Record<string, string> = {
  text: '正文',
  list: '清单',
  plan: '方案',
  file: '文件',
};

/** 发现类型展示名。 */
const FINDING_LABEL: Record<string, string> = {
  constraintRef: '约束相关',
  risk: '风险',
  alternative: '备选',
};

/**
 * 从历史消息里找出**最近一轮**的仆人产出。
 *
 * ★ 为什么只取最近一条，而不是汇总全部轮次：
 *   右侧栏回答的是「**这一轮**仆人在干什么」。
 *   把历史全部堆上去会让它变成第二个对话流，
 *   与「管家 | 仆人」双栏的用意正相反。
 *   历史轮次的产出仍能在各自的消息里看到（见 `MessageBubble`）。
 */
function latestReportsOf(messages: readonly Message[]): readonly ServantReport[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.servantReports !== undefined && m.servantReports.length > 0) {
      return m.servantReports;
    }
  }
  return [];
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
  /**
   * ★★ 本轮各仆人的产出 —— 右侧「仆人面板」的内容。
   *
   *   空数组时右侧栏不出现（默认单栏对话）——
   *   即你自己定的规则：**仆人执行时才左右双栏**。
   *
   * ⚠️⚠️ 初值**必须在这里算**，不能放 `useEffect`。
   *
   *   我第一版写成了 `useEffect(() => { … setReports(…) }, …)`，
   *   结果是：**服务端渲染时 `reports` 是空的** →
   *   `<aside>` 根本不出现在 HTML 里 →
   *   截图（截图发生在 hydration 之前）看不到右栏。
   *
   *   症状极具误导性：落盘数据齐全、DOM 检查里却连 `servant-pane`
   *   都搜不到 —— 看起来像"组件没渲染"，实际是**渲染时机**问题。
   *
   *   ★ 用惰性初值既让 SSR 就带上数据，也省掉一次多余渲染。
   */
  const [reports, setReports] = useState<readonly ServantReport[]>(() =>
    latestReportsOf(initialMessages),
  );
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
    setReports([]);
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

    if (type === 'reports') {
      // 本轮仆人产出（服务端在编排完成后一次性推）
      setReports(Array.isArray(e['reports']) ? (e['reports'] as ServantReport[]) : []);
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

      {/**
       * ★ `app-body-split` 是**两栏等分**的开关（图二）。
       *
       * ⚠️ 用显式 class 而不是 CSS 的 `:has(~ .servant-pane)` ——
       *    `:has()` 在部分浏览器/版本上不支持，
       *    而它一旦失效，布局会**静默退回**单栏吃满：
       *    没有报错、没有告警，只是看起来"图二那半边不见了"。
       *    显式 class 的行为是完全确定的。
       */}
      <div className={`app-body ${reports.length > 0 ? 'app-body-split' : ''}`}>
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

        {/* ══════════════════════════════════════════════════════
            ★★ 仆人面板（右侧）

            即你手绘图二：**仆人执行时才出现，管家 | 仆人 左右双栏**。
            没有仆人产出时**整栏不渲染** —— 默认是单栏纯对话。

            ⚠️ 与「管家的对话」并排而不是混在对话流里的理由：
               方案 § 2.2 的核心是**仆人只提交发现、管家才做裁决**。
               混在一起会让「谁说的」变得模糊，
               而那个区分是本项目「平等编排」的立论基础。
            ══════════════════════════════════════════════════════ */}
        {reports.length > 0 && (
          <aside className="servant-pane">
            <ServantPanel reports={reports} busy={busy} />
          </aside>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 仆人面板（右侧栏）
// ═══════════════════════════════════════════════════════════

/**
 * 仆人面板 —— 展示本轮每个仆人**各自的**产出。
 *
 * ★★ 这一版按用户反馈**大幅精简**（原先"太不简洁清晰"）。
 *
 * 用户的两条意见（都已落实）：
 *
 *   ① **"已注入的约束"不该给用户看** ——
 *      那是**内部机制**，回答的是"系统怎么运作"。
 *      用户关心的是"它给我得出了什么"。
 *      ⚠️ 我原先把它放在最上面还加红边，是**把内部实现当成了内容**。
 *      → 已删除。它仍在事件流里（审计视图能查），只是不上界面。
 *
 *   ② **"收到的指令"同样不该给用户看** ——
 *      同理：那是系统的调度细节，不是用户要的信息。
 *      → 已删除。
 *
 * ★ 精简后的结构（只留用户真正要的）：
 *      状态一行 → 产出物 → 发现（可展开证据）→ 不确定
 *
 * ⚠️ "不确定声明"刻意**保留**、且不弱化：
 *    它是仆人"诚实声明不确定"的落点。删掉它等于鼓励模型少说 ——
 *    而用户看不到不确定，就会把推测当结论用。
 *
 * ⚠️ 产出物**默认收起内容**（只显示"清单 12 条"这样的规模），
 *    点开才看正文。理由：一次可能 4—5 个产出物、每个几百字，
 *    全展开会把面板变成一面墙（这正是用户说"不简洁"的原因之一）。
 */
function ServantPanel({
  reports,
  busy,
}: {
  readonly reports: readonly ServantReport[];
  readonly busy: boolean;
}) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string): void => setOpen((s) => ({ ...s, [k]: s[k] !== true }));

  // ⚠️ 选中项可能越界（新一轮仆人数量变少）—— 兜底回第一条
  const idx = active < reports.length ? active : 0;
  const cur = reports[idx];
  if (cur === undefined) return null;

  return (
    <div className="servant-panel">
      {/* ── 头部：标题 + 进行中指示 ── */}
      <div className="servant-head">
        <span className="servant-head-title">仆人</span>
        {busy && <span className="servant-live" title="执行中" />}
      </div>

      {/* ── 标签页：一个仆人一个 ── */}
      <div className="servant-tabs" role="tablist">
        {reports.map((r, i) => (
          <button
            key={`${r.servant}_${r.taskId}`}
            type="button"
            role="tab"
            aria-selected={i === idx}
            className={`servant-tab ${i === idx ? 'servant-tab-on' : ''}`}
            onClick={() => setActive(i)}
          >
            <span className={`servant-dot servant-dot-${r.status}`} />
            {SERVANT_NAME[r.servant] ?? r.servant}
          </button>
        ))}
      </div>

      <div className="servant-body">
        {/* ── 产出物 ── */}
        {cur.artifacts.length > 0 && (
          <section className="servant-sec">
            <div className="servant-sec-title">产出</div>
            {cur.artifacts.map((a, i) => {
              const key = `${cur.taskId}_a${i}`;
              const isOpen = open[key] === true;
              return (
                <div key={key} className="servant-item">
                  {/* 一行：类型 + 规模 + 展开。**没有边框没有底色** */}
                  <button
                    type="button"
                    className="servant-row servant-row-clickable"
                    onClick={() => toggle(key)}
                    aria-expanded={isOpen}
                    data-open={isOpen ? 'true' : undefined}
                  >
                    <span className="servant-caret" aria-hidden>
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <span className="servant-row-name">{ARTIFACT_LABEL[a.kind] ?? a.kind}</span>
                    {a.itemCount > 1 && (
                      <>
                        <span className="servant-sep" />
                        <span className="servant-note">{a.itemCount} 条</span>
                      </>
                    )}
                    <span className="servant-note servant-tail">{a.text.length} 字</span>
                  </button>
                  {isOpen && <div className="servant-content">{a.text}</div>}
                </div>
              );
            })}
          </section>
        )}

        {/* ── 发现（带证据）── */}
        {cur.findings.length > 0 && (
          <section className="servant-sec">
            <div className="servant-sec-title">
              发现
              <span className="servant-sec-note">只陈述，不裁决</span>
            </div>
            {cur.findings.map((f, i) => {
              const key = `${cur.taskId}_f${i}`;
              const isOpen = open[key] === true;
              return (
                <div key={key} className="servant-item">
                  <div className="servant-finding">
                    {/* ⚠️ 行首加一个小竖标 —— 否则「发现」与「产出」的行
                        长得一样，用户分不清哪一行是哪一类的 */}
                    <span className={`finding-kind finding-kind-${f.kind}`}>
                      {FINDING_LABEL[f.kind] ?? f.kind}
                    </span>
                    <span className="servant-finding-text">{f.statement}</span>
                  </div>
                  {/* 依据：**只在有证据时才出现**，且默认收起。
                      有多条证据时可直接扫读条数。 */}
                  {f.evidence.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="servant-row servant-row-clickable"
                        onClick={() => toggle(key)}
                        aria-expanded={isOpen}
                        data-open={isOpen ? 'true' : undefined}
                      >
                        <span className="servant-caret" aria-hidden>
                          {isOpen ? '▾' : '▸'}
                        </span>
                        <span className="servant-note">依据</span>
                      </button>
                      {isOpen && (
                        <ul className="servant-evidence">
                          {f.evidence.map((e, j) => (
                            <li key={j}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {/* ── 不确定声明：保留且不弱化 ──
            ⚠️ 删掉它等于鼓励模型少说 ——
               而用户看不到不确定，就会把推测当结论用。 */}
        {cur.uncertainties.length > 0 && (
          <section className="servant-sec">
            <div className="servant-sec-title">
              它声明不确定的地方
              <span className="servant-sec-note">{cur.uncertainties.length} 条</span>
            </div>
            <ul className="servant-uncertain">
              {cur.uncertainties.map((u, i) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
          </section>
        )}

        {/* ── 需要管家裁决 ── */}
        {cur.needsButlerDecision !== undefined && (
          <section className="servant-sec">
            <div className="servant-sec-title">请求管家裁决</div>
            <div className="servant-escalate-text">{cur.needsButlerDecision}</div>
          </section>
        )}
      </div>

      {/**
       * ★★ 右栏的输入框 —— 按**图二**「两侧各有输入框」补。
       *
       * ⚠️ 必须说清它的性质，否则会被当成装饰：
       *   它目前是**留位**。真正的「直接与仆人对话」需要一条
       *   独立的通路（用户 → 指定仆人 → 产出回填），而那一步还没做。
       *
       *   ★ 但即使只是留位，也**不能做成能输入却发不出去的样子** ——
       *     那是最糟的一种：用户可以打字、点发送、然后什么也不发生。
       *     所以这里 `disabled` + 明确说明。
       *
       * ★ 已定好的规则（后面接通路时必须遵守）：
       *     直接与仆人对话时，**管家可以提醒但不得拦截仆人进程**。
       */}
      <div className="composer composer-servant">
        <div className="composer-row">
          <input
            className="composer-input"
            placeholder={`直接对${SERVANT_NAME[cur.servant] ?? '仆人'}说…（尚未接通）`}
            disabled
            title="这条通路还没做：目前与仆人的沟通都要经过管家"
          />
          <button type="button" className="btn" disabled>
            发送
          </button>
        </div>
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
/**
 * 执行过程 —— 「思考 → 工具 → 再思考」的画面。
 *
 * ★★ 这一版按 dsh 的手法**重排**（参考 `docs/dsh-ui-reference.md`）。
 *    旧版被用户指出"太不简洁清晰"，根因有三：
 *
 *   ① **每个工具调用是一张带边框的卡片**（`border` + `background` + `padding`）
 *      → 一次循环 8 次调用就是 8 个框，页面全是格子。
 *      dsh 的做法：**一行**（高 24px），没有边框没有底色。
 *
 *   ② **标题用正文色 + 摘要用亮色**
 *      → 工具名比模型说的话还抢眼。
 *      dsh 的做法：可折叠行的标题用 **tertiary**（最弱一级），悬停才提亮。
 *
 *   ③ **原始结果整块塞进卡片**（几百到几千字）
 *      → 用户看到的是"一大坨输出"。
 *      dsh 的做法：**只提取该类型有用的字段**（文件→路径+行数，
 *      搜索→命中数），原始内容只在点击时才取。
 *
 * ★ 三处刻意保留的差异（因为本项目与 dsh 的信息模型不同）：
 *   · **有"轮"这一层** —— 管家的多轮循环是本项目的编排单元，
 *     dsh 没有对应概念。用左侧细线缩进表达层级（借用它 `subCalls` 的手法）。
 *   · **思考可展开** —— 这是"可审计"在推理层的形态，不能省。
 *   · **状态用点 + 颜色**，但不加文字标签（dsh 的做法），
 *     失败/被拒才补一个词，因为那时用户必须知道。
 */
function AgentTraceView({ trace }: { readonly trace: AgentTrace }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string): void => setOpen((s) => ({ ...s, [k]: s[k] !== true }));

  /**
   * ★★ 整个执行块**默认收起成一行**。
   *
   * ★ 这是从 dsh 学到的最重要的一条（`.root:not([data-expanded])` 固定
   *   `height: calc(24px + delta)`）：
   *   过程信息在**收起态必须恰好一行高**。
   *
   * ⚠️ 我前一版让过程常驻展开 —— 一轮 8 次调用就是 8 行 + 轮标题 + 面板头，
   *    十几行「执行日志」压在模型的回复上面。
   *    用户说"太不简洁清晰"，主要就是这里。
   *
   * ★ 收起时显示什么：**业务动词 + 规模**，而不是"执行过程"这种名词。
   *   dsh 的组标题是合成出来的（"Reading files and running commands"），
   *   我这里是"执行了 4 轮 · 8 次工具调用" ——
   *   信息等价，但**是散文而不是标签**。
   */
  const [expanded, setExpanded] = useState(false);

  const f = trace.finished;
  const totalCalls = trace.rounds.reduce((n, r) => n + r.toolCalls.length, 0);
  const hasReasoning = trace.rounds.some((r) => r.reasoning.length > 0);
  const running = f === null;

  /** 收起态那一行的文字。 */
  const summary = running
    ? `正在执行（第 ${trace.rounds.length} 轮 · ${totalCalls} 次工具调用）`
    : `执行了 ${f.rounds} 轮 · ${totalCalls} 次工具调用`;

  return (
    <div className="exec" data-expanded={expanded ? 'true' : undefined}>
      {/* ── 收起态就是这一行（恰好 24px）── */}
      <button
        type="button"
        className="exec-row exec-row-clickable exec-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-open={expanded ? 'true' : undefined}
      >
        <span className="exec-caret" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
        {/* 运行中：文字带流光（dsh 的 TextShimmer 手法） */}
        <span className={running ? 'exec-head-label exec-shimmer' : 'exec-head-label'}>
          {summary}
        </span>
        {f !== null && f.hitRoundLimit && <span className="tag tag-warn">到轮次上限</span>}
      </button>

      {/* ── 展开态才挂载 ──
          ⚠️ 用条件渲染而不是 CSS 隐藏：
             一次循环可能上千字思考 + 几十 KB 结果，
             CSS 隐藏仍然会进 DOM，长对话下内存与渲染都会拖慢。 */}
      {expanded && (
        <div className="exec-body">
          {trace.rounds.map((r) => (
            <div className="exec-round" key={r.round}>
              {/* ── 轮标题：一行。有思考时它才是可点的 ── */}
              {hasReasoning && r.reasoning.length > 0 ? (
                <button
                  type="button"
                  className="exec-row exec-row-clickable"
                  onClick={() => toggle(`r${r.round}`)}
                  aria-expanded={open[`r${r.round}`] === true}
                  data-open={open[`r${r.round}`] === true ? 'true' : undefined}
                >
                  <span className="exec-caret" aria-hidden>
                    {open[`r${r.round}`] === true ? '▾' : '▸'}
                  </span>
                  <span className="exec-round-name">第 {r.round} 轮</span>
                  <span className="exec-sep" />
                  <span className="exec-note">思考 {r.reasoning.length} 字</span>
                </button>
              ) : (
                <div className="exec-row">
                  <span className="exec-caret exec-caret-none" aria-hidden />
                  <span className="exec-round-name">第 {r.round} 轮</span>
                </div>
              )}

              {/* 思考：默认收起（一轮可能几千字） */}
              {open[`r${r.round}`] === true && r.reasoning.length > 0 && (
                <div className="exec-reasoning">{r.reasoning}</div>
              )}

              {/* ★ 工具调用：**一次调用一行**，缩进在轮之下 */}
              {r.toolCalls.length > 0 && (
                <div className="exec-calls">
                  {r.toolCalls.map((tc, i) => {
                    const key = `${r.round}_${tc.callId}_${i}`;
                    const res = tc.result;
                    const state =
                      res === undefined
                        ? tc.started
                          ? 'run'
                          : 'idle'
                        : res.denied
                          ? 'deny'
                          : res.ok
                            ? 'ok'
                            : 'fail';

                    return (
                      <div key={key}>
                        <button
                          type="button"
                          className="exec-row exec-row-clickable"
                          onClick={() => toggle(key)}
                          aria-expanded={open[key] === true}
                          data-open={open[key] === true ? 'true' : undefined}
                        >
                          <span className={`exec-dot exec-dot-${state}`} aria-hidden />
                          {/* 工具名 + 参数摘要**同一行** —— 旧版分成两行且各带容器 */}
                          <span className="exec-tool">{tc.name || '未知工具'}</span>
                          {tc.argsComplete && tc.argsText.length > 0 && (
                            <span className="exec-args mono">{summarizeArgs(tc.argsText)}</span>
                          )}
                          {!tc.argsComplete && <span className="exec-note">生成参数…</span>}

                          {/* 右侧：结果规模 + 耗时。失败/被拒才给词 */}
                          <span className="exec-tail">
                            {res !== undefined && res.denied && (
                              <span className="exec-word exec-word-deny">已拒绝</span>
                            )}
                            {res !== undefined && !res.denied && !res.ok && (
                              <span className="exec-word exec-word-fail">失败</span>
                            )}
                            {res !== undefined && (
                              <span className="exec-note mono">
                                {res.output.length} 字 · {res.durationMs}ms
                              </span>
                            )}
                          </span>
                        </button>

                        {/* 结果：**只在点击后**渲染 */}
                        {open[key] === true && res !== undefined && (
                          <div className="exec-output mono">
                            {res.denied && <div className="exec-denied">已拒绝 —— 未执行</div>}
                            {previewText(res.output)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 结果预览的最大字符数（超出给"展开全部"的提示）。 */
const OUTPUT_PREVIEW_CHARS = 1200;

/**
 * 结果预览。
 *
 * ⚠️ 这里**只截断，不折叠**（不额外套一层"显示更多"按钮）——
 *    用户在工具行上已经点过一次了，再点一次是多余的。
 *    真要全量内容，审计视图里有。
 */
function previewText(text: string): string {
  return text.length > OUTPUT_PREVIEW_CHARS
    ? `${text.slice(0, OUTPUT_PREVIEW_CHARS)}\n…（共 ${text.length} 字，完整内容见审计）`
    : text;
}

/**
 * 参数摘要 —— **一行、只留最有辨识度的值**。
 *
 * ⚠️ 旧版是把整个 JSON 序列化后截 200 字显示。
 *    后果：`{"path":"冰箱盘点.txt"}` 变成
 *    `{"path":"冰箱盘点.txt"}`，还把不需要的键也带上，
 *    且 JSON 的引号/括号对中文用户是纯噪音。
 *
 * ★ 做法：把 JSON 摊平成 `键=值` 的短串，值过长才截。
 *   例如 `{"path": "冰箱盘点.txt"}` → `path=冰箱盘点.txt`
 */
function summarizeArgs(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
  }

  if (typeof value !== 'object' || value === null) return String(value);

  const parts: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    // 单个值最多 40 字 —— 长路径/长命令要截，否则一行放不下
    parts.push(`${k}=${s !== undefined && s.length > 40 ? `${s.slice(0, 40)}…` : s}`);
    if (parts.length >= 3) break; // 最多 3 个键，多了不看了
  }
  const out = parts.join(' ');
  return out.length > 80 ? `${out.slice(0, 80)}…` : out;
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

      {/* ── ★ 仆人产出：这一轮的仆人各自说了什么 ──
           右侧栏显示的是**最近一轮**（那是"当前在执行什么"），
           历史轮次的产出收在这里，收起以免淹没收官家的回复。 */}
      {message.servantReports !== undefined && message.servantReports.length > 0 && (
        <details className="msg-servants">
          <summary>
            本轮 {message.servantReports.length} 位仆人：
            {message.servantReports
              .map((r) => SERVANT_NAME[r.servant] ?? r.servant)
              .join(' · ')}
          </summary>
          <div className="msg-servants-body">
            <ServantPanel reports={message.servantReports} busy={false} />
          </div>
        </details>
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
