/**
 * 新版界面 · 对话
 *
 * ★★ 一屏只有三样东西：消息流、执行过程（收起）、输入框。
 *
 *   「一眼看完」靠的是**减法**：
 *     记忆库、审计、设置全在侧栏按需进入，不占这里。
 *     过程信息默认收起 —— 想看的人点一下，不想看的人不受打扰。
 *
 * ★ 消息的层次（学习 dsh，也与用户的期望一致）：
 *     用户消息 → 右对齐浅色气泡
 *     助手回复 → **不加气泡**（长文加气泡变成一大块色块，更累）
 *     执行过程 → 回复**之前**，一行
 *
 * ⚠️ 一个刻意的取舍：**不做逐字打字机效果**。
 *    流式是真的（SSE 逐块到达），但不做假动画 ——
 *    后者只让人等，不提供信息。
 */

'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { RichContent } from '../rich-content.js';
import { ProcessView, type TraceView } from './process.js';
import { ServantPane } from './servant-pane.js';
import { Shell } from './shell.js';
import { Row, Sep, type TagTone, Tag, VERDICT_WORD } from './ui.js';

// ═══════════════════════════════════════════════════════════
// 形状（与 `/api/chat` 的 SSE 事件、落盘形状对应）
// ═══════════════════════════════════════════════════════════

interface Msg {
  readonly id: string;
  readonly role: 'user' | 'butler' | 'servant' | 'system';
  readonly text: string;
  readonly verdict?: Verdict;
  readonly agentTrace?: TraceView;
}

interface VerdictIssue {
  readonly severity: 'blocking' | 'advisory' | 'info';
  readonly statement: string;
  readonly suggestion?: string;
}

interface Verdict {
  readonly outcome: string;
  readonly issues: readonly VerdictIssue[];
}

/** 一个仆人的产出（与落盘形状一致）。 */
export interface ServantOut {
  readonly servant: string;
  readonly taskId: string;
  readonly status: string;
  /** ★ 该对用户说的那段话 —— 仆人窗口里消息的正文 */
  readonly reply: string;
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
  readonly agentTrace?: TraceView;
}

export interface StartProps {
  readonly sessionId: string | null;
  readonly initialMessages: readonly Msg[];
  readonly modelConfigured: boolean;
  /** 本轮各仆人的产出 —— 右栏「仆人窗口」的数据 */
  readonly initialReports: readonly ServantOut[];
}

// ═══════════════════════════════════════════════════════════
// 主视图
// ═══════════════════════════════════════════════════════════

