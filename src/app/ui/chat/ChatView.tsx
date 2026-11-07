'use client';

/**
 * 对话空间 —— 产品的主界面
 *
 * 设计要点（每一处都对应一个能力）：
 *   · 流式叙述：等待执行时先说思路，不让用户盯着转圈
 *   · 过程面板：思考 → 工具 → 再思考，全部可展开
 *   · 契约与复核：干前写了什么、干完逐条核对
 *   · 反思回执：这一轮记录了什么试行记忆
 *   · 依据条：召回 / 注入 / 拦截与 seq 范围，直接留在这一轮下面
 *
 * ⚠️ 对话在切换空间时**不卸载**（由父层保持挂载）：
 *   切去看一眼记忆不该把正在跑的任务掐掉。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

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
  LiveUsage,
  MessageDto,
  Overview,
  QuizItem,
  SessionCreateResponse,
  SessionDetailResponse,
  SessionCancellationDto,
  SessionSummary,
  SessionsResponse,
  SseEvent,
  ToastMessage,
  VerdictDto,
  MemoryTarget,
} from '../lib/types.js';
import { ModelPicker, type ModelChoice, type PickableProfile } from './ModelPicker';
import { ProcessPanel, type ProcRound } from './Process';
import {
  AssumptionNotice,
  ContractCard,
  EvidenceStrip,
  MemoryRefs,
  ReflectionCard,
  ReportsPanel,
  VerdictCard,
} from './Cards';
import { QuizSection } from './Quiz';

const DRAFT_STORAGE_KEY = 'butler.chat.draft';

function readDraftText(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(DRAFT_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDraftText(text: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (text.length === 0) window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    else window.localStorage.setItem(DRAFT_STORAGE_KEY, text);
  } catch {
    // localStorage 不可用时不阻塞输入。
  }
}

function clearDraftText(): void {
  writeDraftText('');
}

interface ModelCatalogResponse {
  readonly profiles: readonly PickableProfile[];
  readonly lastChat: ModelChoice | null;
  readonly lastReview: ModelChoice | null;
}

function fallbackModelChoice(profiles: readonly PickableProfile[]): ModelChoice | null {
  for (const profile of profiles) {
    const model = profile.models.find((m) => m.kind === 'chat');
    if (model === undefined) continue;
    if ((profile.requiresKey ?? true) && !profile.hasKey) continue;
    return { profileId: profile.id, modelId: model.id };
  }
  for (const profile of profiles) {
    const model = profile.models.find((m) => m.kind === 'chat');
    if (model !== undefined) return { profileId: profile.id, modelId: model.id };
  }
  return null;
}

interface ChatViewProps {
  readonly active: boolean;
  readonly focusEnabled: boolean;
  readonly overview: Overview | null;
  readonly dataResetNonce: number;
  readonly onOpenMemory: (opts?: MemoryTarget) => void;
  readonly onOpenSettings: () => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onRefreshOverview: () => void;
  readonly onBootState: (state: ChatBootState) => void;
  readonly onReviewModeChange: (open: boolean) => void;
}

interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface SpeechEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { readonly error?: string }) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface Attachment {
  readonly name: string;
  readonly url: string;
}

interface ReviewTurn {
  readonly index: number;
  readonly user: MessageDto;
  readonly assistant: MessageDto | null;
  readonly verdict: VerdictDto | undefined;
  readonly state: 'done' | 'failed' | 'interrupted' | 'running';
}

interface ReviewResult {
  readonly turn: number;
  readonly summary: string;
  readonly criteria: number;
  readonly error?: string;
}

interface ReviewApiResponse {
  readonly ok?: boolean;
  readonly output?: {
    readonly summary?: string;
    readonly criteriaChecks?: readonly unknown[];
  };
  readonly turns?: readonly {
    readonly messageId: string;
    readonly summary: string;
    readonly criteria: number;
  }[];
  readonly error?: string;
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

/**
 * 已完成消息的用量：优先用 verdict（含监督/反思的完整一轮用量）；
 * 旧结论没有完整数据时退回持久化的工具循环用量。
 */
