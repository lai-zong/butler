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
  }, [messages, progress, scrollToBottom]);

  // ── 发送 ──

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (text.length === 0 || busy) return;

    setBusy(true);
    setError(null);
    setVerdict(null);
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

    if (type === 'error') {
      setError(String(e['message'] ?? '未知错误'));
    }
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

              {/* ── 审查结论 ── */}
              {verdict !== null && <VerdictCard verdict={verdict} />}

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
function VerdictCard({ verdict }: { readonly verdict: Verdict }) {
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
    </div>
  );
}