export function Conversation({
  sessionId: initialSession,
  initialMessages,
  modelConfigured,
  initialReports,
}: StartProps): ReactNode {
  const [msgs, setMsgs] = useState<readonly Msg[]>(initialMessages);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<TraceView | null>(null);
  const [liveText, setLiveText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  /**
   * 本轮各仆人的产出 —— 右栏「仆人窗口」。
   *
   * ★ 初值由服务端给（刷新后仍在），流式期间由 `reports` 事件更新。
   * ⚠️ 用 `useState` 惰性初值而**不是** `useEffect`：
   *    后者只在客户端跑 → 服务端渲染时是空的 →
   *    右栏在首屏 HTML 里根本不出现（截图看不到）。
   *    这个坑我踩过一次，症状是"DOM 里搜不到该类名"。
   */
  const [reports, setReports] = useState<readonly ServantOut[]>(initialReports);

  const sessionRef = useRef<string | null>(initialSession);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  /**
   * 自动滚到底 —— 但**用户手动上滚时暂停**。
   *
   * ⚠️ 这一条是必须的：用户正在往回读时把视口拽到底，
   *    是聊天界面里最恼人的体验之一。
   */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [msgs, live, liveText]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (text.length === 0 || busy || !modelConfigured) return;

    setInput('');
    setErr(null);
    setBusy(true);
    pinnedRef.current = true;

    const localId = `local_${Date.now().toString(36)}`;
    setMsgs((m) => [...m, { id: localId, role: 'user', text }]);
    setLive(null);
    setLiveText('');
    setReports([]);

    /**
     * ★ 流式累加器 —— 为什么放在函数内而不是 state：
     *   SSE 回调是同步密集触发的，用 state 累加会丢帧
     *   （每次 setState 都触发渲染，而事件来得比渲染快）。
     *   这里先在闭包变量里攒，再按需刷进 state。
     */
    let trace: TraceView = { rounds: [], finished: null };
    let replyText = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          ...(sessionRef.current !== null ? { sessionId: sessionRef.current } : {}),
        }),
      });
      if (!res.ok || res.body === null) {
        throw new Error(`请求失败：HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        // SSE 以空行分隔事件
        let idx = buf.indexOf('\n\n');
        while (idx >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          idx = buf.indexOf('\n\n');

          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line === undefined) continue;

          let e: Record<string, unknown>;
          try {
            e = JSON.parse(line.slice(6)) as Record<string, unknown>;
          } catch {
            continue; // 半截 JSON，跳过
          }

          const type = String(e['type'] ?? '');

          if (type === 'session') {
            sessionRef.current = String(e['sessionId'] ?? '') || null;
          } else if (type === 'agent') {
            trace = applyAgentEvent(trace, e);
            setLive({ ...trace });
          } else if (type === 'narration') {
            // 管家"边说边想"的逐字内容
            setLiveText(String(e['answer'] ?? ''));
          } else if (type === 'reply') {
            replyText = String(e['text'] ?? '');
          } else if (type === 'reports') {
            /**
             * ★ 各仆人产出 —— 右栏数据。
             * ⚠️ 与落进消息的那一份是**同一个对象**（服务端只转换一次），
             *    否则会出现「界面上看到的」与「刷新后看到的」不一致。
             */
            const rs = e['reports'];
            if (Array.isArray(rs)) setReports(rs as ServantOut[]);
          } else if (type === 'verdict') {
            const v = e['verdict'] as Verdict | undefined;
            if (v !== undefined) {
              setMsgs((m) => [
                ...m,
                {
                  id: `reply_${Date.now().toString(36)}`,
                  role: 'butler',
                  text: replyText,
                  verdict: v,
                },
              ]);
            }
          } else if (type === 'error') {
            setErr(String(e['message'] ?? '未知错误'));
          }
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setLive(null);
      setLiveText('');
    }
  }, [input, busy, modelConfigured]);

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter 发送；Shift+Enter 换行（与主流聊天工具一致）
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  const empty = msgs.length === 0 && live === null && liveText.length === 0;

  return (
    <Shell
      {...(reports.length > 0 ? { right: <ServantPane reports={reports} busy={busy} /> } : {})}
    >
      <div className="nv-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="nv-scroll-inner nv-col">
          {empty && (
            <div className="nv-empty">
              <div className="nv-empty-title">说说你想做什么</div>
              <div className="nv-empty-sub">
                管家会先判断该由谁来做、需要用到你的哪些信息，
                再把任务交给对应的仆人。过程中做了什么，你都能看到。
              </div>
            </div>
          )}

          {msgs.map((m) => (
            <MessageView key={m.id} msg={m} />
          ))}

          {/* ── 正在进行的这一轮 ── */}
          {(live !== null || liveText.length > 0 || busy) && (
            <div className="nv-msg">
              {live !== null && live.rounds.length > 0 && (
                <ProcessView trace={live} live />
              )}
              {liveText.length > 0 ? (
                <div className="nv-msg-text">
                  <RichContent text={liveText} />
                </div>
              ) : (
                busy && (
                  <Row
                    leading={<span className="nv-caret" aria-hidden>·</span>}
                    label={<span className="nv-shimmer">正在安排…</span>}
                  />
                )
              )}
            </div>
          )}

          {err !== null && (
            <div className="nv-note nv-note-warn" style={{ marginTop: 'var(--n-sp-4)' }}>
              {err}
            </div>
          )}
        </div>
      </div>

      <div className="nv-composer">
        <div className="nv-composer-inner">
          {!modelConfigured && (
            <div className="nv-note nv-note-warn" style={{ marginBottom: 'var(--n-sp-2)' }}>
              还没配置模型（`.env.local` 里缺 `DEEPSEEK_API_KEY`）——
              对话用不了，但「记忆」「审计」页面仍可查看。
            </div>
          )}
          <div className="nv-inputrow">
            <textarea
              className="nv-input"
              rows={1}
              value={input}
              disabled={!modelConfigured || busy}
              placeholder={busy ? '正在执行…' : '对管家说…（Enter 发送，Shift+Enter 换行）'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
            />
            <button
              type="button"
              className="nv-btn nv-btn-primary"
              disabled={!modelConfigured || busy || input.trim().length === 0}
              onClick={() => void send()}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}

// ═══════════════════════════════════════════════════════════
// 一条消息
// ═══════════════════════════════════════════════════════════

function MessageView({ msg }: { readonly msg: Msg }): ReactNode {
  if (msg.role === 'user') {
    return (
      <div className="nv-msg nv-msg-user">
        <div className="nv-msg-body">{msg.text}</div>
      </div>
    );
  }

  return (
    <div className="nv-msg">
      {/* 过程在回复**之前** —— 与用户的期望一致：
          「先流式输出思考、工具调用，这些结束后，再输出最终回复」 */}
      {msg.agentTrace !== undefined && msg.agentTrace.rounds.length > 0 && (
        <ProcessView trace={msg.agentTrace} />
      )}
      <div className="nv-msg-text">
        <RichContent text={msg.text} />
      </div>
      {msg.verdict !== undefined && <VerdictLine verdict={msg.verdict} />}
    </div>
  );
}

/**
 * 审查结论 —— **一行**。
 *
 * ★ 这是本项目的核心动作（管家做验收）在界面上的落点。
 *   但它是"一句话能说完"的事，所以**不做成卡片**。
 *
 * ⚠️ 严重度分三档，处理不同：
 *   · blocking（硬性要求没满足）→ 必须让用户看见，给红色
 *   · advisory（软约束/原则有出入）→ 给黄色，**说明这是建议不是禁令**
 *   · info → 不显示（那是过程信息，用户不需要逐条看）
 */
function VerdictLine({ verdict }: { readonly verdict: Verdict }): ReactNode {
  const blocking = verdict.issues.filter((i) => i.severity === 'blocking');
  const advisory = verdict.issues.filter((i) => i.severity === 'advisory');

  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  // ⚠️ 没有需要用户知道的问题时**整行不显示** ——
  //    「已完成」三个字对用户没有信息量，纯占地方。
  if (blocking.length === 0 && advisory.length === 0) return null;

  const tone: TagTone = blocking.length > 0 ? 'danger' : 'warn';
  const word = VERDICT_WORD[verdict.outcome] ?? verdict.outcome;
  const count = blocking.length + advisory.length;

  return (
    <div className="nv-proc" data-open={open ? 'true' : undefined}>
      <Row
        caret={open ? '▾' : '▸'}
        leading={<Tag tone={tone}>{word}</Tag>}
        label={
          <>
            {blocking.length > 0
              ? `有 ${blocking.length} 条硬性要求没满足`
              : `${count} 条提醒`}
            <Sep />
            <span style={{ color: 'var(--n-text-faint)' }}>点开看</span>
          </>
        }
        onClick={toggle}
        open={open}
      />
      {open && (
        <div style={{ marginLeft: 15 }}>
          {[...blocking, ...advisory].map((i, k) => (
            <Row
              key={k}
              caret=" "
              leading={
                <Tag tone={i.severity === 'blocking' ? 'danger' : 'warn'}>
                  {i.severity === 'blocking' ? '必须' : '建议'}
                </Tag>
              }
              label={
                <>
                  {i.statement}
                  {i.suggestion !== undefined && (
                    <div style={{ color: 'var(--n-text-faint)', fontSize: 'var(--n-fs-tiny)' }}>
                      {i.suggestion}
                    </div>
                  )}
                </>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 流式事件 → 视图状态
// ═══════════════════════════════════════════════════════════

/**
 * 把 `agent` 事件合并进过程视图。
 *
 * ⚠️ 三类事件的累积方式**不同**，混了就会重复或丢内容：
 *   · `reasoning` / `text` —— 服务端已累好，**整体替换**
 *   · `toolCall` 分片 —— 逐段到达，**累积拼接**
 *   · `toolResult` —— 覆盖该次调用的结果
 */
function applyAgentEvent(trace: TraceView, e: Record<string, unknown>): TraceView {
  const kind = String(e['kind'] ?? '');
  const roundNo = typeof e['round'] === 'number' ? e['round'] : 1;

  const rounds = [...trace.rounds];
  const find = (n: number): number => rounds.findIndex((r) => r.round === n);
  const ensure = (n: number): number => {
    const i = find(n);
    if (i >= 0) return i;
    rounds.push({ round: n, reasoning: '', toolCalls: [] });
    return rounds.length - 1;
  };

  if (kind === 'round') {
    ensure(roundNo);
    return { rounds, finished: trace.finished };
  }

  if (kind === 'reasoning') {
    const i = ensure(roundNo);
    const r = rounds[i];
    if (r !== undefined) {
      rounds[i] = { ...r, reasoning: String(e['accumulated'] ?? '') };
    }
    return { rounds, finished: trace.finished };
  }

  if (kind === 'toolCall') {
    const i = ensure(roundNo);
    const r = rounds[i];
    if (r === undefined) return trace;

    const callId = String(e['callId'] ?? '');
    const name = String(e['name'] ?? '');
    const delta = String(e['argsDelta'] ?? '');
    const complete = e['partial'] === false;

    const list = [...r.toolCalls];
    const j = list.findIndex((t) => t.callId === callId);

    if (j < 0) {
      list.push({
        callId,
        name,
        argsText: delta,
        ok: false,
        denied: false,
        output: '',
        durationMs: 0,
      });
    } else {
      const cur = list[j];
      if (cur !== undefined) {
        list[j] = {
          ...cur,
          name: name.length > 0 ? name : cur.name,
          argsText: complete ? cur.argsText : cur.argsText + delta,
        };
      }
    }
    rounds[i] = { ...r, toolCalls: list };
    return { rounds, finished: trace.finished };
  }

  if (kind === 'toolResult') {
    const i = ensure(roundNo);
    const r = rounds[i];
    if (r === undefined) return trace;

    const callId = String(e['callId'] ?? '');
    const list = r.toolCalls.map((t) =>
      t.callId === callId
        ? {
            ...t,
            ok: e['ok'] === true,
            denied: e['denied'] === true,
            output: String(e['output'] ?? ''),
            durationMs: typeof e['durationMs'] === 'number' ? e['durationMs'] : 0,
          }
        : t,
    );
    rounds[i] = { ...r, toolCalls: list };
    return { rounds, finished: trace.finished };
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

  return trace;
}
