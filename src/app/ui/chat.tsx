'use client';

/**
 * 对话（客户端）
 *
 * ★ 一屏只有三样：消息流、执行过程（默认收起）、输入框。
 *
 * ★ 三个能力在这里落地：
 *   ① **图片**：选图/粘贴 → 随消息发送（只对本轮有效，刷新后不回来）
 *   ② **过程**：工具调用逐条可见，但默认折叠 —— 想看的人点开
 *   ③ **确认**：需要用户点头的动作，在输入框上方出现一张卡片
 *      （前端声明 `supportsApproval`，后端才会把确认请求推过来）
 *
 * ⚠️ 不做"逐字打字机"：流是真的，但假动画只让人等，不提供信息。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ── 与 /api/chat 的 SSE 契约对应 ──────────────────────────

interface TraceTool {
  callId: string;
  name: string;
  ok?: boolean;
  denied?: boolean;
  args: string;
  output: string;
  durationMs?: number;
}

interface TraceRound {
  round: number;
  reasoning: string;
  tools: TraceTool[];
}

export interface Trace {
  rounds: TraceRound[];
  finished?: { rounds: number; reason: string; hitRoundLimit: boolean };
}

interface VerdictIssue {
  severity: string;
  statement: string;
}

interface Verdict {
  outcome: 'accepted' | 'rejected';
  issues?: VerdictIssue[];
  corrected?: string;
}

interface Msg {
  id: string;
  role: 'user' | 'butler';
  text: string;
  images?: string[];
  verdict?: Verdict;
  trace?: Trace;
}

interface Approval {
  id: string;
  toolName: string;
  tier: string;
  summary: string;
  preview?: string;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const STARTERS = [
  '帮我安排今天下午的时间',
  '记住：我对花生过敏',
  '把这几件事按优先级排一下',
] as const;

export function Chat({
  sessionId,
  initialMessages,
  modelConfigured,
}: {
  readonly sessionId: string | null;
  readonly initialMessages: readonly Msg[];
  readonly modelConfigured: boolean;
}): React.ReactElement {
  const [msgs, setMsgs] = useState<Msg[]>([...initialMessages]);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<{ url: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');
  const [liveTrace, setLiveTrace] = useState<Trace | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionRef = useRef<string | null>(sessionId);

  /**
   * ★ 执行轨迹用 ref 累积 + **节流**刷到 state。
   *
   * ⚠️ 实测：一轮对话会推 **1908 次 gent 事件**（模型逐字、逐参数的增量）。
   *    每个事件都 setState 就是 1908 次渲染 —— 界面会明显卡顿。
   *    这里 100ms 合并一次，肉眼仍然是"实时"的。
   */
  const traceRef = useRef<Trace>({ rounds: [] });
  const flushTimer = useRef<number | null>(null);

  const flushTrace = useCallback(() => {
    if (flushTimer.current !== null) return;
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null;
      setLiveTrace(cloneTrace(traceRef.current));
    }, 100);
  }, []);

  // 新内容出现就滚到底（用户自己往上翻时不再强制）
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 220;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [msgs, liveText, liveTrace, stage]);

  // 输入框随内容长高
  const grow = useCallback(() => {
    const ta = taRef.current;
    if (ta === null) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, []);

  const addImages = useCallback((files: readonly File[]) => {
    const picked = files.filter((f) => f.type.startsWith('image/'));
    if (picked.length === 0) return;
    for (const f of picked.slice(0, MAX_IMAGES)) {
      if (f.size > MAX_IMAGE_BYTES) {
        setErr(`「${f.name}」超过 8MB，已跳过`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === 'string' ? reader.result : '';
        if (url.length === 0) return;
        setImages((list) =>
          list.length >= MAX_IMAGES ? list : [...list, { url, name: f.name }],
        );
      };
      reader.readAsDataURL(f);
    }
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (busy || !modelConfigured) return;
    if (text.length === 0 && images.length === 0) return;

    const sentImages = images.map((i) => i.url);
    setBusy(true);
    setErr(null);
    setStage(null);
    setLiveText('');
    setLiveTrace(null);
    setInput('');
    setImages([]);
    if (taRef.current !== null) taRef.current.style.height = 'auto';

    setMsgs((m) => [
      ...m,
      { id: `u_${Date.now().toString(36)}`, role: 'user', text, ...(sentImages.length > 0 ? { images: sentImages } : {}) },
    ]);

    traceRef.current = { rounds: [] };
    let replyText = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(sessionRef.current !== null ? { sessionId: sessionRef.current } : {}),
          text,
          ...(sentImages.length > 0 ? { images: sentImages.map((url) => ({ url })) } : {}),
          // ★ 声明"我能处理确认请求"，后端才会把 approval 推过来
          supportsApproval: true,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setErr(body?.error ?? `请求失败（HTTP ${res.status}）`);
        return;
      }
      if (res.body === null) {
        setErr('服务端没有返回数据流');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

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
            continue; // 半截 JSON
          }

          const type = String(e['type'] ?? '');
          if (type === 'session') {
            sessionRef.current = String(e['sessionId'] ?? '') || null;
          } else if (type === 'progress') {
            const ev = e['event'] as { label?: unknown } | undefined;
            if (typeof ev?.label === 'string') setStage(ev.label);
          } else if (type === 'agent') {
            traceRef.current = applyAgent(traceRef.current, e);
            flushTrace();
          } else if (type === 'narration') {
            setLiveText(String(e['answer'] ?? ''));
          } else if (type === 'reply') {
            replyText = String(e['text'] ?? '');
          } else if (type === 'approval') {
            setApprovals((list) => [
              ...list,
              {
                id: String(e['id'] ?? ''),
                toolName: String(e['toolName'] ?? ''),
                tier: String(e['tier'] ?? ''),
                summary: String(e['summary'] ?? ''),
                ...(typeof e['preview'] === 'string' ? { preview: e['preview'] } : {}),
              },
            ]);
          } else if (type === 'verdict') {
            const v = e['verdict'] as Verdict | undefined;
            if (v !== undefined && replyText.length > 0) {
              setMsgs((m) => [
                ...m,
                {
                  id: `a_${Date.now().toString(36)}`,
                  role: 'butler',
                  text: replyText,
                  verdict: v,
                  ...(traceRef.current.rounds.length > 0 ? { trace: cloneTrace(traceRef.current) } : {}),
                },
              ]);
              replyText = '';
              setLiveText('');
              setLiveTrace(null);
            }
          } else if (type === 'error') {
            setErr(String(e['message'] ?? '未知错误'));
          }
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (flushTimer.current !== null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      setBusy(false);
      setStage(null);
      setLiveText('');
      setLiveTrace(null);
      setApprovals([]);
    }
  }, [busy, images, input, modelConfigured]);

  const answer = useCallback(async (id: string, allow: boolean) => {
    setApprovals((list) => list.filter((a) => a.id !== id));
    try {
      const res = await fetch('/api/approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, allow }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setErr(body?.error ?? '这条确认已失效');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const canSend = !busy && modelConfigured && (input.trim().length > 0 || images.length > 0);

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="t">对话</span>
        <span className="dim small">它自己动手做；过程默认收起，想看就点开</span>
        <span style={{ flex: 1 }} />
        {modelConfigured ? (
          <span className="badge" data-tone="ok">
            模型已就绪
          </span>
        ) : (
          <span className="badge" data-tone="warn">
            未配置模型
          </span>
        )}
      </div>

      <div className="chat-body" ref={scrollRef}>
        <div className="chat-inner">
          {msgs.length === 0 && liveTrace === null && (
            <div className="stack">
              <p className="muted">
                说一件事，管家会自己做；做完会告诉你它凭什么这么做。
              </p>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setInput(s);
                      taRef.current?.focus();
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {!modelConfigured && (
                <div className="note" data-tone="warn">
                  还没有配置模型：在 <code>.env.local</code> 里设置 <code>DEEPSEEK_API_KEY</code>{' '}
                  后重启服务。记忆、审计、设置三个页面不依赖模型，仍可使用。
                </div>
              )}
            </div>
          )}

          {msgs.map((m) =>
            m.role === 'user' ? (
              <div className="msg-user" key={m.id}>
                {m.images !== undefined && m.images.length > 0 && (
                  <div className="msg-user-imgs">
                    {m.images.map((src, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={`${m.id}_${String(i)}`} src={src} alt={`图片 ${String(i + 1)}`} />
                    ))}
                  </div>
                )}
                {m.text}
              </div>
            ) : (
              <Message key={m.id} msg={m} />
            ),
          )}

          {busy && (
            <div className="msg-a">
              <div className="who">
                <span>管家</span>
                {stage !== null && <span className="dim">· {stage}</span>}
              </div>
              {liveText.length > 0 ? (
                <div className="text">{liveText}</div>
              ) : (
                <div className="think">正在处理</div>
              )}
              {liveTrace !== null && liveTrace.rounds.length > 0 && <TraceBlock trace={liveTrace} />}
            </div>
          )}

          {err !== null && (
            <div className="note" data-tone="warn">
              {err}
            </div>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {approvals.map((a) => (
          <div className="composer" key={a.id} style={{ paddingBottom: 0 }}>
            <div className="approval">
              <div className="h">需要你确认</div>
              <div className="b">
                <code>{a.toolName}</code>
                {a.tier.length > 0 && <span className="dim small"> · {a.tier}</span>}：{a.summary}
              </div>
              {a.preview !== undefined && a.preview.length > 0 && <div className="p">{a.preview}</div>}
              <div className="f">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => void answer(a.id, true)}>
                  允许
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void answer(a.id, false)}>
                  拒绝
                </button>
                <span className="dim tiny">超时未答复按拒绝处理</span>
              </div>
            </div>
          </div>
        ))}

        <div className="composer">
          {images.length > 0 && (
            <div className="thumbs">
              {images.map((it, i) => (
                <div className="thumb" key={`${it.name}_${String(i)}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={it.url} alt={it.name} />
                  <button
                    type="button"
                    aria-label="移除"
                    onClick={() => setImages((list) => list.filter((_, idx) => idx !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="composer-box">
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              placeholder={modelConfigured ? '说一件事，回车发送；Shift+回车换行' : '未配置模型，暂时无法对话'}
              onChange={(e) => {
                setInput(e.target.value);
                grow();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length > 0) {
                  e.preventDefault();
                  addImages(files);
                }
              }}
              disabled={!modelConfigured}
            />
            <div className="composer-foot">
              <button
                type="button"
                className="attach"
                onClick={() => fileRef.current?.click()}
                disabled={!modelConfigured || images.length >= MAX_IMAGES}
              >
                图片
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  addImages(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <span className="dim tiny">图片只对这一轮有效</span>
              <span className="spacer" />
              <button type="button" className="btn btn-primary btn-sm" disabled={!canSend} onClick={() => void send()}>
                {busy ? '处理中…' : '发送'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 一条管家消息 ──────────────────────────────────────────

function Message({ msg }: { readonly msg: Msg }): React.ReactElement {
  return (
    <div className="msg-a">
      <div className="who">
        <span>管家</span>
        {msg.verdict !== undefined && (
          <span className="badge" data-tone={msg.verdict.outcome === 'accepted' ? 'ok' : 'warn'}>
            {msg.verdict.outcome === 'accepted' ? '已通过复核' : '被打回'}
          </span>
        )}
        {msg.verdict?.issues !== undefined && msg.verdict.issues.length > 0 && (
          <span className="dim tiny">{msg.verdict.issues.length} 条复核意见</span>
        )}
      </div>
      <div className="text">{msg.text}</div>
      {msg.verdict?.corrected !== undefined && (
        <div className="note">纠正过：{msg.verdict.corrected}</div>
      )}
      {msg.trace !== undefined && <TraceBlock trace={msg.trace} defaultOpen={false} />}
    </div>
  );
}

// ── 执行过程（默认收起）──────────────────────────────────

function TraceBlock({
  trace,
  defaultOpen = false,
}: {
  readonly trace: Trace;
  readonly defaultOpen?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const toolCount = trace.rounds.reduce((n, r) => n + r.tools.length, 0);
  const summary =
    trace.finished !== undefined
      ? `${trace.finished.rounds} 轮 · ${toolCount} 次工具调用` +
        (trace.finished.hitRoundLimit ? ' · 触到轮次上限' : '')
      : `${trace.rounds.length} 轮进行中`;

  return (
    <div className="msg-tools">
      <button type="button" className="disclosure" data-open={open ? '' : undefined} onClick={() => setOpen((v) => !v)}>
        <span className="chev">▶</span>
        <span>执行过程</span>
        <span className="dim">· {summary}</span>
      </button>

      {open && (
        <div className="trace">
          {trace.rounds.map((r) => (
            <div className="trace-item" key={r.round}>
              <div>
                <span className="dim">第 {r.round} 轮</span>
                {r.reasoning.length > 0 && <div className="think">{clip(r.reasoning, 600)}</div>}
              </div>
              {r.tools.map((t) => (
                <div key={t.callId} style={{ marginTop: 6 }}>
                  <div>
                    <span className="mono">{t.name}</span>{' '}
                    {t.ok === true && <span className="badge" data-tone="ok">成功</span>}
                    {t.ok === false && (
                      <span className="badge" data-tone={t.denied === true ? 'warn' : 'danger'}>
                        {t.denied === true ? '被拒绝' : '失败'}
                      </span>
                    )}
                    {t.durationMs !== undefined && <span className="dim tiny"> · {t.durationMs}ms</span>}
                  </div>
                  {t.args.length > 0 && <pre>{clip(t.args, 1200)}</pre>}
                  {t.output.length > 0 && <pre>{clip(t.output, 1200)}</pre>}
                </div>
              ))}
            </div>
          ))}
          {trace.finished !== undefined && trace.finished.reason.length > 0 && (
            <div className="trace-item dim">结束原因：{trace.finished.reason}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 工具函数 ─────────────────────────────────────────────

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…（共 ${s.length} 字）`;
}

/** 深拷贝一份轨迹（state 需要新引用才会重渲染）*/
function cloneTrace(t: Trace): Trace {
  return {
    rounds: t.rounds.map((r) => ({ round: r.round, reasoning: r.reasoning, tools: r.tools.map((x) => ({ ...x })) })),
    ...(t.finished !== undefined ? { finished: t.finished } : {}),
  };
}

/** 把 `agent` 事件折叠进 trace（纯函数，便于阅读）*/
function applyAgent(trace: Trace, e: Record<string, unknown>): Trace {
  const kind = String(e['kind'] ?? '');
  const round = Number(e['round'] ?? 0);
  const rounds = [...trace.rounds];

  const ensure = (): TraceRound => {
    const found = rounds.findIndex((r) => r.round === round);
    if (found >= 0) return rounds[found] as TraceRound;
    const fresh: TraceRound = { round, reasoning: '', tools: [] };
    rounds.push(fresh);
    rounds.sort((a, b) => a.round - b.round);
    return fresh;
  };

  if (kind === 'reasoning') {
    const r = ensure();
    r.reasoning = String(e['accumulated'] ?? '');
  } else if (kind === 'toolStarted') {
    const r = ensure();
    r.tools = [
      ...r.tools,
      { callId: String(e['callId'] ?? ''), name: String(e['name'] ?? ''), args: '', output: '' },
    ];
  } else if (kind === 'toolCall') {
    const r = ensure();
    const id = String(e['callId'] ?? '');
    const partial = String(e['partial'] ?? '');
    r.tools = r.tools.map((t) => (t.callId === id ? { ...t, args: partial } : t));
  } else if (kind === 'toolResult') {
    const r = ensure();
    const id = String(e['callId'] ?? '');
    r.tools = r.tools.map((t) =>
      t.callId === id
        ? {
            ...t,
            ok: e['ok'] === true,
            denied: e['denied'] === true,
            output: String(e['output'] ?? ''),
            durationMs: Number(e['durationMs'] ?? 0),
          }
        : t,
    );
  } else if (kind === 'finished') {
    return {
      rounds,
      finished: {
        rounds: Number(e['rounds'] ?? rounds.length),
        reason: String(e['reason'] ?? ''),
        hitRoundLimit: e['hitRoundLimit'] === true,
      },
    };
  }

  return { rounds, ...(trace.finished !== undefined ? { finished: trace.finished } : {}) };
}




