'use client';

/**
 * 对话空间 —— 产品的主界面
 *
 * 设计要点（每一处都对应一个能力）：
 *   · 流式叙述：等待执行时先说思路，不让用户盯着转圈
 *   · 过程面板：思考 → 工具 → 再思考，全部可展开
 *   · 契约与复核：干前写了什么、干完逐条核对
 *   · 反思回执：这一轮学到了什么、几条等你确认
 *   · 依据条：召回 / 注入 / 拦截，一键跳到审计
 *
 * ⚠️ 对话在切换空间时**不卸载**（由父层保持挂载）：
 *   切去看一眼记忆不该把正在跑的任务掐掉。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Markdown } from '../components/Markdown';
import { Badge, Collapse, EmptyState, InlineError, Skeleton } from '../components/Common';
import { useAutoResize, useMounted, useNow } from '../lib/hooks.js';
import { ApiError, errorMessage, fetchJson, postJson } from '../lib/api.js';
import {
  formatClock,
  formatDateFull,
  formatNumber,
  greeting,
  relativeTime,
  truncate,
} from '../lib/format.js';
import { applyEvent, asSseEvent, emptyAssistant } from '../lib/chatLive.js';
import type { ChatBootState } from '../lib/boot.js';
import type {
  AgentTrace,
  AuditResponse,
  LiveAssistant,
  LiveTurn,
  MessageDto,
  Overview,
  QuizItem,
  SessionCreateResponse,
  SessionDetailResponse,
  SessionSummary,
  SessionsResponse,
  SseEvent,
  ToastMessage,
  VerdictDto,
  MemoryTarget,
} from '../lib/types.js';
import { ProcessPanel, type ProcRound } from './Process';
import {
  AssumptionNotice,
  AuditStrip,
  ContractCard,
  MemoryRefs,
  ReflectionCard,
  ReportsPanel,
  VerdictCard,
} from './Cards';
import { QuizSection } from './Quiz';

interface ChatViewProps {
  readonly active: boolean;
  readonly focusEnabled: boolean;
  readonly overview: Overview | null;
  readonly newChatNonce: number;
  readonly dataResetNonce: number;
  readonly onOpenAudit: (range: { readonly fromSeq: number; readonly toSeq: number } | null) => void;
  readonly onOpenMemory: (opts?: MemoryTarget) => void;
  readonly onOpenSettings: () => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onRefreshOverview: () => void;
  readonly onBootState: (state: ChatBootState) => void;
}

interface Attachment {
  readonly name: string;
  readonly url: string;
}

interface ApprovalQueueItem {
  readonly id: string;
  readonly toolName: string;
  readonly tier: string;
  readonly summary: string;
  readonly preview?: string;
  readonly timeoutMs: number;
  readonly receivedAt: number;
}

const SUGGESTIONS: readonly { readonly icon: 'memory' | 'calendar' | 'growth'; readonly text: string }[] = [
  { icon: 'memory', text: '看看冰箱里还有什么，能做什么' },
  { icon: 'calendar', text: '帮我安排明天，避开效率最低的时段' },
  { icon: 'growth', text: '复盘这周，我有哪些反复出现的问题' },
];

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function patchLast(turns: readonly LiveTurn[], fn: (a: LiveAssistant) => LiveAssistant): LiveTurn[] {
  if (turns.length === 0) return [...turns];
  const index = turns.length - 1;
  const current = turns[index];
  if (current === undefined) return [...turns];
  const next = [...turns];
  next[index] = { ...current, assistant: fn(current.assistant) };
  return next;
}

function traceToRounds(trace: AgentTrace | null): ProcRound[] {
  if (trace === null) return [];
  return trace.rounds.map((r) => ({
    round: r.round,
    maxRounds: r.maxRounds,
    reasoning: r.reasoning,
    text: r.text,
    tools: r.toolCalls.map((c) => ({
      callId: c.callId,
      name: c.name,
      argsText: c.argsText,
      status: c.denied ? 'denied' : c.ok ? 'ok' : 'error',
      output: c.output,
      durationMs: c.durationMs,
    })),
  }));
}

function statusLabel(a: LiveAssistant): string {
  if (a.status === 'waiting') return '正在读取上下文';
  if (a.status === 'streaming') return a.stages[a.stages.length - 1] ?? '正在处理';
  if (a.status === 'error') return '这一轮出错了';
  if (a.status === 'aborted') return '已断开接收';
  return '';
}

async function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export function ChatView({
  active,
  focusEnabled,
  overview,
  newChatNonce,
  dataResetNonce,
  onOpenAudit,
  onOpenMemory,
  onOpenSettings,
  notify,
  onRefreshOverview,
  onBootState,
}: ChatViewProps): JSX.Element {
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly MessageDto[]>([]);
  const [verdicts, setVerdicts] = useState<readonly VerdictDto[]>([]);
  const [quizzes, setQuizzes] = useState<readonly QuizItem[]>([]);
  const [liveTurns, setLiveTurns] = useState<readonly LiveTurn[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [approvals, setApprovals] = useState<readonly ApprovalQueueItem[]>([]);
  const [answering, setAnswering] = useState(false);
  const [tick, setTick] = useState(() => Date.now());

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const atBottomRef = useRef(true);
  const forceScrollRef = useRef(true);
  const bootRef = useRef(false);
  const loadSeqRef = useRef(0);
  const lastNonceRef = useRef(0);

  const now = useNow(30_000);
  const mounted = useMounted();
  const canChat = overview === null || overview.model !== null;
  const hasContent = messages.length > 0 || liveTurns.length > 0;

  useAutoResize(textareaRef, input);

  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchJson<SessionsResponse>('/api/sessions');
      setSessions(res.sessions);
    } catch {
      // 列表刷新失败不打断主流程；首屏错误由 loadSession 呈现
    }
  }, []);

  const loadSession = useCallback(async (id: string): Promise<{ readonly ok: boolean; readonly error: string | null }> => {
    const token = ++loadSeqRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setLoadingSession(true);
    setSessionError(null);
    setLiveTurns([]);
    setMessages([]);
    setVerdicts([]);
    setQuizzes([]);
    setSessionId(id);
    setApprovals([]);
    forceScrollRef.current = true;

    try {
      const res = await fetchJson<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}`);
      if (token !== loadSeqRef.current) return { ok: false, error: null };
      setMessages(res.messages);
      setVerdicts(res.verdicts);
      setQuizzes(res.quizzes);
      return { ok: true, error: null };
    } catch (err) {
      if (token !== loadSeqRef.current) return { ok: false, error: null };
      const message = errorMessage(err);
      setSessionError(message);
      return { ok: false, error: message };
    } finally {
      if (token === loadSeqRef.current) setLoadingSession(false);
    }
  }, []);

  const createNewChat = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setApprovals([]);
    try {
      const res = await postJson<SessionCreateResponse>('/api/sessions', {});
      setSessions((prev) => [res.session, ...prev]);
      setSessionId(res.session.id);
      setMessages([]);
      setVerdicts([]);
      setQuizzes([]);
      setLiveTurns([]);
      setSessionError(null);
      setHistoryOpen(false);
      setAttachments([]);
      forceScrollRef.current = true;
      window.setTimeout(() => textareaRef.current?.focus(), 140);
    } catch (err) {
      notify(errorMessage(err), 'danger');
    }
  }, [notify]);

  // 首屏：取会话列表；有历史则打开最近一个
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    let cancelled = false;
    onBootState({ state: 'loading', phase: 'sessions' });

    void (async () => {
      try {
        const res = await fetchJson<SessionsResponse>('/api/sessions');
        if (cancelled) return;
        setSessions(res.sessions);
        const first = res.sessions[0];
        if (first !== undefined) {
          onBootState({ state: 'loading', phase: 'session' });
          const outcome = await loadSession(first.id);
          if (cancelled) return;
          if (!outcome.ok) {
            onBootState({ state: 'error', error: outcome.error ?? '会话加载失败' });
            return;
          }
        }
        onBootState({ state: 'ready' });
      } catch (err) {
        if (cancelled) return;
        const message = errorMessage(err);
        setSessionError(message);
        onBootState({ state: 'error', error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadSession, onBootState]);

  // 外部「新建对话」指令
  useEffect(() => {
    if (newChatNonce === 0 || lastNonceRef.current === newChatNonce) return;
    lastNonceRef.current = newChatNonce;
    void createNewChat();
  }, [newChatNonce, createNewChat]);

  // 数据被替换（导入备份）→ 旧会话 id 已失效，重新读取
  useEffect(() => {
    if (dataResetNonce === 0) return;
    void (async () => {
      abortRef.current?.abort();
      abortRef.current = null;
      setStreaming(false);
      setLiveTurns([]);
      setApprovals([]);
      try {
        const res = await fetchJson<SessionsResponse>('/api/sessions');
        setSessions(res.sessions);
        const first = res.sessions[0];
        if (first !== undefined) {
          await loadSession(first.id);
        } else {
          setSessionId(null);
          setMessages([]);
          setVerdicts([]);
          setQuizzes([]);
          setSessionError(null);
        }
      } catch (err) {
        setSessionError(errorMessage(err));
      }
    })();
  }, [dataResetNonce, loadSession]);

  // 回到对话时，若本来就在底部就贴到底
  useEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    if (el === null) return;
    if (forceScrollRef.current || atBottomRef.current) {
      forceScrollRef.current = false;
      el.scrollTop = el.scrollHeight;
    }
  }, [active, messages, liveTurns]);

  useEffect(() => {
    if (!active || !focusEnabled) return;
    textareaRef.current?.focus();
  }, [active, focusEnabled]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function ensureSession(): Promise<string | null> {
    if (sessionId !== null) return sessionId;
    try {
      const res = await postJson<SessionCreateResponse>('/api/sessions', {});
      setSessions((prev) => [res.session, ...prev]);
      setSessionId(res.session.id);
      return res.session.id;
    } catch (err) {
      notify(errorMessage(err), 'danger');
      return null;
    }
  }

  async function send(override?: string): Promise<void> {
    if (streaming) return;
    const text = (override ?? input).trim();
    if (text.length === 0 && attachments.length === 0) return;
    if (!canChat) {
      notify('还没有配置模型。请在设置里查看接入方式。', 'warning');
      return;
    }

    const outgoing = attachments.map((a) => a.url);
    forceScrollRef.current = true;
    atBottomRef.current = true;
    setInput('');
    setAttachments([]);

    const id = await ensureSession();
    if (id === null) return;

    setLiveTurns((prev) => [
      ...prev,
      {
        userText: text,
        images: outgoing,
        assistant: emptyAssistant(),
      },
    ]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    /**
     * SSE 事件可能非常密（工具参数逐片到达，实测一轮能有数千片）。
     * 逐片 setState 会让主线程一直重渲染；这里按 48ms 合并成一批。
     */
    const queue: SseEvent[] = [];
    let flushTimer: number | null = null;

    const flushQueue = (): void => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (queue.length === 0) return;
      const batch = queue.splice(0, queue.length);
      setLiveTurns((prev) => {
        if (prev.length === 0) return prev;
        const index = prev.length - 1;
        const current = prev[index];
        if (current === undefined) return prev;
        let assistant = current.assistant;
        for (const item of batch) assistant = applyEvent(assistant, item);
        const next = [...prev];
        next[index] = { ...current, assistant };
        return next;
      });
    };

    const scheduleFlush = (): void => {
      if (flushTimer === null) flushTimer = window.setTimeout(flushQueue, 48);
    };

    const handle = (ev: SseEvent): void => {
      if (ev.type === 'session') {
        setSessionId((current) => (current === ev.sessionId ? current : ev.sessionId));
        return;
      }

      if (ev.type === 'approval') {
        setApprovals((prev) => [
          ...prev,
          {
            id: ev.id,
            toolName: ev.toolName,
            tier: ev.tier,
            summary: ev.summary,
            ...(ev.preview !== undefined ? { preview: ev.preview } : {}),
            timeoutMs: ev.timeoutMs,
            receivedAt: Date.now(),
          },
        ]);
        notify('管家在等你确认一个动作', 'warning');
        return;
      }

      queue.push(ev);
      scheduleFlush();

      if (ev.type === 'audit') {
        void fetchJson<AuditResponse>(`/api/audit?from=${ev.range.fromSeq}&to=${ev.range.toSeq}`)
          .then((res) => {
            setLiveTurns((prev) => patchLast(prev, (a) => ({ ...a, audit: res.audit })));
          })
          .catch(() => undefined);
      }
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          sessionId: id,
          text,
          supportsApproval: true,
          ...(outgoing.length > 0 ? { images: outgoing.map((url) => ({ url })) } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let payload: unknown = null;
        try {
          payload = (await res.json()) as unknown;
        } catch {
          payload = null;
        }
        const msg =
          typeof payload === 'object' && payload !== null && typeof (payload as Record<string, unknown>)['error'] === 'string'
            ? String((payload as Record<string, unknown>)['error'])
            : `请求失败（HTTP ${res.status}）`;
        throw new ApiError(msg, res.status, payload);
      }

      const reader = res.body?.getReader();
      if (reader === undefined) throw new Error('服务端没有返回可读的流');

      const decoder = new TextDecoder();
      let buffer = '';

      const flush = (block: string): void => {
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data.length === 0) return;
        try {
          const parsed = asSseEvent(JSON.parse(data) as unknown);
          if (parsed !== null) handle(parsed);
        } catch {
          // 单条坏事件不该让整轮流式中断
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          flush(block);
          index = buffer.indexOf('\n\n');
        }
      }
      if (buffer.trim().length > 0) flush(buffer);
      flushQueue();
    } catch (err) {
      flushQueue();
      if (err instanceof DOMException && err.name === 'AbortError') {
        setLiveTurns((prev) => patchLast(prev, (a) => ({ ...a, status: 'aborted' })));
      } else {
        const msg = errorMessage(err);
        setLiveTurns((prev) => patchLast(prev, (a) => ({ ...a, status: 'error', error: msg })));
        notify(msg, 'danger');
      }
    } finally {
      flushQueue();
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
      void refreshSessions();
      onRefreshOverview();
      setApprovals((prev) => prev.filter((a) => a.receivedAt + a.timeoutMs > Date.now()));
    }
  }

  function stop(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    notify('已断开接收。后台仍会把这一轮做完。', 'default');
  }

  async function addFiles(files: readonly File[]): Promise<void> {
    const images = files.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (images.length < files.length) notify('只接受 PNG / JPEG / GIF / WebP 图片', 'warning');
    if (images.length === 0) return;
    if (attachments.length + images.length > MAX_IMAGES) {
      notify(`一次最多附 ${MAX_IMAGES} 张图片`, 'warning');
    }

    const room = Math.max(0, MAX_IMAGES - attachments.length);
    const accepted = images.slice(0, room);

    for (const file of accepted) {
      if (file.size > MAX_IMAGE_BYTES) {
        notify(`「${file.name}」超过 32 MiB，已跳过`, 'warning');
        continue;
      }
      try {
        const url = await readAsDataUrl(file);
        if (url.length === 0) continue;
        setAttachments((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, { name: file.name, url }]));
      } catch {
        notify(`「${file.name}」读取失败`, 'warning');
      }
    }
  }

  async function answerApproval(allow: boolean): Promise<void> {
    const current = approvals[0];
    if (current === undefined || answering) return;
    setAnswering(true);
    setApprovals((prev) => prev.slice(1));
    try {
      await postJson('/api/approval', { id: current.id, allow });
      notify(allow ? '已允许这一次操作' : '已拒绝这一次操作', allow ? 'success' : 'default');
    } catch (err) {
      notify(errorMessage(err), 'warning');
    } finally {
      setAnswering(false);
    }
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      notify('已复制', 'success');
    } catch {
      notify('复制失败，请手动选择文本', 'warning');
    }
  }

  function onScroll(): void {
    const el = scrollRef.current;
    if (el === null) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
  }

  const currentSession = sessions.find((s) => s.id === sessionId);
  const liveTitle = liveTurns[0] !== undefined ? truncate(liveTurns[0].userText, 24) : null;
  const derivedTitle =
    currentSession !== undefined && currentSession.title !== '新对话'
      ? currentSession.title
      : (liveTitle ?? currentSession?.title ?? '新对话');
  const subtitle =
    currentSession !== undefined
      ? `${currentSession.turnCount} 次对话 · ${relativeTime(currentSession.updatedAt, now)}`
      : '一段新的上下文';

  const activeApproval = approvals[0] ?? null;
  const effectiveNow =
    activeApproval !== null ? Math.max(tick, activeApproval.receivedAt) : tick;
  const remainingMs =
    activeApproval !== null
      ? Math.max(0, activeApproval.receivedAt + activeApproval.timeoutMs - effectiveNow)
      : 0;
  const remainingSec = Math.ceil(remainingMs / 1000);

  useEffect(() => {
    if (activeApproval !== null) setTick(Date.now());
  }, [activeApproval]);

  useEffect(() => {
    if (activeApproval === null) return;
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeApproval]);

  useEffect(() => {
    if (activeApproval === null) return;
    if (remainingMs > 0) return;
    setApprovals((prev) => prev.slice(1));
    notify('确认请求已超时，已自动拒绝', 'warning');
  }, [remainingMs, activeApproval, notify]);

  const suggestionNodes = useMemo(
    () =>
      SUGGESTIONS.map((s, i) => (
        <button
          key={s.text}
          type="button"
          className="hero-suggestion"
          style={{ animationDelay: `${120 + i * 60}ms` }}
          onClick={() => {
            setInput(s.text);
            window.setTimeout(() => textareaRef.current?.focus(), 60);
          }}
        >
          <Icon name={s.icon} size={16} />
          <span>{s.text}</span>
          <Icon name="chevronRight" size={14} className="hero-suggestion-arrow" />
        </button>
      )),
    [],
  );

  /**
   * 读屏播报：只在**状态变化**时更新（不是每个 token 都念）。
   * 用 visually-hidden 的 polite 区域，避免把整段回复重复读一遍。
   */
  const lastLive = liveTurns[liveTurns.length - 1]?.assistant;
  const announcement = streaming
    ? '正在生成回复'
    : lastLive === undefined
      ? ''
      : lastLive.status === 'error'
        ? '回复失败'
        : lastLive.status === 'aborted'
          ? '已断开接收，后台仍会完成这一轮'
          : lastLive.status === 'done'
            ? '回复完成'
            : '';

  return (
    <div className={`chat-view ${active ? 'is-active' : ''}`}>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <header className="chat-head">
        <div className="chat-head-main">
          <button
            type="button"
            className="icon-btn chat-history-btn"
            onClick={() => {
              setHistoryOpen(true);
              void refreshSessions();
            }}
            aria-label="打开对话记录"
          >
            <Icon name="history" size={18} />
          </button>
          <div className="chat-head-title">
            <h1 title={derivedTitle}>{derivedTitle}</h1>
            <p>{subtitle}</p>
          </div>
        </div>
        <div className="chat-head-actions">
          {overview !== null && overview.model !== null && (
            <span className="model-pill mono" title="当前主力模型">
              <span className="status-dot is-ok" />
              {overview.model.model}
            </span>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setHistoryOpen(true); void refreshSessions(); }}>
            <Icon name="history" size={15} /> 记录
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void createNewChat()}>
            <Icon name="plus" size={15} /> 新对话
          </button>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} aria-busy={streaming}>
        <div className="chat-column">
          {!hasContent && !loadingSession && sessionError === null && (
            <section className="chat-hero">
              <div className="hero-orbit" aria-hidden="true">
                <span className="hero-orbit-ring hero-orbit-ring--1" />
                <span className="hero-orbit-ring hero-orbit-ring--2" />
                <span className="hero-orbit-core">
                  <Icon name="memory" size={22} />
                </span>
              </div>
              <p className="eyebrow eyebrow--brand">butler · 常驻在你的电脑里</p>
              <h1>
                {mounted ? greeting() : '你好'}
                ，今天想做点什么？
              </h1>
              <p className="hero-sub">
                它记得你，也替你办事。每一轮都会先写下任务契约，结束后由监督员逐条复核。
              </p>

              <div className="hero-memory-line">
                <button type="button" onClick={() => onOpenMemory()}>
                  已记得 <strong>{formatNumber(overview?.memory.active ?? 0)}</strong> 件事
                </button>
                <span className="hero-dot">·</span>
                <span>{formatNumber(overview?.memory.principles.total ?? 0)} 条原则</span>
                {(overview?.memory.pending ?? 0) > 0 && (
                  <>
                    <span className="hero-dot">·</span>
                    <button type="button" className="is-accent" onClick={() => onOpenMemory({ pending: true })}>
                      {overview?.memory.pending} 条等你确认
                    </button>
                  </>
                )}
              </div>

              <div className="hero-suggestions">{suggestionNodes}</div>

              <p className="hero-foot">
                {mounted ? formatDateFull(Date.now()) : ''}
                <span> · 数据只在这台电脑上</span>
              </p>
            </section>
          )}

          {loadingSession && (
            <div className="chat-loading">
              <Skeleton rows={2} height={18} />
              <div className="chat-loading-gap" />
              <Skeleton rows={4} height={14} />
            </div>
          )}

          {sessionError !== null && !loadingSession && (
            <InlineError
              message={sessionError}
              onRetry={() => {
                if (sessionId !== null) void loadSession(sessionId);
                else {
                  setSessionError(null);
                  void refreshSessions();
                }
              }}
            />
          )}

          <div className="chat-messages">
            {messages.map((m, i) => (
              <ServerMessage
                key={m.id}
                message={m}
                verdict={verdictFor(messages, verdicts, i)}
                onOpenAudit={() => onOpenAudit(null)}
                onOpenMemory={onOpenMemory}
                notify={notify}
                now={now}
              />
            ))}

            {liveTurns.map((turn, i) => (
              <LiveTurnView
                key={`live-${i}`}
                turn={turn}
                onOpenAudit={onOpenAudit}
                onOpenMemory={onOpenMemory}
                onRetry={(text) => {
                  setInput(text);
                  window.setTimeout(() => textareaRef.current?.focus(), 60);
                }}
                onCopy={(text) => void copyText(text)}
              />
            ))}

            {quizzes.length > 0 && sessionId !== null && (
              <QuizInvite sessionId={sessionId} quizzes={quizzes} notify={notify} />
            )}
          </div>
        </div>
      </div>

      <div className="chat-composer-wrap">
        <div className="chat-column">
          {overview !== null && overview.model === null && (
            <div className="chat-banner">
              <span className="chat-banner-icon">
                <Icon name="info" size={16} />
              </span>
              <span>
                还没有配置模型。设置 <code className="mono">DEEPSEEK_API_KEY</code> 后重启服务即可对话；
                记忆治理不依赖模型。
              </span>
              <button type="button" className="text-btn" onClick={onOpenSettings}>
                去设置
                <Icon name="chevronRight" size={13} />
              </button>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="attach-row">
              {attachments.map((a, i) => (
                <div key={`${a.name}-${i}`} className="attach-thumb">
                                    <img src={a.url} alt={a.name} />
                  <button
                    type="button"
                    className="attach-remove"
                    aria-label={`移除 ${a.name}`}
                    onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className={`composer ${streaming ? 'is-busy' : ''}`}>
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              placeholder={canChat ? '说说你想办的事…（Enter 发送，Shift+Enter 换行）' : '未配置模型，暂不能对话'}
              aria-label="输入消息"
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-bar">
              <div className="composer-tools">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files !== null) void addFiles(Array.from(e.target.files));
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => fileRef.current?.click()}
                  title="附一张图片（仅本轮可见，不写入记忆）"
                  aria-label="添加图片"
                >
                  <Icon name="paperclip" size={18} />
                </button>
                <span className="composer-hint">
                  {attachments.length > 0 ? `${attachments.length} 张 · 仅本轮可见` : '图片仅本轮可见'}
                </span>
              </div>

              {streaming ? (
                <button type="button" className="send-btn send-btn--stop" onClick={stop} aria-label="断开接收">
                  <Icon name="stop" size={16} />
                </button>
              ) : (
                <button
                  type="button"
                  className="send-btn"
                  onClick={() => void send()}
                  disabled={!canChat || (input.trim().length === 0 && attachments.length === 0)}
                  aria-label="发送"
                >
                  <Icon name="arrowUp" size={17} />
                </button>
              )}
            </div>
          </div>
          <p className="composer-note">
            {streaming ? (
              <span className="composer-live">
                <span className="typing-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {statusLabel(liveTurns[liveTurns.length - 1]?.assistant ?? emptyAssistant()) || '正在处理'}
              </span>
            ) : (
              <>它会在动手前写下契约 · 结束后逐条核对 · 随时可查依据</>
            )}
          </p>
        </div>
      </div>

      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="对话记录"
        description="按最近更新排序。切换会话不会删除任何东西。"
        variant="sheet"
        footer={
          <div className="sheet-footer">
            <span className="sheet-foot-note">共 {formatNumber(sessions.length)} 段对话</span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void createNewChat()}>
              <Icon name="plus" size={15} /> 新建对话
            </button>
          </div>
        }
      >
        <div className="session-list">
          {sessions.length === 0 && (
            <EmptyState compact icon="history" title="还没有对话" description="第一次开口之后，这里会出现历史。" />
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`session-item ${s.id === sessionId ? 'is-active' : ''}`}
              onClick={() => {
                setHistoryOpen(false);
                void loadSession(s.id);
              }}
            >
              <span className="session-item-top">
                <strong>{s.title}</strong>
                <small>{relativeTime(s.updatedAt, now)}</small>
              </span>
              <span className="session-item-preview">{s.lastPreview.length > 0 ? s.lastPreview : '没有消息'}</span>
              <span className="session-item-meta mono">
                {s.messageCount} 条 · {s.turnCount} 回合
              </span>
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        open={active && activeApproval !== null}
        onClose={() => undefined}
        title="需要你确认一个动作"
        description="允许只对这一次生效。若超时不答复，会自动拒绝。"
        variant="dialog"
        hideClose
        closeOnBackdrop={false}
        footer={
          activeApproval !== null ? (
            <div className="approval-foot">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={answering}
                onClick={() => void answerApproval(false)}
              >
                拒绝
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={answering}
                onClick={() => void answerApproval(true)}
              >
                <Icon name="check" size={15} /> 允许一次
              </button>
            </div>
          ) : undefined
        }
      >
        {activeApproval !== null && (
          <div className="approval-body">
            <div className="approval-tool">
              <span className="approval-tool-icon">
                <Icon name="shield" size={18} />
              </span>
              <div>
                <p className="approval-name mono">{activeApproval.toolName}</p>
                <div className="approval-tags">
                  <Badge tone={activeApproval.tier === 'highRisk' ? 'warn' : 'neutral'}>
                    {activeApproval.tier === 'highRisk' ? '高风险' : activeApproval.tier === 'normal' ? '普通' : activeApproval.tier}
                  </Badge>
                  <Badge tone="outline">一次性授权</Badge>
                </div>
              </div>
              <span className="approval-countdown mono">{remainingSec}s</span>
            </div>

            <p className="approval-summary">{activeApproval.summary}</p>

            {activeApproval.preview !== undefined && activeApproval.preview.length > 0 && (
              <pre className="code-block approval-preview">{activeApproval.preview}</pre>
            )}

            <div className="approval-progress" aria-hidden="true">
              <span
                style={{
                  width: `${Math.min(100, (remainingMs / Math.max(1, activeApproval.timeoutMs)) * 100)}%`,
                }}
              />
            </div>

            {approvals.length > 1 && (
              <p className="approval-queue">还有 {approvals.length - 1} 个请求在排队。</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 渲染：已保存的消息
// ═══════════════════════════════════════════════════════════

function QuizInvite({
  sessionId,
  quizzes,
  notify,
}: {
  readonly sessionId: string;
  readonly quizzes: readonly QuizItem[];
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const questions = quizzes.reduce((n, q) => n + q.questions.length, 0);

  return (
    <section className={`quiz-invite ${open ? 'is-open' : ''}`}>
      <div className="quiz-invite-head">
        <span className="quiz-invite-icon">
          <Icon name="file" size={18} />
        </span>
        <div className="quiz-invite-text">
          <strong>这一轮留下了一套练习</strong>
          <p>
            {quizzes.length} 套 · {questions} 题 · 确定性批改，不调用模型
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? '收起' : '开始作答'}
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        </button>
      </div>
      <Collapse open={open}>
        <div className="quiz-invite-body">
          <QuizSection sessionId={sessionId} quizzes={quizzes} notify={notify} embedded />
        </div>
      </Collapse>
    </section>
  );
}

function verdictFor(
  messages: readonly MessageDto[],
  verdicts: readonly VerdictDto[],
  index: number,
): VerdictDto | undefined {
  const message = messages[index];
  if (message === undefined || message.role !== 'butler') return undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = messages[i];
    if (prev !== undefined && prev.role === 'user') {
      return verdicts.find((v) => v.forMessageId === prev.id);
    }
  }
  return undefined;
}

function ServerMessage({
  message,
  verdict,
  onOpenAudit,
  onOpenMemory,
  notify,
  now,
}: {
  readonly message: MessageDto;
  readonly verdict: VerdictDto | undefined;
  readonly onOpenAudit: () => void;
  readonly onOpenMemory: (opts?: MemoryTarget) => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly now: number;
}): JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="msg msg--user">
        <div className="user-bubble">{message.text}</div>
        <div className="msg-meta">
          <span>{formatClock(message.createdAt)}</span>
        </div>
      </div>
    );
  }

  if (message.role === 'system') {
    return (
      <div className="msg-system">
        <Icon name="info" size={14} />
        <span>{message.text}</span>
      </div>
    );
  }

  const rounds = traceToRounds(message.agentTrace);
  const label = message.servantLabel;

  return (
    <article className="msg msg--butler">
      <header className="msg-head">
        <span className="butler-mark">
          <Icon name="memory" size={14} />
        </span>
        <strong>管家</strong>
        {label !== null && <Badge tone="outline">{label}</Badge>}
        <span className="msg-time" title={formatDateFull(message.createdAt)}>
          {relativeTime(message.createdAt, now)}
        </span>
        {message.status === 'failed' && <Badge tone="danger">未完成</Badge>}
      </header>

      <ProcessPanel
        rounds={rounds}
        narrationReasoning={message.reasoning ?? ''}
        narrationTranslated={message.reasoningTranslated ?? ''}
        durationMs={verdict?.durationMs ?? null}
        injectedConstraints={[]}
      />

      <div className="msg-body">
        <Markdown text={message.text} />
      </div>

      {verdict !== undefined && (
        <VerdictCard verdict={verdict} onOpenAudit={onOpenAudit} />
      )}

      {message.servantReports !== null && <ReportsPanel reports={message.servantReports} />}
      {message.memoryRefs.length > 0 && <MemoryRefs refs={message.memoryRefs} />}

      <footer className="msg-foot">
        <button type="button" className="text-btn" onClick={() => void copyToClipboard(message.text, notify)}>
          <Icon name="copy" size={13} /> 复制
        </button>
        <button type="button" className="text-btn" onClick={onOpenAudit}>
          <Icon name="audit" size={13} /> 会话依据
        </button>
        <button type="button" className="text-btn" onClick={() => onOpenMemory()}>
          <Icon name="memory" size={13} /> 看记忆
        </button>
      </footer>
    </article>
  );
}

async function copyToClipboard(text: string, notify: (text: string, tone?: ToastMessage['tone']) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify('已复制', 'success');
  } catch {
    notify('复制失败，请手动选择文本', 'warning');
  }
}

// ═══════════════════════════════════════════════════════════
// 渲染：本轮（流式）
// ═══════════════════════════════════════════════════════════

function LiveTurnView({
  turn,
  onOpenAudit,
  onOpenMemory,
  onRetry,
  onCopy,
}: {
  readonly turn: LiveTurn;
  readonly onOpenAudit: (range: { readonly fromSeq: number; readonly toSeq: number } | null) => void;
  readonly onOpenMemory: (opts?: MemoryTarget) => void;
  readonly onRetry: (text: string) => void;
  readonly onCopy: (text: string) => void;
}): JSX.Element {
  const a = turn.assistant;
  const streaming = a.status === 'waiting' || a.status === 'streaming';
  const showNarration = a.text.length === 0 && a.narration.length > 0;

  return (
    <>
      <div className="msg msg--user">
        <div className="user-bubble">
          {turn.images.length > 0 && (
            <div className="user-images">
              {turn.images.map((src, i) => (
                <img key={i} src={src} alt={`附图 ${i + 1}`} />
              ))}
            </div>
          )}
          {turn.userText.length > 0 && turn.userText}
        </div>
        <div className="msg-meta">
          <span>刚刚</span>
        </div>
      </div>

      <article className={`msg msg--butler ${streaming ? 'is-streaming' : ''}`}>
        <header className="msg-head">
          <span className="butler-mark">
            <Icon name="memory" size={14} />
          </span>
          <strong>管家</strong>
          {streaming && (
            <span className="live-status">
              <span className="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {statusLabel(a)}
            </span>
          )}
          {a.status === 'aborted' && <Badge tone="warn">已断开接收</Badge>}
        </header>

        {a.assumption !== null && <AssumptionNotice assumption={a.assumption} />}
        {a.contract !== null && <ContractCard contract={a.contract} />}

        <ProcessPanel
          rounds={a.rounds}
          stages={a.stages}
          narration={a.text.length > 0 ? a.narration : ''}
          narrationReasoning={a.narrationReasoning}
          narrationTranslated={a.narrationTranslated}
          firstChunkMs={a.firstChunkMs}
          finished={a.finished}
          streaming={streaming}
          defaultOpen
          durationMs={a.verdict?.durationMs ?? null}
          injectedConstraints={a.injectedConstraints}
        />

        <div className="msg-body">
          {showNarration ? (
            <div className="live-narration">
              <p className="live-narration-label">
                <span className="live-dot" /> 先说思路 · 方案随后
              </p>
              <Markdown text={a.narration} streaming={streaming} />
            </div>
          ) : a.text.length > 0 ? (
            <Markdown text={a.text} />
          ) : a.status === 'waiting' ? (
            <div className="live-waiting">
              <span className="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>{a.stages[a.stages.length - 1] ?? '正在读取你的上下文…'}</span>
            </div>
          ) : null}

          {a.status === 'error' && a.error !== null && (
            <div className="live-error">
              <span className="live-error-icon">
                <Icon name="alert" size={16} />
              </span>
              <div>
                <strong>这一轮没有完成</strong>
                <p>{a.error}</p>
              </div>
              <button type="button" className="text-btn" onClick={() => onRetry(turn.userText)}>
                重新编辑
              </button>
            </div>
          )}
        </div>

        {a.verdict !== null && (
          <VerdictCard
            verdict={a.verdict}
            onOpenAudit={a.auditRange !== null ? () => onOpenAudit(a.auditRange) : undefined}
          />
        )}

        {a.reflection !== null && (
          <ReflectionCard reflection={a.reflection} onOpenMemory={() => onOpenMemory({ pending: true })} />
        )}

        {a.auditRange !== null && (
          <AuditStrip
            range={a.auditRange}
            audit={a.audit}
            onOpen={() => onOpenAudit(a.auditRange)}
          />
        )}

        {a.reports.length > 0 && <ReportsPanel reports={a.reports} />}

        {!streaming && a.text.length > 0 && (
          <footer className="msg-foot">
            <button type="button" className="text-btn" onClick={() => onCopy(a.text)}>
              <Icon name="copy" size={13} /> 复制
            </button>
            {a.auditRange !== null && (
              <button type="button" className="text-btn" onClick={() => onOpenAudit(a.auditRange)}>
                <Icon name="audit" size={13} /> 本轮依据
              </button>
            )}
            <button type="button" className="text-btn" onClick={() => onOpenMemory()}>
              <Icon name="memory" size={13} /> 看记忆
            </button>
          </footer>
        )}
      </article>
    </>
  );
}