function usageOfMessage(
  message: {
    readonly agentTrace?: {
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
    } | null;
  },
  verdict: VerdictDto | undefined,
): LiveUsage | null {
  const turn = verdict?.usage ?? message.agentTrace?.usage;
  if (turn === undefined || (turn.inputTokens === 0 && turn.outputTokens === 0)) return null;
  const session = verdict?.sessionUsage ?? turn;
  return {
    turnInputTokens: turn.inputTokens,
    turnOutputTokens: turn.outputTokens,
    sessionInputTokens: session.inputTokens,
    sessionOutputTokens: session.outputTokens,
  };
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
  dataResetNonce,
  onOpenMemory,
  onOpenSettings,
  notify,
  onRefreshOverview,
  onBootState,
  onReviewModeChange,
}: ChatViewProps): JSX.Element {
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly MessageDto[]>([]);
  const [cancellations, setCancellations] = useState<readonly SessionCancellationDto[]>([]);
  const [localCancel, setLocalCancel] = useState<SessionCancellationDto | null>(null);
  const [verdicts, setVerdicts] = useState<readonly VerdictDto[]>([]);
  const [quizzes, setQuizzes] = useState<readonly QuizItem[]>([]);
  const [liveTurns, setLiveTurns] = useState<readonly LiveTurn[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [modelCatalog, setModelCatalog] = useState<readonly PickableProfile[]>([]);
  const [lastChatModel, setLastChatModel] = useState<ModelChoice | null>(null);
  const [chatModel, setChatModel] = useState<ModelChoice | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [approvals, setApprovals] = useState<readonly ApprovalQueueItem[]>([]);
  const [answering, setAnswering] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewRange, setReviewRange] = useState<{ readonly start: number; readonly end: number } | null>(null);
  const [reviewAnchor, setReviewAnchor] = useState<number | null>(null);
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false);
  const [reviewModelOpen, setReviewModelOpen] = useState(false);
  const [reviewModel, setReviewModel] = useState<ModelChoice | null>(null);
  const [reviewRatio, setReviewRatio] = useState(0.5);
  const [navTurn, setNavTurn] = useState<number | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewResults, setReviewResults] = useState<readonly ReviewResult[]>([]);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const reviewRatioRestoredRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastChatModelRef = useRef<ModelChoice | null>(null);
  const modelCatalogRef = useRef<readonly PickableProfile[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceBaseRef = useRef('');
  const reviewAbortRef = useRef<AbortController | null>(null);
  const atBottomRef = useRef(true);
  const forceScrollRef = useRef(true);
  const bootRef = useRef(false);
  const loadSeqRef = useRef(0);

  const now = useNow(30_000);
  const mounted = useMounted();
  const hasContent = messages.length > 0 || liveTurns.length > 0;
  const reviewTurns = useMemo(() => buildReviewTurns(messages, verdicts), [messages, verdicts]);
  const reviewableTurns = reviewTurns.filter((t) => t.state === 'done' && t.assistant !== null);
  const lastReviewable = reviewableTurns[reviewableTurns.length - 1] ?? null;
  const reviewRangeText =
    reviewRange === null
      ? '选择轮次'
      : reviewRange.start === reviewRange.end
        ? `第 ${reviewRange.start + 1} 轮`
        : `第 ${reviewRange.start + 1}–${reviewRange.end + 1} 轮`;

  useEffect(() => {
    let alive = true;
    void fetchJson<ModelCatalogResponse>('/api/model')
      .then((res) => {
        if (!alive) return;
        setModelCatalog(res.profiles);
        const last = res.lastChat ?? fallbackModelChoice(res.profiles);
        setLastChatModel(last);
        setChatModel((previous) => previous ?? last);
        setReviewModel((previous) => previous ?? res.lastReview ?? last);
      })
      .catch(() => {
        // 模型列表读不到时，发送仍会由后端给出明确错误。
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!modelPickerOpen) return;
    let alive = true;
    void fetchJson<ModelCatalogResponse>('/api/model')
      .then((res) => {
        if (!alive) return;
        setModelCatalog(res.profiles);
        const last = res.lastChat ?? fallbackModelChoice(res.profiles);
        setLastChatModel(last);
        setChatModel((previous) => previous ?? last);
        setReviewModel((previous) => previous ?? res.lastReview ?? last);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [modelPickerOpen]);

  useEffect(() => {
    lastChatModelRef.current = lastChatModel;
  }, [lastChatModel]);

  useEffect(() => {
    modelCatalogRef.current = modelCatalog;
  }, [modelCatalog]);

  const availableChatModels = useMemo(
    () =>
      modelCatalog.some((profile) =>
        profile.models.some(
          (model) => model.kind === 'chat' && (!(profile.requiresKey ?? true) || profile.hasKey),
        ),
      ),
    [modelCatalog],
  );
  const canChat = availableChatModels || overview === null || overview.model !== null;

  const currentSession = sessions.find((s) => s.id === sessionId);
  const historySessions = useMemo(
    () => sessions.filter((s) => s.messageCount > 0),
    [sessions],
  );
  const isDraftSession = currentSession !== undefined && currentSession.messageCount === 0;

  useEffect(() => {
    if (isDraftSession) writeDraftText(input);
  }, [input, isDraftSession]);

  useEffect(() => {
    if (!mounted) return;
    try {
      const saved = Number(window.localStorage.getItem('butler.review.split'));
      if (Number.isFinite(saved) && saved >= 0.35 && saved <= 0.65) setReviewRatio(saved);
    } catch {
      // localStorage 不可用时保持默认 50/50。
    } finally {
      reviewRatioRestoredRef.current = true;
    }
  }, [mounted]);

  useEffect(() => {
    if (!reviewRatioRestoredRef.current) return;
    try {
      window.localStorage.setItem('butler.review.split', String(reviewRatio));
    } catch {
      // ignore
    }
  }, [reviewRatio]);

  useEffect(() => {
    onReviewModeChange(reviewOpen);
  }, [onReviewModeChange, reviewOpen]);

  function jumpToTurn(index: number): void {
    const turn = reviewTurns[index];
    if (turn === undefined) return;
    stopReview();
    setNavTurn(index);
    setReviewOpen(false);
    window.setTimeout(() => {
      document
        .getElementById(`msg-${turn.user.id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 40);
  }

  function selectReviewTurn(index: number, shift: boolean): void {
    const turn = reviewTurns[index];
    if (turn === undefined || turn.state !== 'done' || turn.assistant === null) return;
    stopReview();
    setReviewResults([]);
    setReviewError(null);
    setReviewModelOpen(false);
    const extend = (shift || (reviewRange !== null && reviewRange.start === reviewRange.end)) && reviewAnchor !== null;
    if (extend) {
      setReviewRange({ start: Math.min(reviewAnchor, index), end: Math.max(reviewAnchor, index) });
    } else {
      setReviewAnchor(index);
      setReviewRange({ start: index, end: index });
    }
  }

  async function startReview(range: { readonly start: number; readonly end: number }): Promise<void> {
    if (sessionId === null) return;
    const targets = reviewTurns.filter(
      (t) => t.index >= range.start && t.index <= range.end && t.state === 'done' && t.assistant !== null,
    );
    if (targets.length === 0) {
      notify('选中的轮次里没有可审查的完成轮次', 'warning');
      return;
    }

    reviewAbortRef.current?.abort();
    const controller = new AbortController();
    reviewAbortRef.current = controller;
    setReviewRange(range);
    setReviewOpen(true);
    setReviewBusy(true);
    setReviewResults([]);
    setReviewError(null);
    setReviewAnchor(range.start);
    setReviewPickerOpen(false);
    setReviewModelOpen(false);

    try {
      const res = await postJson<ReviewApiResponse>(
        '/api/reviews',
        {
          sessionId,
          messageIds: targets.map((t) => t.assistant?.id).filter((id): id is string => id !== undefined),
          ...(reviewModel !== null
            ? { modelProfileId: reviewModel.profileId, modelId: reviewModel.modelId }
            : {}),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const fallbackSummary = res.output?.summary?.trim() ?? '';
      const results: ReviewResult[] =
        res.turns !== undefined && res.turns.length > 0
          ? res.turns.map((t, i) => ({
              turn: targets[i]?.index !== undefined ? targets[i]!.index + 1 : i + 1,
              summary: t.summary,
              criteria: t.criteria,
            }))
          : [
              {
                turn: (targets[0]?.index ?? 0) + 1,
                summary: fallbackSummary,
                criteria: res.output?.criteriaChecks?.length ?? 0,
              },
            ];
      setReviewResults(results);
    } catch (err) {
      if (controller.signal.aborted) {
        setReviewError('已停止审查');
      } else {
        setReviewError(errorMessage(err));
      }
    } finally {
      if (reviewAbortRef.current === controller) reviewAbortRef.current = null;
      setReviewBusy(false);
    }
  }

  function stopReview(): void {
    if (reviewAbortRef.current === null) return;
    reviewAbortRef.current.abort();
    reviewAbortRef.current = null;
    setReviewBusy(false);
    setReviewError('已停止审查');
  }

  function clampReviewRatio(value: number): number {
    return Math.min(0.65, Math.max(0.35, value));
  }

  function resizeReviewTo(value: number): void {
    setReviewRatio(clampReviewRatio(value));
  }

  function handleReviewSplitterPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const body = chatBodyRef.current;
    if (body === null) return;
    event.preventDefault();
    const width = body.getBoundingClientRect().width;
    if (width <= 0) return;
    const startX = event.clientX;
    const startRatio = reviewRatio;
    const onMove = (moveEvent: PointerEvent): void => {
      resizeReviewTo(startRatio + (startX - moveEvent.clientX) / width);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function handleReviewSplitterKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    resizeReviewTo(reviewRatio + (event.key === 'ArrowLeft' ? 0.02 : -0.02));
  }

  function openReview(): void {
    if (lastReviewable === null) {
      notify('还没有可审查的已完成轮次', 'warning');
      return;
    }
    const target = reviewRange ?? { start: lastReviewable.index, end: lastReviewable.index };
    stopReview();
    setReviewRange(target);
    setReviewAnchor(null);
    setReviewResults([]);
    setReviewError(null);
    setReviewPickerOpen(false);
    setReviewModelOpen(false);
    setReviewOpen(true);
  }

  function closeReview(): void {
    stopReview();
    setReviewPickerOpen(false);
    setReviewModelOpen(false);
    setReviewOpen(false);
  }

  function toggleReview(): void {
    if (reviewOpen) closeReview();
    else openReview();
  }

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
    setCancellations([]);
    setLocalCancel(null);
    setVerdicts([]);
    setQuizzes([]);
    setSessionId(id);
    setApprovals([]);
    setReviewOpen(false);
    setReviewRange(null);
    setReviewAnchor(null);
    setReviewPickerOpen(false);
    setReviewModelOpen(false);
    setNavTurn(null);
    reviewAbortRef.current?.abort();
    reviewAbortRef.current = null;
    setReviewResults([]);
    setReviewError(null);
    forceScrollRef.current = true;

    try {
      const res = await fetchJson<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}`);
      if (token !== loadSeqRef.current) return { ok: false, error: null };
      setMessages(res.messages);
      setCancellations(res.cancellations ?? []);
      setVerdicts(res.verdicts);
      setQuizzes(res.quizzes);
      if (res.session.modelProfileId !== undefined && res.session.modelId !== undefined) {
        setChatModel({ profileId: res.session.modelProfileId, modelId: res.session.modelId });
      } else {
        setChatModel(
          lastChatModelRef.current ?? fallbackModelChoice(modelCatalogRef.current),
        );
      }
      setInput(res.messages.length === 0 ? readDraftText() : '');
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

  const refreshCancellations = useCallback(async (id: string): Promise<void> => {
    try {
      const res = await fetchJson<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}`);
      setCancellations(res.cancellations ?? []);
    } catch {
      // 取消回执是旁路：读不到不覆盖主对话状态
    }
  }, []);

  const createNewChat = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setApprovals([]);
    try {
      const res = await postJson<SessionCreateResponse>('/api/sessions', {});
      setSessions((prev) => [res.session, ...prev.filter((s) => s.id !== res.session.id)]);
      setSessionId(res.session.id);
      setChatModel(lastChatModel ?? fallbackModelChoice(modelCatalog));
      setModelPickerOpen(false);
      setMessages([]);
      setInput(readDraftText());
      setCancellations([]);
      setLocalCancel(null);
      setVerdicts([]);
      setQuizzes([]);
      setLiveTurns([]);
      setSessionError(null);
      setHistoryOpen(false);
      setAttachments([]);
      setReviewOpen(false);
      setReviewRange(null);
      setReviewAnchor(null);
      setReviewPickerOpen(false);
      setReviewModelOpen(false);
      setNavTurn(null);
      reviewAbortRef.current?.abort();
      reviewAbortRef.current = null;
      setReviewResults([]);
      setReviewError(null);
      forceScrollRef.current = true;
      window.setTimeout(() => textareaRef.current?.focus(), 140);
    } catch (err) {
      notify(errorMessage(err), 'danger');
    }
  }, [lastChatModel, modelCatalog, notify]);

  const selectChatModel = useCallback(async (choice: ModelChoice): Promise<void> => {
    const previous = chatModel;
    const previousLast = lastChatModel;
    setChatModel(choice);
    setLastChatModel(choice);
    setModelPickerOpen(false);
    if (sessionId === null) return;
    try {
      await postJson('/api/model', {
        action: 'select-chat',
        sessionId,
        profileId: choice.profileId,
        modelId: choice.modelId,
      });
    } catch (err) {
      setChatModel(previous);
      setLastChatModel(previousLast);
      notify(errorMessage(err), 'danger');
    }
  }, [chatModel, lastChatModel, notify, sessionId]);

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
        const first = res.sessions.find((s) => s.messageCount > 0) ?? res.sessions[0];
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
        const first = res.sessions.find((s) => s.messageCount > 0) ?? res.sessions[0];
        if (first !== undefined) {
          await loadSession(first.id);
        } else {
          setSessionId(null);
          setMessages([]);
          setCancellations([]);
          setLocalCancel(null);
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
    setVoiceSupported(speechRecognitionCtor() !== null);
    setTtsSupported(typeof window !== 'undefined' && 'speechSynthesis' in window);
    return () => {
      recognitionRef.current?.abort();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function ensureSession(): Promise<string | null> {
    if (sessionId !== null) return sessionId;
    try {
      const res = await postJson<SessionCreateResponse>('/api/sessions', {});
      setSessions((prev) => [res.session, ...prev.filter((s) => s.id !== res.session.id)]);
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
    const sendingDraft = isDraftSession || sessionId === null;
    forceScrollRef.current = true;
    atBottomRef.current = true;
    if (sendingDraft) clearDraftText();
    setInput('');
    setAttachments([]);

    const id = await ensureSession();
    if (id === null) return;

    recognitionRef.current?.stop();
    setListening(false);
    setLiveTurns((prev) => [
      ...prev,
      {
        userText: text,
        images: outgoing,
        assistant: emptyAssistant(),
      },
    ]);
    setLocalCancel(null);
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
          ...(chatModel !== null ? { modelProfileId: chatModel.profileId, modelId: chatModel.modelId } : {}),
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

  function toggleVoice(): void {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (Ctor === null) {
      notify('当前浏览器不支持语音输入；可以用文字继续。', 'warning');
      return;
    }
    const recognition = new Ctor();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;
    voiceBaseRef.current = input.trim().length > 0 ? `${input.trim()} ` : '';
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const item = event.results[i];
        if (item === undefined) continue;
        if (item.isFinal) finalText += item[0].transcript;
        else interimText += item[0].transcript;
      }
      setInput(`${voiceBaseRef.current}${finalText}${interimText}`);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = (event) => {
      setListening(false);
      notify(
        event.error === 'not-allowed'
          ? '麦克风权限被拒绝；可以在浏览器设置里允许后重试。'
          : '语音输入没有成功，请重试或改用文字。',
        'warning',
      );
    };
    recognitionRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      setListening(false);
      notify('语音输入启动失败，请重试。', 'warning');
    }
  }

  function speak(text: string, id: string): void {
    if (!('speechSynthesis' in window)) {
      notify('当前浏览器不支持语音朗读。', 'warning');
      return;
    }
    if (speakingId === id) {
      window.speechSynthesis.cancel();
      setSpeakingId(null);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 4_000));
    utterance.lang = 'zh-CN';
    utterance.rate = 1;
    utterance.onend = () => setSpeakingId(null);
    utterance.onerror = () => {
      setSpeakingId(null);
      notify('语音朗读失败，请重试。', 'warning');
    };
    setSpeakingId(id);
    window.speechSynthesis.speak(utterance);
  }

  function stop(): void {
    const id = sessionId;
    const live = liveTurns[liveTurns.length - 1]?.assistant;
    const toolCalls =
      live?.rounds.reduce((n, r) => n + r.tools.length, 0) ?? 0;
    const toolResults =
      live?.rounds.reduce(
        (n, r) => n + r.tools.filter((t) => t.status !== 'pending' && t.status !== 'running').length,
        0,
      ) ?? 0;
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setLiveTurns((prev) => patchLast(prev, (a) => ({ ...a, status: 'aborted' })));
    setLocalCancel({
      id: `local_cancel_${Date.now()}`,
      reason: 'user_cancelled',
      phase: live?.stages[live.stages.length - 1] ?? '执行阶段',
      fromSeq: live?.auditRange?.fromSeq ?? 0,
      toSeq: live?.auditRange?.toSeq ?? 0,
      toolCalls,
      toolResults,
      createdAt: Date.now(),
    });
    notify('已停止。后台任务已取消，这次取消会写入事件记录。', 'default');
    if (id !== null) {
      window.setTimeout(() => void refreshCancellations(id), 700);
    }
  }

  async function addFiles(files: readonly File[]): Promise<void> {
    const images = files.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    const docs = files.filter((f) => !/^image\//.test(f.type));

    if (images.length > 0 && attachments.length + images.length > MAX_IMAGES) {
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

    for (const file of docs) {
      if (file.size > 20 * 1024 * 1024) {
        notify(`「${file.name}」超过 20 MiB，已跳过`, 'warning');
        continue;
      }
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await fetch('/api/attachments/extract', { method: 'POST', body: form });
        const body = (await res.json().catch(() => ({}))) as {
          readonly text?: string;
          readonly error?: string;
        };
        if (!res.ok || typeof body.text !== 'string') {
          notify(body.error ?? `「${file.name}」解析失败`, 'warning');
          continue;
        }
        const text = body.text.slice(0, 20_000);
        setInput((prev) =>
          `${prev}${prev.trim().length > 0 ? '\n\n' : ''}【文档：${file.name}】\n${text}\n`,
        );
        notify(`已读取「${file.name}」，内容已放进输入框，可编辑后发送。`, 'success');
      } catch (err) {
        notify(`「${file.name}」解析失败：${errorMessage(err)}`, 'warning');
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
  const lastMessage = messages[messages.length - 1];
  const latestCancellation = cancellations[cancellations.length - 1];
  const displayCancellation =
    localCancel ??
    (latestCancellation !== undefined &&
    (lastMessage === undefined || lastMessage.createdAt <= latestCancellation.createdAt)
      ? latestCancellation
      : null);
  const retryText =
    [...messages].reverse().find((m) => m.role === 'user')?.text ??
    liveTurns[liveTurns.length - 1]?.userText ??
    '';
  const announcement = streaming
    ? '正在生成回复'
    : lastLive === undefined
      ? ''
      : lastLive.status === 'error'
        ? '回复失败'
        : lastLive.status === 'aborted'
          ? '已取消，后台任务已停止'
          : lastLive.status === 'done'
            ? '回复完成'
            : '';

  return (
    <div className={`chat-view ${active ? 'is-active' : ''} ${reviewOpen ? 'is-review' : ''}`}>
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
          <button
            type="button"
            className={`btn btn-ghost btn-sm${reviewOpen ? ' is-review-toggle' : ''}`}
            disabled={!reviewOpen && lastReviewable === null}
            onClick={toggleReview}
            aria-pressed={reviewOpen}
            title={reviewOpen ? '关闭审查' : lastReviewable === null ? '还没有可审查的完成轮次' : '打开审查'}
          >
            <Icon name="eye" size={15} /> 审查
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setHistoryOpen(true); void refreshSessions(); }}>
            <Icon name="history" size={15} /> 记录
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void createNewChat()}>
            <Icon name="plus" size={15} /> 新对话
          </button>
        </div>
      </header>

      <div
        className="chat-body"
        ref={chatBodyRef}
        style={
          reviewOpen
            ? { gridTemplateColumns: `${1 - reviewRatio}fr 1px ${reviewRatio}fr` }
            : undefined
        }
      >
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
                      {overview?.memory.pending} 条试行记忆
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
                onOpenMemory={onOpenMemory}
                notify={notify}
                now={now}
                canSpeak={ttsSupported}
                speaking={speakingId === m.id}
                onSpeak={() => speak(m.text, m.id)}
              />
            ))}

            {liveTurns.map((turn, i) => (
              <LiveTurnView
                key={`live-${i}`}
                turn={turn}
                onOpenMemory={onOpenMemory}
                onRetry={(text) => {
                  setInput(text);
                  window.setTimeout(() => textareaRef.current?.focus(), 60);
                }}
                onCopy={(text) => void copyText(text)}
              />
            ))}

            {displayCancellation !== null && (
              <CancellationCard
                cancellation={displayCancellation}
                retryText={retryText}
                onRetry={() => {
                  setInput(retryText);
                  window.setTimeout(() => textareaRef.current?.focus(), 60);
                }}
                now={now}
              />
            )}

            {quizzes.length > 0 && sessionId !== null && (
              <QuizInvite sessionId={sessionId} quizzes={quizzes} notify={notify} />
            )}
          </div>
        </div>
      </div>

      {reviewOpen && (
        <>
          <div
            className="review-splitter"
            role="separator"
            aria-label="调整主对话与审查宽度"
            aria-orientation="vertical"
            aria-valuemin={35}
            aria-valuemax={65}
            aria-valuenow={Math.round(reviewRatio * 100)}
            tabIndex={0}
            onPointerDown={handleReviewSplitterPointerDown}
            onKeyDown={handleReviewSplitterKeyDown}
          />
          <section className="review-pane" aria-label="审查">
            {reviewBusy || reviewResults.length > 0 || reviewError !== null ? (
              <div className="review-report review-report--simple">
                <div className="review-report-head">
                  <div>
                    <p className="review-overline">本次审查</p>
                    <h3>{reviewBusy ? '正在审查' : '审查结果'}</h3>
                  </div>
                  <span className={`review-status${reviewBusy ? ' is-busy' : reviewError !== null ? ' is-warn' : ''}`}>
                    {reviewBusy ? '审查中' : reviewError !== null ? '未完成' : '已完成'}
                  </span>
                </div>
                {reviewBusy ? (
                  <p className="review-placeholder">正在读取快照并核对判据…</p>
                ) : (
                  reviewResults.map((r) => (
                    <div className="review-result" key={r.turn}>
                      <div className="review-result-head">
                        第 {r.turn} 轮 <span>{r.criteria} 条判据</span>
                      </div>
                      {r.error !== undefined ? (
                        <p className="review-error">{r.error}</p>
                      ) : r.summary.length > 0 ? (
                        <Markdown text={r.summary} />
                      ) : (
                        <p className="review-empty">监督员没有返回可展示的结论。</p>
                      )}
                    </div>
                  ))
                )}
                {reviewError !== null && <p className="review-error">{reviewError}</p>}
                <div className="review-foot">
                  <button
                    type="button"
                    className="review-back"
                    onClick={() => {
                      stopReview();
                      setReviewResults([]);
                      setReviewError(null);
                    }}
                  >
                    重新选择
                  </button>
                  {reviewBusy && (
                    <button type="button" className="review-stop" onClick={stopReview}>
                      停止
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="review-min">
                <div className="review-min-hero">
                  <h2>想要审查些什么</h2>
                  <div className="review-composer">
                    <button
                      type="button"
                      className="review-composer-control"
                      aria-expanded={reviewPickerOpen}
                      aria-haspopup="dialog"
                      onClick={() => {
                        setReviewModelOpen(false);
                        setReviewPickerOpen((open) => !open);
                      }}
                    >
                      {reviewRangeText} <span>▾</span>
                    </button>
                    <span className="review-composer-spacer" />
                    <div className="review-model-wrap">
                      <ModelPicker
                        profiles={modelCatalog}
                        value={reviewModel}
                        onSelect={(choice) => {
                          setReviewModel(choice);
                          setReviewModelOpen(false);
                        }}
                        open={reviewModelOpen}
                        onOpenChange={(open) => {
                          setReviewPickerOpen(false);
                          setReviewModelOpen(open);
                        }}
                        disabled={reviewBusy}
                        label="选择审查模型"
                        note="默认沿用最近一次审查使用的模型；只影响本次审查。"
                      />
                    </div>
                    <button
                      type="button"
                      className="review-start"
                      disabled={reviewRange === null || reviewModel === null}
                      onClick={() => {
                        if (reviewRange !== null) void startReview(reviewRange);
                      }}
                    >
                      开始审查
                    </button>
                  </div>
                </div>

                {reviewPickerOpen && (
                  <div className="review-picker" role="dialog" aria-label="选择审查轮次">
                    <div className="review-pop-head">
                      选择审查轮次 <span>仅终态</span>
                    </div>
                    <p className="review-picker-hint">点击起点，再点终点；Shift + 点击选择连续范围</p>
                    <div className="review-picker-list">
                      {reviewTurns.map((t) => {
                        const selectable = t.state === 'done' && t.assistant !== null;
                        const inRange =
                          reviewRange !== null && t.index >= reviewRange.start && t.index <= reviewRange.end;
                        const isStart = reviewRange !== null && t.index === reviewRange.start;
                        const isEnd = reviewRange !== null && t.index === reviewRange.end;
                        return (
                          <button
                            key={t.user.id}
                            type="button"
                            className={`review-picker-row${inRange ? ' is-selected' : ''}${!selectable ? ' is-disabled' : ''}`}
                            disabled={!selectable}
                            onClick={(e) => selectReviewTurn(t.index, e.shiftKey)}
                          >
                            <span className="review-picker-num">{String(t.index + 1).padStart(2, '0')}</span>
                            <span className="review-picker-copy">
                              <strong>{truncate(t.user.text, 34)}</strong>
                              <small>
                                第 {t.index + 1} 轮 ·{' '}
                                {t.state === 'done' ? '完成' : t.state === 'interrupted' ? '中断' : t.state === 'failed' ? '失败' : '运行中'}
                              </small>
                            </span>
                            {isStart && <span className="review-picker-mark">起点</span>}
                            {isEnd && reviewRange !== null && reviewRange.start !== reviewRange.end && (
                              <span className="review-picker-mark">终点</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <div className="review-picker-foot">
                      <span>已选 <b>{reviewRangeText}</b></span>
                      <button type="button" className="review-apply" onClick={() => setReviewPickerOpen(false)}>
                        应用
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}

      <aside className="turn-rail" aria-label="轮次导航">
        <div className="turn-dots">
          {reviewTurns.map((t) => (
            <button
              key={t.user.id}
              type="button"
              className={`turn-dot is-${t.state}${navTurn === t.index ? ' is-current' : ''}`}
              title={`跳转到第 ${t.index + 1} 轮 · ${
                t.state === 'done'
                  ? '已完成'
                  : t.state === 'failed'
                    ? '失败'
                    : t.state === 'interrupted'
                      ? '中断'
                      : '运行中'
              }`}
              aria-label={`跳转到第 ${t.index + 1} 轮`}
              onClick={() => jumpToTurn(t.index)}
            />
          ))}
          {liveTurns.length > 0 && (
            <span className="turn-dot is-running" title="运行中" aria-hidden="true" />
          )}
        </div>
      </aside>
      </div>

      <div className="chat-composer-wrap">
        <div className="chat-column">
          {overview !== null && overview.model === null && !availableChatModels && (
            <div className="chat-banner">
              <span className="chat-banner-icon">
                <Icon name="info" size={16} />
              </span>
              <span>
                还没有可用的对话模型。去设置 → 模型接入添加配置并选择模型；
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
                  accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.docx,.xlsx,.xlsm,.csv,.txt,.md,.json"
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
                  title="添加图片或文档（图片仅本轮可见；文档会放入输入框）"
                  aria-label="添加图片或文档"
                >
                  <Icon name="paperclip" size={18} />
                </button>
                <button
                  type="button"
                  className={`icon-btn voice-btn ${listening ? 'is-listening' : ''}`}
                  onClick={toggleVoice}
                  disabled={!voiceSupported}
                  title={
                    voiceSupported
                      ? listening
                        ? '停止语音输入'
                        : '用语音输入（浏览器需要麦克风权限）'
                      : '当前浏览器不支持语音输入'
                  }
                  aria-label={listening ? '停止语音输入' : '语音输入'}
                  aria-pressed={listening}
                >
                  <Icon name="mic" size={17} />
                </button>
                <span className="composer-hint">
                  {listening
                    ? '正在听… 再点麦克风结束'
                    : attachments.length > 0
                      ? `${attachments.length} 张 · 仅本轮可见`
                      : '图片仅本轮可见 · 文档会放入输入框'}
                </span>
              </div>

              <ModelPicker
                profiles={modelCatalog}
                value={chatModel}
                onSelect={(choice) => void selectChatModel(choice)}
                open={modelPickerOpen}
                onOpenChange={setModelPickerOpen}
                disabled={streaming || !canChat}
              />

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
          {streaming && (
            <p className="composer-note">
              <span className="composer-live">
                <span className="typing-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {statusLabel(liveTurns[liveTurns.length - 1]?.assistant ?? emptyAssistant()) || '正在处理'}
              </span>
            </p>
          )}
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
            <span className="sheet-foot-note">共 {formatNumber(historySessions.length)} 段对话</span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void createNewChat()}>
              <Icon name="plus" size={15} /> 新建对话
            </button>
          </div>
        }
      >
        <div className="session-list">
          {historySessions.length === 0 && (
            <EmptyState compact icon="history" title="还没有对话" description="第一次开口之后，这里会出现历史。" />
          )}
          {historySessions.map((s) => (
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

function CancellationCard({
  cancellation,
  retryText,
  onRetry,
  now,
}: {
  readonly cancellation: SessionCancellationDto;
  readonly retryText: string;
  readonly onRetry: () => void;
  readonly now: number;
}): JSX.Element {
  const phase =
    cancellation.phase === 'execute'
      ? '执行阶段'
      : cancellation.phase === 'understand'
        ? '理解目标'
        : cancellation.phase === 'reflect'
          ? '整理经验'
          : cancellation.phase;
  return (
    <section className="cancel-card" role="status" aria-label="本轮已取消">
      <div className="cancel-head">
        <div className="cancel-title">
          <Badge tone="warn">已取消</Badge>
          <strong>本轮已停止</strong>
          <span>用户取消</span>
        </div>
        <span className="cancel-time mono">
          {formatClock(cancellation.createdAt)} · {relativeTime(cancellation.createdAt, now)}
        </span>
      </div>
      <div className="cancel-grid">
        <div>
          <span className="cancel-label">停在</span>
          <strong>{phase}</strong>
          <small className="mono">phase={cancellation.phase}</small>
        </div>
        <div>
          <span className="cancel-label">工具调用</span>
          <strong>{cancellation.toolCalls}</strong>
          <small>{cancellation.toolResults} 个已返回</small>
        </div>
        <div>
          <span className="cancel-label">事件范围</span>
          <strong className="mono">
            {cancellation.fromSeq > 0 ? `${cancellation.fromSeq}–${cancellation.toSeq}` : '—'}
          </strong>
          <small>seq</small>
        </div>
      </div>
      <p className="cancel-note">
        后台任务已停止，本轮产生的敏感授权已撤销；没有生成最终答复。
      </p>
      <div className="cancel-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onRetry}
          disabled={retryText.trim().length === 0}
        >
          重新开始
        </button>
      </div>
    </section>
  );
}

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

function buildReviewTurns(
  messages: readonly MessageDto[],
  verdicts: readonly VerdictDto[],
): readonly ReviewTurn[] {
  const turns: ReviewTurn[] = [];
  let pendingUser: MessageDto | null = null;
  let pendingAssistant: MessageDto | null = null;

  const flush = (): void => {
    if (pendingUser === null) return;
    const assistant = pendingAssistant;
    const state: ReviewTurn['state'] =
      assistant === null
        ? 'running'
        : assistant.status === 'done'
          ? 'done'
          : assistant.status === 'failed'
            ? 'failed'
            : 'interrupted';
    turns.push({
      index: turns.length,
      user: pendingUser,
      assistant,
      verdict: verdicts.find((v) => v.forMessageId === pendingUser?.id),
      state,
    });
    pendingUser = null;
    pendingAssistant = null;
  };

  for (const m of messages) {
    if (m.role === 'user') {
      flush();
      pendingUser = m;
    } else if (m.role === 'butler' && pendingUser !== null && pendingAssistant === null) {
      pendingAssistant = m;
      flush();
    }
  }
  flush();
  return turns;
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
  onOpenMemory,
  notify,
  now,
  canSpeak,
  speaking,
  onSpeak,
}: {
  readonly message: MessageDto;
  readonly verdict: VerdictDto | undefined;
  readonly onOpenMemory: (opts?: MemoryTarget) => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly now: number;
  readonly canSpeak: boolean;
  readonly speaking: boolean;
  readonly onSpeak: () => void;
}): JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="msg msg--user" id={`msg-${message.id}`}>
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
    <article className="msg msg--butler" id={`msg-${message.id}`}>
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
        usage={usageOfMessage(message, verdict)}
      />

      <div className="msg-body">
        <Markdown text={message.text} />
      </div>

      {verdict !== undefined && <VerdictCard verdict={verdict} />}

      {message.servantReports !== null && <ReportsPanel reports={message.servantReports} />}
      {message.memoryRefs.length > 0 && <MemoryRefs refs={message.memoryRefs} />}

      <footer className="msg-foot">
        <button type="button" className="text-btn" onClick={() => void copyToClipboard(message.text, notify)}>
          <Icon name="copy" size={13} /> 复制
        </button>
        {canSpeak && (
          <button type="button" className="text-btn" onClick={onSpeak}>
            <Icon name="volume" size={13} /> {speaking ? '停止朗读' : '朗读'}
          </button>
        )}
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
  onOpenMemory,
  onRetry,
  onCopy,
}: {
  readonly turn: LiveTurn;
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
          usage={a.usage}
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

        {a.verdict !== null && <VerdictCard verdict={a.verdict} />}

        {a.reflection !== null && (
          <ReflectionCard reflection={a.reflection} onOpenMemory={() => onOpenMemory({ pending: true })} />
        )}

        {a.auditRange !== null && (
          <EvidenceStrip range={a.auditRange} audit={a.audit} />
        )}

        {a.reports.length > 0 && <ReportsPanel reports={a.reports} />}

        {!streaming && a.text.length > 0 && (
          <footer className="msg-foot">
            <button type="button" className="text-btn" onClick={() => onCopy(a.text)}>
              <Icon name="copy" size={13} /> 复制
            </button>
            <button type="button" className="text-btn" onClick={() => onOpenMemory()}>
              <Icon name="memory" size={13} /> 看记忆
            </button>
          </footer>
        )}
      </article>
    </>
  );
}
