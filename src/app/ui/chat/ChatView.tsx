'use client';

/**
 * 对话空间 —— 产品的主界面
 *
 * 设计要点（每一处都对应一个能力）：
 *   · 流式叙述：等待执行时先说思路，不让用户盯着转圈
 *   · 过程面板：思考 → 工具 → 再思考，全部可展开
 *   · 契约与过程：干前写了什么、用了哪些工具、产出了什么
 *   · 反思回执：这一轮记录了什么试行记忆
 *   · 依据条：召回 / 注入 / 拦截与 seq 范围，直接留在这一轮下面
 *
 * ⚠️ 对话在切换空间时**不卸载**（由父层保持挂载）：
 *   切去看一眼记忆不该把正在跑的任务掐掉。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { Badge, Collapse, InlineError, Skeleton } from '../components/Common';
import { useAutoResize, useMounted, useNow } from '../lib/hooks.js';
import { ApiError, errorMessage, fetchJson, patchJson, postJson } from '../lib/api.js';
import {
  formatClock,
  formatDateFull,
  formatDateTime,
  formatNumber,
  greeting,
  plainText,
  relativeTime,
  truncate,
} from '../lib/format.js';
import { applyEvent, asSseEvent, emptyAssistant } from '../lib/chatLive.js';
import type { ChatBootState } from '../lib/boot.js';
import { useSessionIndex } from '../lib/sessionIndex.js';
import type {
  AgentTrace,
  AuditResponse,
  LiveAssistant,
  LiveSteeringMessage,
  LiveTurn,
  LiveUsage,
  MessageDto,
  Overview,
  QuizItem,
  ReasoningLevel,
  SessionCreateResponse,
  SessionDetailResponse,
  SessionCancellationDto,
  SessionSettingsPatch,
  SessionSettingsPatchResponse,
  SessionSummary,
  SessionTitleResponse,
  SseEvent,
  SteerResponse,
  ToastMessage,
  VerdictDto,
  MemoryTarget,
} from '../lib/types.js';
import { type ModelChoice, type PickableProfile } from './ModelPicker';
import {
  parsePetFocusPayload,
  petFocusOriginChanged,
  withSessionParam,
  type PendingPetFocus,
  type PetFocusTarget,
} from './petFocus.js';
import { SessionControls } from './SessionControls';
import { SessionSettingsSheet } from './SessionSettingsSheet';
import { ApprovalCard } from './ApprovalCard';
import {
  approvalFromEvent,
  currentApproval,
  enqueueApproval,
  removeApproval,
  type ApprovalItem,
} from './approvalQueue.js';
import {
  addPendingSteering,
  approvalSteerBody,
  confirmSteering,
  isNoActiveTurnError,
  recoverFromSteerFailure,
  removePendingSteering,
  runningSteerBody,
  steeringStatusLabel,
} from './steer.js';
import {
  DEFAULT_REASONING,
  modelRefOf,
  sanitizeSessionSummary,
  settingsOf,
} from './sessionSettings.js';
import { ProcessPanel, type ProcRound } from './Process';
import { ReviewProcess } from './ReviewProcess';
import {
  applyReviewEvent,
  emptyReviewProcess,
  latestReviewText,
  processFromTraces,
  readReviewSse,
  type ReviewFinding,
  type ReviewFindingSeverity,
  type ReviewHistoryResponse,
  type ReviewProcessState,
  type ReviewRunDto,
  type ReviewRunReportDto,
  type ReviewRunStatus,
  type ReviewStreamEvent,
  type ReviewTrace,
  type ReviewUsage,
  type ReviewVerdict,
} from './reviewLive.js';
import {
  AssumptionNotice,
  ContractCard,
  EvidenceStrip,
  MemoryRefs,
  ReflectionCard,
  ReportsPanel,
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
  readonly state: 'done' | 'failed' | 'interrupted' | 'running';
}

/** 面板里当前展示的一次审查（实时完成 / 历史恢复共用）。 */
interface ReviewResult {
  readonly id: string | null;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly unverified: readonly string[];
  readonly markdown: string;
  readonly legacy: boolean;
  readonly traces: readonly ReviewTrace[];
  readonly rounds: number | null;
  readonly usage: ReviewUsage | null;
  readonly turnIds: readonly string[];
  readonly status: ReviewRunStatus;
  readonly model: string | null;
  readonly createdAt: number | null;
}

interface ReviewScopeMapping {
  /** 人话范围；没有可映射轮次时为空字符串。 */
  readonly label: string;
  /** 只有所有 turnIds 都能映射且连续时才给出可再次审查的范围。 */
  readonly range: { readonly start: number; readonly end: number } | null;
}

/**
 * turnIds → 当前会话轮次号。
 *
 * ★ turnIds 是 assistant message id；当前消息列表里找不到的轮次绝不能猜，
 *   否则历史面板会伪造出一个不存在的范围。
 */
function mapReviewScope(
  turnIds: readonly string[],
  indexByMessageId: ReadonlyMap<string, number>,
): ReviewScopeMapping {
  const indices: number[] = [];
  let missing = 0;
  for (const id of turnIds) {
    const index = indexByMessageId.get(id);
    if (index === undefined) {
      missing += 1;
    } else if (!indices.includes(index)) {
      indices.push(index);
    }
  }
  indices.sort((a, b) => a - b);

  if (indices.length === 0) {
    return {
      label: turnIds.length > 0 ? `${turnIds.length} 个轮次（当前会话不可定位）` : '',
      range: null,
    };
  }

  const nums = indices.map((index) => index + 1);
  const contiguous = indices.every((value, i) => i === 0 || value === (indices[i - 1] ?? -1) + 1);
  const label =
    contiguous && indices.length > 1
      ? `第 ${nums[0]}–${nums[nums.length - 1]} 轮`
      : `第 ${nums.join('、')} 轮`;
  const exactRange =
    missing === 0 && contiguous
      ? { start: indices[0] ?? 0, end: indices[indices.length - 1] ?? 0 }
      : null;
  return {
    label:
      missing > 0
        ? `${label} · ${missing} 个轮次不在当前会话`
        : label,
    range: exactRange,
  };
}

function normalizeReviewUsage(value: unknown): ReviewUsage | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  const input = rec['inputTokens'];
  const output = rec['outputTokens'];
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { inputTokens: input, outputTokens: output };
}

function reviewRunStatus(run: ReviewRunDto): ReviewRunStatus {
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'aborted') {
    return run.status;
  }
  return 'running';
}

function reviewRunSummary(run: ReviewRunDto): string {
  const summary = typeof run.report?.summary === 'string' ? plainText(run.report.summary) : '';
  if (summary.length > 0) return summary;
  if (reviewRunStatus(run) === 'failed') {
    return typeof run.error === 'string' && run.error.trim().length > 0
      ? plainText(run.error)
      : '审查失败';
  }
  if (reviewRunStatus(run) === 'aborted') return '审查已停止';
  if (reviewRunStatus(run) === 'running') return '审查尚未结束';
  return '没有文字结论';
}

function reviewStatusLabel(status: ReviewRunStatus): string {
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'aborted') return '已停止';
  return '进行中';
}

const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  pass: '通过',
  fail: '不通过',
  unknown: '未判定',
};

function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return value === 'pass' || value === 'fail' || value === 'unknown';
}

function isReviewSeverity(value: unknown): value is ReviewFindingSeverity {
  return value === 'block' || value === 'warn' || value === 'info';
}

function reviewVerdictOf(report: ReviewRunReportDto | null | undefined): ReviewVerdict {
  return isReviewVerdict(report?.verdict) ? report.verdict : 'unknown';
}

/**
 * 只接受可以完整展示的 finding；旧记录缺 severity/evidence 时如实过滤，
 * 不补造问题，也不把空白模板当结论。
 */
function reviewFindingsOf(
  report: ReviewRunReportDto | null | undefined,
): readonly ReviewFinding[] {
  if (!Array.isArray(report?.findings)) return [];
  const findings: ReviewFinding[] = [];
  for (const raw of report.findings) {
    if (typeof raw !== 'object' || raw === null) continue;
    const rec = raw as unknown as Record<string, unknown>;
    const severity = rec['severity'];
    if (!isReviewSeverity(severity)) continue;
    const problem = typeof rec['problem'] === 'string' ? rec['problem'].trim() : '';
    const message = typeof rec['message'] === 'string' ? rec['message'].trim() : '';
    const suggestion = typeof rec['suggestion'] === 'string' ? rec['suggestion'].trim() : '';
    const evidence = Array.isArray(rec['evidence'])
      ? rec['evidence'].filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0,
        )
      : [];
    if (problem.length === 0 && message.length === 0) continue;
    findings.push({
      severity,
      ...(problem.length > 0 ? { problem } : {}),
      ...(message.length > 0 ? { message } : {}),
      evidence,
      ...(suggestion.length > 0 ? { suggestion } : {}),
    });
  }
  return findings;
}

function reviewUnverifiedOf(report: ReviewRunReportDto | null | undefined): readonly string[] {
  if (!Array.isArray(report?.unverified)) return [];
  return report.unverified
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function reviewSummaryOf(report: ReviewRunReportDto | null | undefined): string {
  return typeof report?.summary === 'string' ? report.summary.trim() : '';
}

/** 完整报告正文：report.markdown 优先，其次 completed.finalText，最后旧 summary。 */
function reviewMarkdownOf(
  report: ReviewRunReportDto | null | undefined,
  finalText = '',
): string {
  const markdown = typeof report?.markdown === 'string' ? report.markdown.trim() : '';
  if (markdown.length > 0) return markdown;
  const body = finalText.trim();
  if (body.length > 0) return body;
  return reviewSummaryOf(report);
}

const SUGGESTIONS: readonly { readonly icon: 'memory' | 'calendar' | 'growth'; readonly text: string }[] = [
  { icon: 'memory', text: '看看冰箱里还有什么，能做什么' },
  { icon: 'calendar', text: '帮我安排明天，避开效率最低的时段' },
  { icon: 'growth', text: '复盘这周，我有哪些反复出现的问题' },
];

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** 桌宠聚焦请求的一次性 TTL 很短（约 15s），2s 轮询能在过期前取走。 */
const PET_FOCUS_POLL_MS = 2_000;

/**
 * 判定“已经贴底”的剩余距离。
 *
 * ★ 原来给 180px：长回答只要上滚不到 180px 就被当成还在底部，
 *   下一批增量立刻把人拽回末尾，实际上根本没法回看。
 *   只留 32px 容错（约一两行），几乎贴底才继续跟随。
 */
const BOTTOM_THRESHOLD_PX = 32;

/**
 * 草稿写盘的合并窗口。
 *
 * ★ 中文输入法会把一句话拆成很多次 input；每次按键都同步写 localStorage
 *   会让候选窗卡顿。300ms 足够合并连续输入，又不会丢太多内容。
 */
const DRAFT_WRITE_DEBOUNCE_MS = 300;

/**
 * 「回到最新」浮标：只补定位与浮起，尺寸/字体沿用 btn btn-ghost btn-sm。
 * 用内联样式而不是改 CSS 文件，避免为一个小按钮扩大改动面。
 */
const JUMP_LATEST_STYLE: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 18,
  zIndex: 3,
  transform: 'translateX(-50%)',
  background: 'var(--surface)',
  borderColor: 'var(--line-strong)',
  boxShadow: 'var(--shadow-md)',
};

/**
 * Markdown 的渲染成本主要在 react-markdown 每次 render 都重新 parse。
 *
 * ★ `components/Markdown` **自身已经用 memo 包裹**（见该文件顶部说明），
 *   这里不再重复包一层：双重 memo 不会更快，只是多一层比较。
 *   保留别名，是因为调用处读起来仍然要表达"这是被 memo 的 Markdown"。
 */
const MemoizedMarkdown = Markdown;

/**
 * 把 ?session=<id> 写回地址栏，保留 hash（#/chat）。
 *
 * ★ 用 replaceState 而不是 location.assign/open：同一个标签页、不新增历史、
 *   不触发页面重载。更新地址失败也不影响已经加载好的会话。
 */
function replaceSessionParam(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const next = withSessionParam(window.location.href, sessionId);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next === current) return;
    window.history.replaceState(window.history.state, '', next);
  } catch {
    // 地址栏只是展示投影：写不进去不影响会话本身。
  }
}

function patchLast(turns: readonly LiveTurn[], fn: (a: LiveAssistant) => LiveAssistant): LiveTurn[] {
  if (turns.length === 0) return [...turns];
  const index = turns.length - 1;
  const current = turns[index];
  if (current === undefined) return [...turns];
  const next = [...turns];
  next[index] = { ...current, assistant: fn(current.assistant) };
  return next;
}

/** 只改最后一轮的 steering 消息列表；没有变化时返回原引用，避免重复渲染。 */
function withLastSteering(
  turns: readonly LiveTurn[],
  fn: (messages: readonly LiveSteeringMessage[]) => readonly LiveSteeringMessage[],
): readonly LiveTurn[] {
  if (turns.length === 0) return turns;
  const index = turns.length - 1;
  const current = turns[index];
  if (current === undefined) return turns;
  const steering = fn(current.steering);
  if (steering === current.steering) return turns;
  const next = [...turns];
  next[index] = { ...current, steering };
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
  /**
   * 会话列表 / 当前会话来自共享索引（侧栏与这里同一份真相）。
   * 这里不再自己维护一份 sessions，避免两侧各自刷新后漂移。
   */
  const {
    sessions,
    currentId: sessionId,
    setCurrentId,
    refresh: refreshSessionIndex,
    applySummary,
    patchTitle,
    registerHandlers,
  } = useSessionIndex();
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
  const [modelCatalogLoading, setModelCatalogLoading] = useState(true);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [activeReasoning, setActiveReasoning] = useState<ReasoningLevel>(DEFAULT_REASONING);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsTargetId, setSettingsTargetId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  /**
   * 是否贴底。ref 给滚动逻辑用（不触发渲染），state 只给「回到最新」浮标用；
   * onScroll 只在跨过阈值时更新它，避免每个 scroll 事件都重渲染整棵对话树。
   */
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalItem[]>([]);
  const [answering, setAnswering] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewRange, setReviewRange] = useState<{ readonly start: number; readonly end: number } | null>(null);
  const [reviewAnchor, setReviewAnchor] = useState<number | null>(null);
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false);
  /** 时间轴上当前点中的轮次：只负责高亮和下方预览，不改变范围语义。 */
  const [reviewFocus, setReviewFocus] = useState<number | null>(null);
  const [reviewRatio, setReviewRatio] = useState(0.5);
  const [navTurn, setNavTurn] = useState<number | null>(null);
  /** 用户是否手动滚动过轮次轨道；上翻后不抢滚动。 */
  const railTouchedRef = useRef(false);
  /** 点击某轮时请求下一次自动滚入可见区。 */
  const railScrollRequestRef = useRef(false);
  /** 自定义窄滚动条的几何信息；原生滚动条隐藏，避免 44px 轨道抖动。 */
  const [railThumb, setRailThumb] = useState<{
    readonly track: number;
    readonly height: number;
    readonly top: number;
  } | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewRun, setReviewRun] = useState<ReviewResult | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewStopped, setReviewStopped] = useState(false);
  /** 实时审查过程；completed 后保留，历史 run 由 traces 重建工具部分。 */
  const [reviewProcess, setReviewProcess] = useState<ReviewProcessState>(emptyReviewProcess);
  const [reviewHistory, setReviewHistory] = useState<readonly ReviewRunDto[]>([]);
  const [reviewHistoryLoading, setReviewHistoryLoading] = useState(false);
  const [reviewHistoryError, setReviewHistoryError] = useState<string | null>(null);
  const [reviewHistoryOpen, setReviewHistoryOpen] = useState(false);
  /** 当前展示的历史 run id；实时审查完成后也用它高亮列表。 */
  const [reviewActiveId, setReviewActiveId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const turnDotsRef = useRef<HTMLDivElement | null>(null);
  const reviewTimelineRef = useRef<HTMLDivElement | null>(null);
  const reviewRatioRestoredRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastChatModelRef = useRef<ModelChoice | null>(null);
  const modelCatalogRef = useRef<readonly PickableProfile[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const settingsSavingRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceBaseRef = useRef('');
  const reviewAbortRef = useRef<AbortController | null>(null);
  /** 重新打开面板时，是否等历史加载完再恢复最近一条 completed。 */
  const reviewAutoRestoreRef = useRef(false);
  /** 防止旧会话的历史请求覆盖新会话列表。 */
  const reviewHistorySeqRef = useRef(0);
  /** 抽屉开关按钮 / 抽屉关闭按钮：用于打开时送入焦点、关闭后还回焦点。 */
  const reviewHistoryToggleRef = useRef<HTMLButtonElement | null>(null);
  const reviewHistoryCloseRef = useRef<HTMLButtonElement | null>(null);
  const atBottomRef = useRef(true);
  /**
   * 只在用户主动发送 / 打开会话时置 true：流式增量不能把正在回看的用户拽回底部。
   * 消费它的 effect 会立刻复位，所以它表达的是“这一次变更必须贴底”。
   */
  const forceScrollRef = useRef(true);
  /** 草稿防抖定时器（window.setTimeout 的 id）；null 表示没有在等。 */
  const draftTimerRef = useRef<number | null>(null);
  /** 还没落盘的草稿；null 表示没有待写内容（空串仍要写，用来清掉旧草稿）。 */
  const pendingDraftRef = useRef<string | null>(null);
  /**
   * 最新一轮的令牌。
   *
   * ★ 不能拿 abortRef 当判据：stop() 会先把 abortRef 置空，等旧流的 finally
   *   跑到时已经对不上，用户主动停止的那一轮反而没人清理。独立令牌才能把
   *   “旧轮收尾”和“新一轮状态”分开。
   */
  const turnTokenRef = useRef<object | null>(null);
  /**
   * 建会话 + 发首条消息期间的重复提交闸门。
   *
   * ★ 清空输入现在发生在 await 之后：这段时间输入框里还有字，用户连按 Enter
   *   会创建两个会话、发出两条消息。旧顺序靠“先清空”顺带挡住了这个问题。
   */
  const sendPendingRef = useRef(false);
  const bootRef = useRef(false);
  const loadSeqRef = useRef(0);
  const sessionsRef = useRef<readonly SessionSummary[]>([]);
  /** 标题懒生成：每个会话在本次页面生命周期里最多请求一次，失败不重试。 */
  const titleAttemptRef = useRef<Set<string>>(new Set());
  const streamingRef = useRef(false);
  /**
   * steer 收到 409 后暂存文字：等本轮 SSE 收尾，再用普通 /api/chat 发出去。
   * 不直接重发，避免旧流还没结束时把 streaming 状态和 abortRef 弄乱。
   */
  /** 分隔条拖动的收尾函数（卸载时必须调用，见 handleReviewSplitterPointerDown）。 */
  const splitterCleanupRef = useRef<(() => void) | null>(null);

  const resumingAfterTurnRef = useRef<{ readonly sessionId: string; readonly text: string } | null>(
    null,
  );
  const bootDoneRef = useRef(false);
  const pendingPetFocusRef = useRef<PendingPetFocus | null>(null);
  const petFocusSeqRef = useRef(0);
  const petFocusDrainingRef = useRef(false);

  const now = useNow(30_000);
  const mounted = useMounted();
  const hasContent = messages.length > 0 || liveTurns.length > 0;
  const reviewTurns = useMemo(() => buildReviewTurns(messages), [messages]);
  /**
   * 当前轮：默认是最后一轮；点击某轮后固定到该轮。
   * 状态不再用颜色区分，轨道只需要知道“哪一颗是当前”。
   */
  const currentTurnIndex =
    navTurn !== null && navTurn < reviewTurns.length
      ? navTurn
      : reviewTurns.length > 0
        ? reviewTurns.length - 1
        : null;

  /**
   * 自定义滚动条：只用 4px 覆盖在轨道右侧，不占内容宽度、不撑开 44px。
   * 原生滚动条隐藏（否则 Chromium 的 scrollbar-width 会吃掉 15px）。
   */
  const syncRailScrollbar = useCallback((): void => {
    const el = turnDotsRef.current;
    if (el === null) {
      setRailThumb(null);
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) {
      setRailThumb(null);
      return;
    }
    const height = Math.max(30, Math.round((clientHeight / scrollHeight) * clientHeight));
    const maxTop = Math.max(0, clientHeight - height);
    const top = Math.round(
      (scrollTop / Math.max(1, scrollHeight - clientHeight)) * maxTop,
    );
    setRailThumb((prev) =>
      prev !== null && prev.track === clientHeight && prev.height === height && prev.top === top
        ? prev
        : { track: clientHeight, height, top },
    );
  }, []);
  const reviewableTurns = reviewTurns.filter(isReviewableTurn);
  const lastReviewable = reviewableTurns[reviewableTurns.length - 1] ?? null;
  const reviewRangeText =
    reviewRange === null
      ? '选择轮次'
      : reviewRange.start === reviewRange.end
        ? `第 ${reviewRange.start + 1} 轮`
        : `第 ${reviewRange.start + 1}–${reviewRange.end + 1} 轮`;
  /** 范围里含中断轮时只给一句轻量说明：中断轮只审查已生成部分。 */
  const reviewRangeHasInterrupted =
    reviewRange !== null &&
    reviewTurns.some(
      (t) =>
        t.index >= reviewRange.start &&
        t.index <= reviewRange.end &&
        t.state === 'interrupted',
    );
  /** 当前点中的轮次只用于高亮/预览；不可审查时回退到首个可选轮次做 Tab 落点。 */
  const reviewFocusTurn = reviewFocus === null ? null : (reviewTurns[reviewFocus] ?? null);
  const reviewPreviewTurn =
    reviewFocusTurn !== null && isReviewableTurn(reviewFocusTurn) ? reviewFocusTurn : null;
  const reviewTabStop = reviewPreviewTurn?.index ?? reviewableTurns[0]?.index ?? null;

  /** assistant message id → 当前会话轮次号；历史 run 的范围只从这里来。 */
  const reviewTurnIndexById = useMemo(() => {
    const indexById = new Map<string, number>();
    for (const turn of reviewTurns) {
      if (turn.assistant !== null) indexById.set(turn.assistant.id, turn.index);
    }
    return indexById;
  }, [reviewTurns]);

  const reviewStreamText = latestReviewText(reviewProcess);
  const reviewViewKind =
    reviewBusy
      ? 'running'
      : reviewRun !== null
        ? reviewRun.status === 'completed'
          ? 'completed'
          : reviewRun.status === 'aborted'
            ? 'stopped'
            : 'failed'
        : reviewStopped
          ? 'stopped'
          : reviewError !== null
            ? 'failed'
            : 'idle';
  const reviewResultScope =
    reviewRun !== null
      ? mapReviewScope(reviewRun.turnIds, reviewTurnIndexById).label || reviewRangeText
      : reviewRangeText;
  const reviewStatusText =
    reviewViewKind === 'running'
      ? '审查中'
      : reviewViewKind === 'completed'
        ? '已完成'
        : reviewViewKind === 'failed'
          ? '未完成'
          : reviewViewKind === 'stopped'
            ? '已停止'
            : '待开始';
  const reviewStatusClass =
    reviewViewKind === 'running'
      ? ' is-busy'
      : reviewViewKind === 'failed' || reviewViewKind === 'stopped'
        ? ' is-warn'
        : reviewViewKind === 'completed'
          ? ''
          : ' is-idle';

  /**
   * streaming 同时写进 ref。
   *
   * ★ 轮询与排空桌宠聚焦用的是稳定闭包：不能等 React 下一次渲染才知道
   *   当前是否在流式执行，否则可能在流式中途把页面切走。
   */
  const updateStreaming = useCallback((value: boolean): void => {
    streamingRef.current = value;
    setStreaming(value);
  }, []);

  const loadModelCatalog = useCallback(async (): Promise<void> => {
    setModelCatalogLoading(true);
    setModelCatalogError(null);
    try {
      const res = await fetchJson<ModelCatalogResponse>('/api/model');
      setModelCatalog(res.profiles);
      const last = res.lastChat ?? fallbackModelChoice(res.profiles);
      setLastChatModel(last);
      setChatModel((previous) => previous ?? last);
    } catch (err) {
      setModelCatalogError(errorMessage(err));
    } finally {
      setModelCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModelCatalog();
  }, [loadModelCatalog]);

  const loadReviewHistory = useCallback(async (id: string): Promise<void> => {
    const seq = ++reviewHistorySeqRef.current;
    setReviewHistoryLoading(true);
    setReviewHistoryError(null);
    try {
      const res = await fetchJson<ReviewHistoryResponse>(
        `/api/reviews?sessionId=${encodeURIComponent(id)}`,
      );
      if (seq !== reviewHistorySeqRef.current) return;
      if (!Array.isArray(res.reviews)) throw new Error('审查历史格式不正确');
      const sorted = [...res.reviews].sort(
        (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
      );
      setReviewHistory(sorted);
    } catch (err) {
      if (seq !== reviewHistorySeqRef.current) return;
      setReviewHistoryError(errorMessage(err));
    } finally {
      if (seq === reviewHistorySeqRef.current) setReviewHistoryLoading(false);
    }
  }, []);

  // 切会话 / 首屏加载时取一次历史；打开审查面板时再刷新一次。
  useEffect(() => {
    if (sessionId === null) {
      reviewHistorySeqRef.current += 1;
      setReviewHistory([]);
      setReviewHistoryError(null);
      setReviewHistoryLoading(false);
      setReviewHistoryOpen(false);
      return;
    }
    void loadReviewHistory(sessionId);
  }, [loadReviewHistory, sessionId]);

  useEffect(() => {
    if (!reviewOpen || sessionId === null) return;
    void loadReviewHistory(sessionId);
  }, [loadReviewHistory, reviewOpen, sessionId]);

  /**
   * 历史抽屉打开时：焦点进入关闭按钮，Esc 关闭它并把焦点还给「历史」按钮。
   *
   * ★ 抽屉是非模态的（审查头部仍可点击），所以不做焦点陷阱，只处理进出两条路径。
   */
  useEffect(() => {
    if (!reviewHistoryOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setReviewHistoryOpen(false);
      reviewHistoryToggleRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    const frame = window.requestAnimationFrame(() => {
      reviewHistoryCloseRef.current?.focus();
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.cancelAnimationFrame(frame);
    };
  }, [reviewHistoryOpen]);

  // 关闭后重新打开：内存里没有结果时，恢复最近一条 completed。
  useEffect(() => {
    if (!reviewOpen || !reviewAutoRestoreRef.current) return;
    if (reviewHistoryLoading) return;
    reviewAutoRestoreRef.current = false;
    if (
      reviewRun !== null ||
      reviewBusy ||
      reviewStopped ||
      reviewError !== null ||
      reviewProcess.rounds.length > 0
    ) {
      return;
    }
    const latest = reviewHistory.find((run) => reviewRunStatus(run) === 'completed');
    if (latest !== undefined) restoreReviewHistory(latest);
  }, [
    reviewOpen,
    reviewHistoryLoading,
    reviewHistory,
    reviewRun,
    reviewBusy,
    reviewStopped,
    reviewError,
    reviewProcess,
  ]);

  useEffect(() => {
    lastChatModelRef.current = lastChatModel;
  }, [lastChatModel]);

  useEffect(() => {
    modelCatalogRef.current = modelCatalog;
  }, [modelCatalog]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

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
  const isDraftSession = currentSession !== undefined && currentSession.messageCount === 0;
  const settingsTarget = useMemo(
    () => sessions.find((s) => s.id === settingsTargetId) ?? null,
    [sessions, settingsTargetId],
  );

  /**
   * 把一次会话投影（列表或详情）同步到 composer 的设置。
   *
   * ★ 只读取 settings 里的档位/模型，**不读取人格正文**；
   *   人格正文只留在设置抽屉里。
   */
  const syncActiveSettings = useCallback((summary: SessionSummary): void => {
    setActiveReasoning(settingsOf(summary).reasoning);
    const modelRef = modelRefOf(summary);
    if (modelRef !== null) {
      setChatModel({ profileId: modelRef.profileId, modelId: modelRef.modelId });
    } else {
      setChatModel(lastChatModelRef.current ?? fallbackModelChoice(modelCatalogRef.current));
    }
  }, []);

  /**
   * 标题懒生成：打开旧会话 / 新会话第一轮结束后各异步调用一次。
   *
   * ★ 不再用 titleGenerated 判断是否请求：旧版本生成的 AI 标题可能缺少
   *   首条用户消息 hash，必须让后端按幂等规则迁移。只要会话有消息，
   *   每个会话在本次页面生命周期内最多请求一次。
   * ★ 用 ref 记录已请求过的会话：失败或 generated=false 时保留当前标题，
   *   绝不循环重试，也不在每次渲染时发请求。
   * ★ 成功后只补丁当前这一行（标题 + titleGenerated），不整表刷新。
   */
  const requestSessionTitle = useCallback(
    (id: string): void => {
      if (id.length === 0) return;
      if (titleAttemptRef.current.has(id)) return;
      const summary = sessionsRef.current.find((s) => s.id === id);
      // 列表还没同步到这一条时先不动：等列表更新后 effect 会再触发。
      if (summary === undefined || summary.messageCount === 0) return;
      titleAttemptRef.current.add(id);
      const previousTitle = summary.title;
      void postJson<SessionTitleResponse>(`/api/sessions/${encodeURIComponent(id)}/title`, {})
        .then((res) => {
          if (res.generated !== true) return;
          const title = typeof res.title === 'string' ? res.title.trim() : '';
          if (title.length === 0 || title === previousTitle) return;
          // 只在这一行仍是旧标题时补丁：请求期间用户手动重命名时不覆盖。
          patchTitle(id, title, previousTitle);
        })
        .catch(() => {
          // 失败保留当前标题；已加入 attempted 集合，不重试。
        });
    },
    [patchTitle],
  );

  // 打开任意有消息的会话后请求一次标题迁移/生成；loadingSession 期间不抢跑。
  useEffect(() => {
    if (sessionId === null || loadingSession) return;
    if (currentSession === undefined || currentSession.messageCount === 0) return;
    requestSessionTitle(sessionId);
  }, [currentSession, loadingSession, requestSessionTitle, sessionId]);

  /** 立刻把还没写盘的草稿落盘；beforeunload 与卸载各用一次。 */
  const flushDraft = useCallback((): void => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    const pending = pendingDraftRef.current;
    if (pending === null) return;
    pendingDraftRef.current = null;
    writeDraftText(pending);
  }, []);

  /**
   * 丢弃待写草稿并清空存储。
   *
   * ★ 发送成功后必须连定时器一起取消：否则 300ms 后旧草稿会被重新写回，
   *   下次打开空白会话又看见刚发出去的内容。
   */
  const discardDraft = useCallback((): void => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    pendingDraftRef.current = null;
    clearDraftText();
  }, []);

  /**
   * 草稿只在空白新会话里保存。
   *
   * ★ 300ms 合并写盘：中文输入法长句时，逐字符同步写 localStorage 会卡候选窗。
   */
  useEffect(() => {
    if (!isDraftSession) return;
    pendingDraftRef.current = input;
    if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      flushDraft();
    }, DRAFT_WRITE_DEBOUNCE_MS);
  }, [flushDraft, input, isDraftSession]);

  // 关页/刷新前把待写的那一份补上；卸载时同理，并清掉定时器避免悬空回调。
  useEffect(() => {
    const onBeforeUnload = (): void => flushDraft();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      // 定时器一清就没有第二次机会：先把还没写盘的那份落下去，再收尾。
      flushDraft();
    };
  }, [flushDraft]);

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
    // 只是收起审查去看对话，不销毁已有结果/过程；重新打开还能继续看。
    railTouchedRef.current = false;
    railScrollRequestRef.current = true;
    setNavTurn(index);
    setReviewOpen(false);
    window.setTimeout(() => {
      document
        .getElementById(`msg-${turn.user.id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 40);
  }

  // 当前轮变化时把它滚进轨道可见区；用户已经上翻轨道时不抢滚动。
  useEffect(() => {
    if (!active || currentTurnIndex === null) return;
    const container = turnDotsRef.current;
    if (container === null) return;
    const dot = container.querySelector<HTMLElement>('.turn-dot.is-current');
    if (dot === null) return;
    if (railTouchedRef.current && !railScrollRequestRef.current) return;
    railScrollRequestRef.current = false;
    const box = container.getBoundingClientRect();
    const target = dot.getBoundingClientRect();
    const pad = 8;
    if (target.top < box.top + pad) {
      container.scrollTop -= box.top + pad - target.top;
    } else if (target.bottom > box.bottom - pad) {
      container.scrollTop += target.bottom - (box.bottom - pad);
    }
    syncRailScrollbar();
  }, [active, currentTurnIndex, reviewTurns.length, syncRailScrollbar]);

  // 内容/视口尺寸变化时重算自定义滚动条；原生滚动消失也不会抖动轨道。
  useEffect(() => {
    if (!active) return;
    syncRailScrollbar();
    const container = turnDotsRef.current;
    let observer: ResizeObserver | null = null;
    if (container !== null && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => syncRailScrollbar());
      observer.observe(container);
    }
    window.addEventListener('resize', syncRailScrollbar);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', syncRailScrollbar);
    };
  }, [active, reviewTurns.length, syncRailScrollbar]);

  // 切会话时重置手动滚动标记，新会话默认贴到最新一轮。
  useEffect(() => {
    railTouchedRef.current = false;
    railScrollRequestRef.current = false;
  }, [sessionId]);

  // 打开选择器时把当前点滚到轨道中间：15+ 轮时不会总是停在 01 或屏幕外。
  useEffect(() => {
    if (!reviewPickerOpen) return;
    const frame = window.requestAnimationFrame(() => {
      if (reviewFocus !== null) scrollReviewDotIntoView(reviewFocus, true);
    });
    return () => window.cancelAnimationFrame(frame);
    // 只在打开瞬间定位一次；后续点击/键盘由各自逻辑滚入。
  }, [reviewPickerOpen]);

  /*
   * 横向时间轴：把纵向滚轮转成横向滚动（Shift/触控板原生 deltaX 同样处理），
   * 键盘仍可用 ←/→；到边界时放行，避免把审查面板锁住无法上下滚动。
   */
  useEffect(() => {
    if (!reviewPickerOpen) return;
    const el = reviewTimelineRef.current;
    if (el === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) return;
      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      const before = el.scrollLeft;
      el.scrollLeft += delta;
      if (el.scrollLeft !== before) event.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [reviewPickerOpen]);

  /**
   * 清空当前展示的审查（结果 / 过程 / 错误），并中止仍在进行的请求。
   *
   * ★ 历史列表不清空：它属于会话，不属于某一次展示。
   * ★ 关闭面板不走这里；关闭只收起，重新打开还能看到原结果或继续看进度。
   */
  function resetReview(): void {
    const controller = reviewAbortRef.current;
    reviewAbortRef.current = null;
    controller?.abort();
    reviewAutoRestoreRef.current = false;
    setReviewBusy(false);
    setReviewRun(null);
    setReviewError(null);
    setReviewStopped(false);
    setReviewProcess(emptyReviewProcess());
    setReviewActiveId(null);
    setReviewHistoryOpen(false);
  }

  /** 用一条持久化 run 恢复结论、traces、状态与可映射范围；不补造缺失字段。 */
  function restoreReviewHistory(run: ReviewRunDto): void {
    const status = reviewRunStatus(run);
    const id = typeof run.id === 'string' && run.id.length > 0 ? run.id : null;
    const report = run.report ?? null;
    const traces = Array.isArray(run.traces) ? run.traces : [];
    const usage = normalizeReviewUsage(run.usage);
    const turnIds = Array.isArray(run.turnIds)
      ? run.turnIds.filter((value): value is string => typeof value === 'string')
      : [];
    const model = typeof run.model === 'string' && run.model.length > 0 ? run.model : null;
    const mapping = mapReviewScope(turnIds, reviewTurnIndexById);

    setReviewRun({
      id,
      verdict: reviewVerdictOf(report),
      summary: reviewSummaryOf(report),
      findings: reviewFindingsOf(report),
      unverified: reviewUnverifiedOf(report),
      markdown: reviewMarkdownOf(report),
      legacy: report?.legacy === true,
      traces,
      rounds: null,
      usage,
      turnIds,
      status,
      model,
      createdAt: typeof run.createdAt === 'number' ? run.createdAt : null,
    });
    setReviewProcess({
      ...emptyReviewProcess(),
      rounds: processFromTraces(traces),
      usage,
      model,
    });
    setReviewActiveId(id);
    setReviewBusy(false);
    setReviewStopped(status === 'aborted');
    setReviewError(
      status === 'failed'
        ? typeof run.error === 'string' && run.error.trim().length > 0
          ? run.error
          : '这次审查失败'
        : status === 'running'
          ? '这次审查记录还没有完成'
          : null,
    );
    if (mapping.range !== null) {
      setReviewRange(mapping.range);
      setReviewAnchor(mapping.range.start);
      setReviewFocus(mapping.range.start);
    } else {
      // 有轮次映射不上或范围不连续时，不把历史范围硬套到当前选择器上。
      setReviewRange(null);
      setReviewAnchor(null);
      setReviewFocus(null);
    }
    setReviewPickerOpen(false);
    setReviewHistoryOpen(false);
    reviewAutoRestoreRef.current = false;
  }

  function selectReviewTurn(index: number, shift: boolean): void {
    const turn = reviewTurns[index];
    if (turn === undefined || !isReviewableTurn(turn)) return;
    const extend =
      (shift || (reviewRange !== null && reviewRange.start === reviewRange.end)) && reviewAnchor !== null;
    resetReview();
    setReviewFocus(index);
    if (extend) {
      setReviewRange({ start: Math.min(reviewAnchor, index), end: Math.max(reviewAnchor, index) });
    } else {
      setReviewAnchor(index);
      setReviewRange({ start: index, end: index });
    }
  }

  /** 打开/收起轮次选择器；打开时把高亮定位到已选范围起点。 */
  function toggleReviewPicker(): void {
    if (reviewPickerOpen) {
      setReviewPickerOpen(false);
      return;
    }
    setReviewFocus(reviewRange?.start ?? lastReviewable?.index ?? null);
    setReviewPickerOpen(true);
  }

  /** 把某个圆点滚进横向轨道；center=true 用于打开时居中。 */
  function scrollReviewDotIntoView(index: number, center: boolean): void {
    const container = reviewTimelineRef.current;
    if (container === null) return;
    const dot = container.querySelector<HTMLElement>(`[data-review-index="${index}"]`);
    if (dot === null) return;
    const box = container.getBoundingClientRect();
    const target = dot.getBoundingClientRect();
    if (center) {
      container.scrollLeft += target.left + target.width / 2 - (box.left + box.width / 2);
      return;
    }
    const pad = 18;
    if (target.left < box.left + pad) {
      container.scrollLeft -= box.left + pad - target.left;
    } else if (target.right > box.right - pad) {
      container.scrollLeft += target.right - (box.right - pad);
    }
  }

  /** 找相邻的可选轮次，跳过失败/运行中。 */
  function selectableReviewIndex(from: number, direction: 1 | -1): number | null {
    for (let i = from + direction; i >= 0 && i < reviewTurns.length; i += direction) {
      const turn = reviewTurns[i];
      if (turn !== undefined && isReviewableTurn(turn)) return i;
    }
    return null;
  }

  function handleReviewTimelineKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    const from = reviewTabStop ?? 0;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = selectableReviewIndex(from, -1);
    else if (event.key === 'ArrowRight') next = selectableReviewIndex(from, 1);
    else if (event.key === 'Home') next = reviewableTurns[0]?.index ?? null;
    else next = reviewableTurns[reviewableTurns.length - 1]?.index ?? null;
    if (next === null) return;
    event.preventDefault();
    setReviewFocus(next);
    reviewTimelineRef.current
      ?.querySelector<HTMLElement>(`[data-review-index="${next}"]`)
      ?.focus({ preventScroll: true });
    scrollReviewDotIntoView(next, false);
  }

  async function startReview(range: { readonly start: number; readonly end: number }): Promise<void> {
    if (sessionId === null) return;
    const targets = reviewTurns.filter(
      (t) => t.index >= range.start && t.index <= range.end && isReviewableTurn(t),
    );
    const messageIds = targets
      .map((t) => t.assistant?.id)
      .filter((id): id is string => id !== undefined);
    if (messageIds.length === 0) {
      notify('选中的轮次里没有可审查的完成或中断轮次', 'warning');
      return;
    }

    reviewAbortRef.current?.abort();
    const controller = new AbortController();
    reviewAbortRef.current = controller;
    reviewAutoRestoreRef.current = false;
    setReviewRange(range);
    setReviewOpen(true);
    setReviewBusy(true);
    setReviewRun(null);
    setReviewError(null);
    setReviewStopped(false);
    setReviewActiveId(null);
    setReviewProcess(emptyReviewProcess());
    setReviewAnchor(range.start);
    setReviewPickerOpen(false);
    setReviewHistoryOpen(false);

    /**
     * reasoning / text / tool_call 可能非常密；按 48ms 批处理，避免每个 token
     * 都触发整棵审查面板重渲染。completed / error 到达前先冲刷队列。
     */
    const queue: ReviewStreamEvent[] = [];
    let flushTimer: number | null = null;
    let sawTerminal = false;

    const flushQueue = (): void => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (queue.length === 0) return;
      const batch = queue.splice(0, queue.length);
      setReviewProcess((prev) => {
        let next = prev;
        for (const item of batch) next = applyReviewEvent(next, item);
        return next;
      });
    };

    const scheduleFlush = (): void => {
      if (flushTimer === null) flushTimer = window.setTimeout(flushQueue, 48);
    };

    const handle = (event: ReviewStreamEvent): void => {
      if (event.type === 'started') {
        flushQueue();
        setReviewProcess((prev) => applyReviewEvent(prev, event));
        return;
      }

      if (event.type === 'completed') {
        flushQueue();
        sawTerminal = true;
        const run = event.run;
        const report = run.report ?? null;
        const finalText = (
          event.finalText.length > 0
            ? event.finalText
            : typeof run.report?.summary === 'string'
              ? run.report.summary
              : ''
        ).trim();
        const traces = event.traces.length > 0 ? event.traces : (run.traces ?? []);
        const usage = event.usage ?? normalizeReviewUsage(run.usage);
        const status = reviewRunStatus(run);
        const id = typeof run.id === 'string' && run.id.length > 0 ? run.id : null;
        const turnIds = Array.isArray(run.turnIds)
          ? run.turnIds.filter((value): value is string => typeof value === 'string')
          : messageIds;
        const model = typeof run.model === 'string' && run.model.length > 0 ? run.model : null;
        setReviewRun({
          id,
          verdict: reviewVerdictOf(report),
          summary: reviewSummaryOf(report),
          findings: reviewFindingsOf(report),
          unverified: reviewUnverifiedOf(report),
          markdown: reviewMarkdownOf(report, finalText),
          legacy: report?.legacy === true,
          traces,
          rounds: Number.isFinite(event.rounds) ? event.rounds : null,
          usage,
          turnIds,
          status,
          model,
          createdAt: typeof run.createdAt === 'number' ? run.createdAt : Date.now(),
        });
        setReviewActiveId(id);
        setReviewStopped(status === 'aborted');
        setReviewError(
          status === 'failed'
            ? typeof run.error === 'string' && run.error.trim().length > 0
              ? run.error
              : '审查失败'
            : null,
        );
        setReviewProcess((prev) => {
          const rounds = prev.rounds.length > 0 ? prev.rounds : processFromTraces(traces);
          return {
            ...prev,
            rounds,
            usage: usage ?? prev.usage,
            finished: prev.finished ?? { rounds: event.rounds, reason: 'completed' },
            model: prev.model ?? model,
          };
        });
        void loadReviewHistory(sessionId);
        return;
      }

      if (event.type === 'error') {
        flushQueue();
        sawTerminal = true;
        if (event.aborted) {
          setReviewStopped(true);
          setReviewError(null);
        } else {
          setReviewStopped(false);
          setReviewError(event.error.trim().length > 0 ? event.error : '审查失败');
        }
        if (event.runId !== undefined) void loadReviewHistory(sessionId);
        return;
      }

      queue.push(event);
      scheduleFlush();
    };

    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ sessionId, messageIds }),
        signal: controller.signal,
      });

      // 预检失败仍是普通 JSON HTTP 400/404/503；先看 Content-Type 再决定怎么读。
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('text/event-stream')) {
        let payload: unknown = null;
        try {
          payload = (await res.json()) as unknown;
        } catch {
          payload = null;
        }
        const record =
          typeof payload === 'object' && payload !== null
            ? (payload as Record<string, unknown>)
            : null;
        const message =
          record !== null && typeof record['error'] === 'string' && record['error'].length > 0
            ? record['error']
            : `请求失败（HTTP ${res.status}）`;
        throw new ApiError(message, res.status, payload);
      }

      if (!res.ok) {
        throw new ApiError(`请求失败（HTTP ${res.status}）`, res.status, null);
      }

      await readReviewSse(res, handle);
      flushQueue();
      if (!sawTerminal && !controller.signal.aborted) {
        // 连接结束但没有 completed / error：只报未完成，不把半截正文当结论。
        setReviewError('审查连接已结束，但没有收到完成事件');
        setReviewStopped(false);
      }
    } catch (err) {
      flushQueue();
      if (sawTerminal) return;
      if (controller.signal.aborted) {
        if (reviewAbortRef.current === controller) {
          setReviewStopped(true);
          setReviewError(null);
        }
      } else if (reviewAbortRef.current === controller) {
        setReviewError(errorMessage(err));
        setReviewStopped(false);
        void loadReviewHistory(sessionId);
      }
    } finally {
      flushQueue();
      if (reviewAbortRef.current === controller) {
        reviewAbortRef.current = null;
        setReviewBusy(false);
      }
    }
  }

  function stopReview(): void {
    const controller = reviewAbortRef.current;
    if (controller === null) return;
    reviewAbortRef.current = null;
    controller.abort();
    setReviewBusy(false);
    setReviewStopped(true);
    setReviewError(null);
    // 不生成结论；已收到的过程（reasoning / 工具）保留给重新打开查看。
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
    /**
     * ★ 收尾必须覆盖三种情况：正常松手、指针被系统取消（Alt+Tab、
     *   触控笔离开范围）、以及组件在拖动中被卸载。
     *
     *   旧实现只监听 pointerup：拖动中切走窗口，监听器会一直留在 window 上，
     *   之后每次鼠标移动都会改审查面板宽度，直到刷新页面。
     *   这里用 pointercancel 兜住前者，用 cleanupRef 兜住卸载。
     */
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      splitterCleanupRef.current = null;
    };
    splitterCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  }

  function handleReviewSplitterKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    resizeReviewTo(reviewRatio + (event.key === 'ArrowLeft' ? 0.02 : -0.02));
  }

  function openReview(): void {
    const hasReviewView =
      reviewRun !== null ||
      reviewBusy ||
      reviewStopped ||
      reviewError !== null ||
      reviewProcess.rounds.length > 0;
    if (!hasReviewView) {
      if (lastReviewable === null && reviewHistory.length === 0) {
        notify('还没有可审查的完成或中断轮次', 'warning');
        return;
      }
      // 关闭再打开时优先显示内存里的结果；没有才从历史恢复最近一条 completed。
      reviewAutoRestoreRef.current = true;
      if (sessionId !== null) void loadReviewHistory(sessionId);
      const target =
        reviewRange ??
        (lastReviewable !== null
          ? { start: lastReviewable.index, end: lastReviewable.index }
          : null);
      if (target !== null) {
        setReviewRange(target);
        setReviewAnchor(null);
      }
    }
    setReviewPickerOpen(false);
    setReviewOpen(true);
  }

  function closeReview(): void {
    // ★ 只收起面板：不清结果/过程/历史，也不 abort 仍在跑的审查。
    reviewAutoRestoreRef.current = false;
    setReviewPickerOpen(false);
    setReviewHistoryOpen(false);
    setReviewOpen(false);
  }

  /** 收起历史抽屉，并把焦点还给入口按钮。 */
  function closeReviewHistory(): void {
    setReviewHistoryOpen(false);
    reviewHistoryToggleRef.current?.focus();
  }

  function toggleReview(): void {
    if (reviewOpen) closeReview();
    else openReview();
  }

  useAutoResize(textareaRef, input);

  const refreshSessions = useCallback(async (): Promise<readonly SessionSummary[] | null> => {
    const list = await refreshSessionIndex();
    // 刷新列表后让 composer 跟上当前会话（保存请求进行中时不覆盖乐观值）。
    const currentId = sessionIdRef.current;
    if (list !== null && currentId !== null && !settingsSavingRef.current) {
      const current = list.find((s) => s.id === currentId);
      if (current !== undefined) syncActiveSettings(current);
    }
    return list;
  }, [refreshSessionIndex, syncActiveSettings]);

  const loadSession = useCallback(async (id: string): Promise<{ readonly ok: boolean; readonly error: string | null }> => {
    const token = ++loadSeqRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    updateStreaming(false);
    setLoadingSession(true);
    setSessionError(null);
    setLiveTurns([]);
    setMessages([]);
    setCancellations([]);
    setLocalCancel(null);
    setVerdicts([]);
    setQuizzes([]);
    setCurrentId(id);
    sessionIdRef.current = id;
    setApprovals([]);
    setSettingsError(null);
    setSettingsTargetId(null);
    setReviewOpen(false);
    setReviewRange(null);
    setReviewAnchor(null);
    setReviewPickerOpen(false);
    setNavTurn(null);
    resetReview();
    // 历史属于会话：切走时立即作废旧列表，等新会话的 GET 回来再填。
    reviewHistorySeqRef.current += 1;
    setReviewHistory([]);
    setReviewHistoryError(null);
    setReviewHistoryLoading(false);
    setReviewHistoryOpen(false);
    reviewAutoRestoreRef.current = false;
    forceScrollRef.current = true;

    try {
      const res = await fetchJson<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}`);
      if (token !== loadSeqRef.current) return { ok: false, error: null };
      setMessages(res.messages);
      setCancellations(res.cancellations ?? []);
      setVerdicts(res.verdicts);
      setQuizzes(res.quizzes);
      // 详情接口带完整 settings；只取档位/模型，正文不进入列表或 composer。
      syncActiveSettings(res.session);
      // 读草稿前先落盘：防抖窗口里的最后几个字还没写进 localStorage。
      flushDraft();
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
  }, [flushDraft, syncActiveSettings, updateStreaming]);

  /**
   * 把“打开会话 / 打开会话设置”注册给侧栏。
   *
   * ★ 侧栏只发意图：切会话要清消息、载详情、重置审查状态，只有 ChatView 知道；
   *   注册句柄让两边共用同一套逻辑，而不是复制一份加载流程。
   */
  useEffect(() => {
    registerHandlers({
      openSession: (id) => {
        if (id === sessionIdRef.current) return;
        void loadSession(id);
      },
      openSettings: (id) => setSettingsTargetId(id),
    });
    return () => registerHandlers(null);
  }, [loadSession, registerHandlers]);

  /**
   * 桌宠“在完整对话中查看”的同页入口。
   *
   * 桌宠不再整页跳转，只发一个会话切换意图；这里复用 loadSession，
   * 因此不会刷新页面，也不会丢掉当前桌板状态。
   */
  useEffect(() => {
    const onOpenSession = (event: Event): void => {
      const detail = (event as CustomEvent<{ readonly sessionId?: unknown }>).detail;
      const id = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (id.length === 0 || id === sessionIdRef.current) return;
      void loadSession(id);
    };
    window.addEventListener('butler:open-session', onOpenSession);
    return () => window.removeEventListener('butler:open-session', onOpenSession);
  }, [loadSession]);

  /**
   * 应用一次桌宠聚焦请求（只在当前页跳转，不新开窗口）。
   *
   * 竞态保护分三层：
   *   1. seq：后到的桌宠请求会让更早的请求失效；
   *   2. originSessionId：收到请求后用户手动切过会话，旧请求不再覆盖；
   *   3. loadSession 自己的 loadSeqRef token：加载期间又被切走时，旧结果不会落盘。
   */
  const applyPetFocus = useCallback(
    async (pending: PendingPetFocus): Promise<void> => {
      const targetId = pending.sessionId;
      if (pending.seq !== petFocusSeqRef.current) return;
      if (petFocusOriginChanged(pending, sessionIdRef.current)) return;
      if (targetId === sessionIdRef.current) return;

      // 目标不在列表里：先刷新一次。刷新失败或仍不存在就放弃，绝不调用
      // loadSession —— 它会把当前页清空后再显示错误，等于破坏了用户正看的内容。
      if (!sessionsRef.current.some((s) => s.id === targetId)) {
        const latest = await refreshSessions();
        if (latest === null || !latest.some((s) => s.id === targetId)) return;
        if (pending.seq !== petFocusSeqRef.current) return;
        if (petFocusOriginChanged(pending, sessionIdRef.current)) return;
      }

      // 等待期间用户开了新一轮：把请求放回队列，等这一轮结束后再应用，
      // 不打断正在执行的轮次，也不静默丢掉。
      if (streamingRef.current) {
        if (pendingPetFocusRef.current === null && pending.seq === petFocusSeqRef.current) {
          pendingPetFocusRef.current = pending;
        }
        return;
      }

      // 预读一次详情。loadSession 会先把当前页清空再发请求；如果目标读不到，
      // 用户正在看的内容就变成错误页了。先确认可读，失败就保持现状。
      try {
        await fetchJson<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(targetId)}`);
      } catch {
        return;
      }
      if (pending.seq !== petFocusSeqRef.current) return;
      if (petFocusOriginChanged(pending, sessionIdRef.current)) return;
      if (streamingRef.current) {
        if (pendingPetFocusRef.current === null && pending.seq === petFocusSeqRef.current) {
          pendingPetFocusRef.current = pending;
        }
        return;
      }

      const outcome = await loadSession(targetId);
      if (!outcome.ok) return;
      if (pending.seq !== petFocusSeqRef.current) return;
      if (sessionIdRef.current !== targetId) return;
      replaceSessionParam(targetId);
    },
    [loadSession, refreshSessions],
  );

  /**
   * 排空待处理的聚焦请求。
   *
   * 串行执行：同一时刻只应用一个；流式执行中/首屏还没就绪就直接返回，
   * 由对应状态变化的 effect 再次调用，不静默丢弃。
   */
  const drainPetFocus = useCallback((): void => {
    if (petFocusDrainingRef.current) return;
    if (!bootDoneRef.current) return;
    petFocusDrainingRef.current = true;
    void (async () => {
      try {
        for (;;) {
          if (!bootDoneRef.current) break;
          if (streamingRef.current) break;
          const pending = pendingPetFocusRef.current;
          if (pending === null) break;
          pendingPetFocusRef.current = null;
          if (pending.seq !== petFocusSeqRef.current) continue;
          if (petFocusOriginChanged(pending, sessionIdRef.current)) continue;
          if (pending.sessionId === sessionIdRef.current) continue;
          try {
            await applyPetFocus(pending);
          } catch {
            // 单次聚焦失败不影响当前页面，也不让整个轮询循环卡死。
          }
        }
      } finally {
        petFocusDrainingRef.current = false;
      }
    })();
  }, [applyPetFocus]);

  /** 轮询拿到请求：当前会话直接忽略；流式中先排队，其余立即应用。 */
  const acceptPetFocus = useCallback(
    (focus: PetFocusTarget): void => {
      if (focus.sessionId === sessionIdRef.current) return;
      pendingPetFocusRef.current = {
        sessionId: focus.sessionId,
        seq: ++petFocusSeqRef.current,
        originSessionId: sessionIdRef.current,
        fromBeforeBoot: !bootDoneRef.current,
      };
      drainPetFocus();
    },
    [drainPetFocus],
  );

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
    updateStreaming(false);
    setApprovals([]);
    try {
      const res = await postJson<SessionCreateResponse>('/api/sessions', {});
      applySummary(res.session);
      setCurrentId(res.session.id);
      sessionIdRef.current = res.session.id;
      // 新对话默认 high / 记忆 on（由后端会话投影给出，不在前端另写一套）。
      syncActiveSettings(res.session);
      setSettingsError(null);
      setSettingsTargetId(null);
      setMessages([]);
      // 新建空白会话会把草稿带回 composer：先落盘，别读到防抖窗口里的旧值。
      flushDraft();
      setInput(readDraftText());
      setCancellations([]);
      setLocalCancel(null);
      setVerdicts([]);
      setQuizzes([]);
      setLiveTurns([]);
      setSessionError(null);
      setAttachments([]);
      setReviewOpen(false);
      setReviewRange(null);
      setReviewAnchor(null);
      setReviewPickerOpen(false);
      setNavTurn(null);
      resetReview();
      reviewHistorySeqRef.current += 1;
      setReviewHistory([]);
      setReviewHistoryError(null);
      setReviewHistoryLoading(false);
      setReviewHistoryOpen(false);
      reviewAutoRestoreRef.current = false;
      forceScrollRef.current = true;
      window.setTimeout(() => textareaRef.current?.focus(), 140);
    } catch (err) {
      notify(errorMessage(err), 'danger');
    }
  }, [applySummary, flushDraft, notify, setCurrentId, syncActiveSettings, updateStreaming]);

  const applyPatchedSession = useCallback(
    (detail: SessionSummary): void => {
      applySummary(sanitizeSessionSummary(detail));
    },
    [applySummary],
  );

  const handleSessionSaved = useCallback(
    (detail: SessionSummary): void => {
      applyPatchedSession(detail);
      if (sessionIdRef.current === detail.id) syncActiveSettings(detail);
    },
    [applyPatchedSession, syncActiveSettings],
  );

  /**
   * 会话设置的唯一写入路径。
   *
   * ★ 目标 session 在请求开始时固定：切换会话后返回的旧响应只更新列表，
   *   不会覆盖新会话的 composer 状态。
   * ★ run 中的 PATCH 只写会话；当前轮由后端 TurnSettings 快照保护。
   */
  async function patchCurrentSettings(
    patch: SessionSettingsPatch,
    optimistic: () => void,
    rollback: () => void,
    successModel?: ModelChoice,
  ): Promise<void> {
    if (settingsSavingRef.current) return;
    settingsSavingRef.current = true;
    setSettingsSaving(true);
    setSettingsError(null);
    optimistic();

    let targetId = sessionId;
    if (targetId === null) targetId = await ensureSession();
    if (targetId === null) {
      rollback();
      settingsSavingRef.current = false;
      setSettingsSaving(false);
      return;
    }

    try {
      const res = await patchJson<SessionSettingsPatchResponse>(
        `/api/sessions/${encodeURIComponent(targetId)}`,
        patch,
      );
      applyPatchedSession(res.session);
      if (sessionIdRef.current === targetId) {
        syncActiveSettings(res.session);
      }
      if (successModel !== undefined) {
        setLastChatModel(successModel);
        lastChatModelRef.current = successModel;
      }
      setSettingsError(null);
    } catch (err) {
      if (sessionIdRef.current === targetId) rollback();
      const message = errorMessage(err);
      setSettingsError(message);
      notify(message, 'danger');
    } finally {
      settingsSavingRef.current = false;
      setSettingsSaving(false);
    }
  }

  function selectChatModel(choice: ModelChoice): void {
    if (chatModel?.profileId === choice.profileId && chatModel.modelId === choice.modelId) return;
    const previous = chatModel;
    void patchCurrentSettings(
      { modelProfileId: choice.profileId, modelId: choice.modelId },
      () => setChatModel(choice),
      () => setChatModel(previous),
      choice,
    );
  }

  function selectReasoning(level: ReasoningLevel): void {
    if (level === activeReasoning) return;
    const previous = activeReasoning;
    void patchCurrentSettings(
      { reasoning: level },
      () => setActiveReasoning(level),
      () => setActiveReasoning(previous),
    );
  }

  // 首屏：取会话列表；有历史则打开最近一个
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    let cancelled = false;
    onBootState({ state: 'loading', phase: 'sessions' });

    void (async () => {
      try {
        const list = await refreshSessionIndex();
        if (cancelled) return;
        if (list === null) throw new Error('无法读取会话列表');
        // 桌宠点“打开当前对话”时带 ?session=<id>；直接落到那一条会话。
        const requested =
          typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search).get('session')
            : null;
        const requestedSession =
          requested !== null ? list.find((s) => s.id === requested) : undefined;
        // 默认不把桌宠会话当成普通对话打开；只有显式 ?session= 才进入它。
        const first =
          requestedSession ??
          list.find((s) => s.isPet !== true && s.messageCount > 0) ??
          list.find((s) => s.isPet !== true) ??
          list[0];
        if (first !== undefined) {
          onBootState({ state: 'loading', phase: 'session' });
          const outcome = await loadSession(first.id);
          if (cancelled) return;
          if (!outcome.ok) {
            onBootState({ state: 'error', error: outcome.error ?? '会话加载失败' });
            return;
          }
        }
        // 首屏会话落位之后才允许桌宠聚焦生效，否则会和首屏的 loadSession 抢同一个页面。
        bootDoneRef.current = true;
        onBootState({ state: 'ready' });
        drainPetFocus();
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
  }, [drainPetFocus, loadSession, onBootState, refreshSessionIndex]);

  // 数据被替换（导入备份）→ 旧会话 id 已失效，重新读取
  useEffect(() => {
    if (dataResetNonce === 0) return;
    void (async () => {
      abortRef.current?.abort();
      abortRef.current = null;
      updateStreaming(false);
      setLiveTurns([]);
      setApprovals([]);
      try {
        const list = await refreshSessionIndex();
        if (list === null) throw new Error('无法读取会话列表');
        const first = list.find((s) => s.messageCount > 0) ?? list[0];
        if (first !== undefined) {
          await loadSession(first.id);
        } else {
          setCurrentId(null);
          sessionIdRef.current = null;
          setMessages([]);
          setCancellations([]);
          setLocalCancel(null);
          setVerdicts([]);
          setQuizzes([]);
          setSessionError(null);
          setActiveReasoning(DEFAULT_REASONING);
          setChatModel(lastChatModelRef.current ?? fallbackModelChoice(modelCatalogRef.current));
          setSettingsTargetId(null);
        }
      } catch (err) {
        setSessionError(errorMessage(err));
      }
    })();
  }, [dataResetNonce, loadSession, refreshSessionIndex, setCurrentId, updateStreaming]);

  // 流式执行结束（或被用户停止）后，再应用排队中的桌宠聚焦，避免打断当前轮。
  useEffect(() => {
    if (!streaming) drainPetFocus();
  }, [drainPetFocus, streaming]);

  // 桌宠 → Web 聚焦：每 ~2s 取一次一次性请求。
  //
  // ★ 轮询只写 ref / 调稳定回调，不 setState，不会每 2s 触发一次重渲染。
  // ★ 端点不存在（旧构建/404）时安静停用；其它失败下一轮继续，不打印错误。
  // ★ 首次轮询放在 2s 后：React StrictMode 会立即卸载重挂 effect，
  //   立即发请求可能在第一次挂载里把一次性请求取走又丢掉。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let disposed = false;
    let stopped = false;
    let timer: number | null = null;

    const schedule = (delay: number): void => {
      if (disposed || stopped) return;
      timer = window.setTimeout(() => {
        void poll();
      }, delay);
    };

    const poll = async (): Promise<void> => {
      timer = null;
      if (disposed || stopped) return;
      try {
        const payload = await fetchJson<unknown>('/api/pet/focus', {
          signal: AbortSignal.timeout(8_000),
        });
        if (disposed || stopped) return;
        const focus = parsePetFocusPayload(payload);
        if (focus !== null) acceptPetFocus(focus);
        schedule(PET_FOCUS_POLL_MS);
      } catch (err) {
        if (disposed) return;
        if (err instanceof ApiError && err.status === 404) {
          stopped = true;
          return;
        }
        schedule(PET_FOCUS_POLL_MS);
      }
    };

    schedule(PET_FOCUS_POLL_MS);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [acceptPetFocus]);

  // 回到对话时，若本来就在底部就贴到底
  useEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    if (el === null) return;
    if (forceScrollRef.current || atBottomRef.current) {
      forceScrollRef.current = false;
      // 程序贴底 = 重新跟随：内容不够高、scrollTop 不变时不会触发 scroll 事件，
      // 所以 ref 和浮标状态都要在这里一起复位。
      atBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      setPinnedToBottom(true);
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

  /**
   * 没有当前会话时先建一个。
   *
   * ★ 创建失败的提示由调用方给：发送路径要说明“消息没发出去、输入和附件还在”，
   *   设置路径只需要原因；两条路径共用同一份创建流程，避免各写一遍。
   */
  async function ensureSession(failureNote?: string): Promise<string | null> {
    if (sessionId !== null) return sessionId;
    try {
      const res = await postJson<SessionCreateResponse>('/api/sessions', {});
      applySummary(res.session);
      sessionIdRef.current = res.session.id;
      setCurrentId(res.session.id);
      return res.session.id;
    } catch (err) {
      const reason = errorMessage(err);
      notify(failureNote === undefined ? reason : `${reason}；${failureNote}`, 'danger');
      return null;
    }
  }

  /** 把一条用户补充消息挂到当前轮（服务端已持久化；这里只为本地即时可见）。 */
  function addSteeringMessage(text: string): void {
    setLiveTurns((prev) => withLastSteering(prev, (messages) => addPendingSteering(messages, text)));
  }

  /** SSE `steering` 确认 / 去重。 */
  function confirmSteeringMessage(text: string): void {
    setLiveTurns((prev) => withLastSteering(prev, (messages) => confirmSteering(messages, text)));
  }

  /** 请求失败：撤掉尚未被服务端确认的乐观消息。 */
  function dropSteeringMessage(text: string): void {
    setLiveTurns((prev) =>
      withLastSteering(prev, (messages) => removePendingSteering(messages, text)),
    );
  }

  async function send(override?: string): Promise<void> {
    const text = (override ?? input).trim();

    /**
     * 运行中发送 = steering：
     * 消息立即进服务端历史，在当前工具返回后注入本轮；不新开 SSE 轮次。
     */
    if (streaming) {
      await steerRunning(text);
      return;
    }

    if (text.length === 0 && attachments.length === 0) return;
    if (!canChat) {
      notify('还没有配置模型。请在设置里查看接入方式。', 'warning');
      return;
    }
    // 等建会话期间输入框还留着原文，必须挡住第二次提交（见 sendPendingRef）。
    if (sendPendingRef.current) return;

    const outgoing = attachments.map((a) => a.url);
    // 这两个变量只回答“是不是首轮”（标题补生成用），与清空时机无关。
    const sendingDraft = isDraftSession || sessionId === null;
    const firstTurn = sendingDraft || (currentSession?.turnCount ?? 0) === 0;

    /**
     * 先建会话，成功之后再清输入。
     *
     * ★ 旧顺序先清再 await：创建会话失败时直接 return，用户刚打的字、附件、
     *   草稿全没了，只能重打。失败提示必须说清“内容还在”，否则用户会以为丢了。
     */
    sendPendingRef.current = true;
    let id: string | null = null;
    try {
      id = await ensureSession('消息没有发出去，输入内容和附件都还在输入框里');
    } finally {
      sendPendingRef.current = false;
    }
    if (id === null) return;

    /**
     * 真的发出去了才清空、才贴底。
     *
     * ★ 失败时不碰滚动：用户还停在原来的阅读位置，不能因为一次没成功的
     *   发送把视图拽到末尾。
     * ★ 贴底标记放在所有 setState 之前：滚动 effect 跟着 liveTurns 变化触发，
     *   不能等它跑完再补。
     */
    forceScrollRef.current = true;
    atBottomRef.current = true;
    setPinnedToBottom(true);
    if (sendingDraft) discardDraft();
    setInput('');
    setAttachments([]);

    recognitionRef.current?.stop();
    setListening(false);
    setLiveTurns((prev) => [
      ...prev,
      {
        startedAt: Date.now(),
        userText: text,
        images: outgoing,
        steering: [],
        assistant: emptyAssistant(),
      },
    ]);
    setLocalCancel(null);
    // 新一轮从这里接管；旧流的收尾会对照这个令牌，确认自己是否已被取代。
    const turnToken: object = {};
    turnTokenRef.current = turnToken;
    updateStreaming(true);

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
        if (sessionIdRef.current !== ev.sessionId) {
          sessionIdRef.current = ev.sessionId;
          setCurrentId(ev.sessionId);
        }
        return;
      }

      if (ev.type === 'settings') {
        // 本轮设置快照不再展示“本轮/下一轮”提示；也不回写会话设置。
        return;
      }

      if (ev.type === 'steering') {
        // 服务端已接收：确认乐观消息；重复事件不会产生第二条。
        confirmSteeringMessage(ev.text);
        return;
      }

      if (ev.type === 'approval') {
        setApprovals((prev) => enqueueApproval(prev, approvalFromEvent(ev)));
        notify('管家在等你确认一个动作', 'warning');
        return;
      }

      queue.push(ev);
      scheduleFlush();

      if (ev.type === 'audit') {
        void fetchJson<AuditResponse>(`/api/audit?from=${ev.range.fromSeq}&to=${ev.range.toSeq}`)
          .then((res) => {
            // 审计是后取的：回来时这一轮可能已被新一轮取代，别再改最后一轮。
            if (turnTokenRef.current !== turnToken) return;
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
      /**
       * 停止后立刻再发时，旧流的中断属于上一轮：只有它仍是最新轮才改状态、
       * 才报错，否则会把新一轮刚建好的 assistant 标成中断/失败。
       */
      if (turnTokenRef.current === turnToken) {
        flushQueue();
        if (err instanceof DOMException && err.name === 'AbortError') {
          setLiveTurns((prev) => patchLast(prev, (a) => ({ ...a, status: 'aborted' })));
        } else {
          const msg = errorMessage(err);
          setLiveTurns((prev) => patchLast(prev, (a) => ({ ...a, status: 'error', error: msg })));
          notify(msg, 'danger');
        }
      }
    } finally {
      /**
       * 先判定这一轮是否仍是最新轮，再做本轮专属的收尾。
       *
       * ★ 点“停止”后马上再发一条时，旧流若照旧执行下面的
       *   updateStreaming(false) / setApprovals([])，会把新一轮的流式状态
       *   关掉、把新一轮刚收到的审批卡清空。
       * ★ 不在 finally 里早退：会话列表刷新、标题生成这类幂等操作照常执行。
       */
      const isCurrent = turnTokenRef.current === turnToken;
      if (isCurrent) {
        turnTokenRef.current = null;
        flushQueue();
        if (abortRef.current === controller) abortRef.current = null;
        updateStreaming(false);
        /**
         * 流结束/取消后，后端已经 denyAll 本轮 pending。
         * 前端必须同步清空，否则会留下一个点了只会收到 409 的假弹窗。
         */
        setApprovals([]);
      } else {
        // 旧流的残留增量不能再画到新一轮头上：连 48ms 的定时器一起取消。
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        queue.length = 0;
      }
      /**
       * 会话列表刷新 / 标题生成是幂等的，任何一轮收尾都可以做；
       * 标题仍用 sessionIdRef 确认还是同一个会话，不用旧 id 覆盖新会话。
       */
      void (async () => {
        const list = await refreshSessions();
        // 新会话第一轮结束后异步补一次标题；不阻塞聊天，失败也不重试。
        if (firstTurn && list !== null && sessionIdRef.current === id) {
          requestSessionTitle(id);
        }
      })();
      onRefreshOverview();
    }
  }

  /**
   * 运行中发送消息：POST /api/chat/steer。
   *
   * 不新开 SSE 轮次，也不把消息伪装成新的 assistant turn；它属于当前轮，
   * 显示在 LiveTurn 的 steering 列表里，等服务端 `steering` 事件确认。
   */
  async function steerRunning(text: string): Promise<void> {
    if (text.length === 0) {
      if (attachments.length > 0) {
        notify('运行中暂时只能发送文字；附件请等这一轮结束后再发。', 'warning');
      }
      return;
    }
    if (!canChat) {
      notify('还没有配置模型。请在设置里查看接入方式。', 'warning');
      return;
    }
    const id = sessionIdRef.current;
    if (id === null) {
      notify('这一轮还在建立会话，请稍后再发。', 'warning');
      return;
    }

    const cancelApprovals = approvals.length > 0;
    const previousApprovals = approvals;
    const body = runningSteerBody(id, text, cancelApprovals);

    // 乐观展示：清输入、撤审批卡（服务端会在同一请求里取消全部 pending）。
    forceScrollRef.current = true;
    atBottomRef.current = true;
    setInput('');
    if (cancelApprovals) setApprovals([]);
    addSteeringMessage(text);

    try {
      await postJson<SteerResponse>('/api/chat/steer', body);
    } catch (err) {
      // 等待期间用户切走了会话：不要把旧会话的文字/审批状态写进新页面。
      if (sessionIdRef.current !== id) return;
      const recovery = recoverFromSteerFailure(err, text);
      setInput(recovery.input);
      if (recovery.clearApprovals) {
        // 本轮已经结束：服务端没有可保留的 pending，本地也全部清掉。
        setApprovals([]);
      } else if (cancelApprovals) {
        // 请求没成功，审批并没有真的被取消：恢复卡片（保留期间新到的请求）。
        setApprovals((prev) => {
          const restored = previousApprovals.filter(
            (item) => !prev.some((pending) => pending.id === item.id),
          );
          return [...restored, ...prev];
        });
      }
      dropSteeringMessage(text);
      if (recovery.resumeAfterTurn !== null) {
        resumingAfterTurnRef.current = { sessionId: id, text: recovery.resumeAfterTurn };
        notify('这一轮刚刚结束；内容已放回输入框，收尾后会自动按普通消息发送。', 'warning');
      } else {
        notify(errorMessage(err), 'warning');
      }
    }
  }

  /**
   * 409 恢复的文字要等旧 SSE 真正收尾后再发。
   *
   * 直接在同一时刻调用 send 会和旧流的 finally 抢 streaming / abortRef；
   * 这里由 streaming 变 false 触发，且只发“用户没有改过”的那段草稿。
   */
  // 卸载时确保分隔条监听不会残留
  useEffect(() => {
    return () => {
      splitterCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (streaming) return;
    const pending = resumingAfterTurnRef.current;
    if (pending === null) return;
    resumingAfterTurnRef.current = null;
    if (sessionIdRef.current !== pending.sessionId) return;
    if (input.trim() !== pending.text) return;
    void send(pending.text);
  }, [input, send, streaming]);

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
    /**
     * ★ 停止要顺手取消"等旧轮收尾后自动重发"的排队。
     *
     *   那个排队由 `streaming` 变 false 触发，而"点停止"同样会让 streaming 变 false——
     *   不在这里清掉的话，用户点了停止，几毫秒后那条消息又自己发出去了。
     */
    resumingAfterTurnRef.current = null;
    const toolCalls =
      live?.rounds.reduce((n, r) => n + r.tools.length, 0) ?? 0;
    const toolResults =
      live?.rounds.reduce(
        (n, r) => n + r.tools.filter((t) => t.status !== 'pending' && t.status !== 'running').length,
        0,
      ) ?? 0;
    abortRef.current?.abort();
    abortRef.current = null;
    updateStreaming(false);
    setLiveTurns((prev) => patchLast(prev, (a) => ({ ...a, status: 'aborted' })));
    /**
     * 停止即撤销本轮所有待确认：服务端已经 denyAll，本地也同步清掉。
     *
     * ★ 不能只靠流收尾去清：用户可能马上再发一条，旧流的 finally 会判定
     *   自己已不是最新轮而跳过清理，旧审批卡就会挂到新一轮上（点了只会 409）。
     */
    setApprovals([]);
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

  /**
   * 审批按钮：走同一个 /api/chat/steer。
   *
   * · 输入框有文字时，审批决定 + 文字一起提交；
   * · 成功后只 dequeue 当前卡，其他 pending 保持不动；
   * · 失败时卡片留着，文字也留在输入框（没有静默吞掉任何一种）。
   */
  async function answerApproval(allow: boolean): Promise<void> {
    const current = currentApproval(approvals);
    if (current === null || answering) return;
    const id = sessionIdRef.current;
    if (id === null) {
      notify('会话还没准备好，请稍后再试。', 'warning');
      return;
    }

    const text = input.trim();
    const body = approvalSteerBody(id, current.id, allow, text);

    setAnswering(true);
    if (text.length > 0) {
      setInput('');
      addSteeringMessage(text);
    }

    try {
      await postJson<SteerResponse>('/api/chat/steer', body);
      if (sessionIdRef.current !== id) return;
      // 只移除刚答复的这张卡；期间新到的 pending 保持不动。
      setApprovals((prev) => removeApproval(prev, current.id));
      notify(allow ? '已允许这一次操作' : '已拒绝这一次操作', allow ? 'success' : 'default');
    } catch (err) {
      // 等待期间用户切走了会话：旧会话的审批状态不写进新页面。
      if (sessionIdRef.current !== id) return;
      if (text.length > 0) {
        setInput(text);
        dropSteeringMessage(text);
      }
      if (isNoActiveTurnError(err)) {
        // 本轮在服务端已结束：所有 pending 都失效，文字放回输入框。
        setApprovals([]);
        notify(
          text.length > 0
            ? '这一轮已经结束，审批已失效；你的文字已放回输入框。'
            : '这一轮已经结束，审批已失效。',
          'warning',
        );
      } else if (err instanceof ApiError && err.status === 409) {
        // 单条审批失效（可能已在别处答复）：只移除当前卡。
        setApprovals((prev) => removeApproval(prev, current.id));
        notify(
          text.length > 0 ? '这个确认已经失效；你的文字已放回输入框。' : '这个确认已经失效。',
          'warning',
        );
      } else {
        notify(errorMessage(err), 'warning');
      }
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
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    atBottomRef.current = atBottom;
    // 同值时返回上一个 state：滚动事件很密，浮标不能把整棵对话树每帧重渲染。
    setPinnedToBottom((prev) => (prev === atBottom ? prev : atBottom));
  }

  /**
   * 「回到最新」：用户主动要求回到底部，并恢复自动贴底。
   *
   * ★ 直接贴底、不做平滑动画：动画途中会连续触发 scroll，按阈值会把
   *   “还在路上”误判成“用户上翻”，浮标重新弹出；流式增量也会让动画目标
   *   瞬间过期。这里没有新增动画，也就不需要额外的 prefers-reduced-motion 分支。
   */
  function jumpToLatest(): void {
    const el = scrollRef.current;
    if (el === null) return;
    atBottomRef.current = true;
    forceScrollRef.current = false;
    setPinnedToBottom(true);
    el.scrollTop = el.scrollHeight;
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

  const activeApproval = currentApproval(approvals);

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
          <div className="chat-head-title">
            <h1 title={derivedTitle}>{derivedTitle}</h1>
            <p>{subtitle}</p>
          </div>
        </div>
        <div className="chat-head-actions">
          <button
            type="button"
            className={`btn btn-ghost btn-sm is-review-toggle${reviewOpen ? ' is-active' : ''}`}
            disabled={
              !reviewOpen &&
              lastReviewable === null &&
              reviewHistory.length === 0 &&
              reviewRun === null &&
              !reviewBusy &&
              !reviewStopped &&
              reviewError === null
            }
            onClick={toggleReview}
            aria-pressed={reviewOpen}
            title={
              reviewOpen
                ? '关闭审查'
                : lastReviewable === null && reviewHistory.length === 0
                  ? '还没有可审查的完成或中断轮次'
                  : '打开审查'
            }
          >
            <Icon name="eye" size={15} /> 审查
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
                它记得你，也替你办事。需要动手时先理清目标，过程与产出都留在这轮下面。
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

      {/*
        不在底部时的回底入口：长回答读到这里可以一键回到最新，
        不用手动滚到贴底再让下一批增量接着跟随。
        审查模式是左右分栏，浮标会压到分栏线上，所以只在普通对话里出现。
      */}
      {!reviewOpen && !pinnedToBottom && hasContent && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={JUMP_LATEST_STYLE}
          aria-label="回到最新消息"
          onClick={jumpToLatest}
        >
          <Icon name="chevronDown" size={14} /> 回到最新
        </button>
      )}

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
            <header className="review-head">
              <div className="review-head-main">
                <h2>审查</h2>
              </div>
              <div className="review-head-actions">
                <span className={`review-status${reviewStatusClass}`}>{reviewStatusText}</span>
                <button
                  ref={reviewHistoryToggleRef}
                  type="button"
                  className={`review-history-toggle${reviewHistoryOpen ? ' is-active' : ''}`}
                  aria-expanded={reviewHistoryOpen}
                  aria-haspopup="dialog"
                  onClick={() => setReviewHistoryOpen((open) => !open)}
                  title="历史审查"
                >
                  <Icon name="history" size={13} />
                  <span>历史</span>
                  {reviewHistoryLoading && reviewHistory.length === 0 ? (
                    <b className="review-history-badge">…</b>
                  ) : reviewHistory.length > 0 ? (
                    <b className="review-history-badge">{reviewHistory.length}</b>
                  ) : null}
                </button>
                <button type="button" className="review-close" aria-label="关闭审查" onClick={closeReview}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            </header>

            <div className="review-body">

              {reviewBusy ? (
                <div className="review-report" aria-busy="true">
                  <div className="review-report-head">
                    <div>
                      <p className="review-overline">审查范围 · {reviewRangeText}</p>
                      <h3>审查中</h3>
                    </div>
                    <span className="review-live-note">过程实时更新</span>
                  </div>
                  <div className="review-running" role="status" aria-live="polite">
                    <span className="review-spinner" aria-hidden="true" />
                    <div className="review-running-copy">
                      <p>正在读取上下文、调用只读工具取证…</p>
                      <small>
                        {reviewRangeText}
                        {reviewProcess.model !== null ? ` · ${reviewProcess.model}` : ''} · 只读工具
                      </small>
                    </div>
                    <button type="button" className="review-stop" onClick={stopReview}>
                      停止
                    </button>
                  </div>
                  <ReviewProcess state={reviewProcess} streaming />
                  {reviewStreamText.length > 0 && (
                    <div className="review-output is-streaming">
                      <MemoizedMarkdown text={reviewStreamText} streaming />
                    </div>
                  )}
                </div>
              ) : reviewRun !== null ? (
                <div className="review-report">
                  <div className="review-report-head">
                    <div>
                      <p className="review-overline">审查范围 · {reviewResultScope}</p>
                      {reviewViewKind !== 'completed' && (
                        <h3>{reviewViewKind === 'stopped' ? '审查已停止' : '审查未完成'}</h3>
                      )}
                    </div>
                    {reviewRun.createdAt !== null && (
                      <time
                        className="review-report-time"
                        dateTime={new Date(reviewRun.createdAt).toISOString()}
                        title="审查执行时间"
                      >
                        {formatDateTime(reviewRun.createdAt)}
                      </time>
                    )}
                  </div>

                  {reviewViewKind === 'completed' && (
                    <section className="review-full-report" aria-label="完整报告">
                      <div className="review-section-head">
                        <h4>完整报告</h4>
                      </div>
                      {reviewRun.markdown.length > 0 ? (
                        <div className="review-output">
                          <MemoizedMarkdown text={reviewRun.markdown} />
                        </div>
                      ) : (
                        <p className="review-note">这次审查没有留下文字结论。</p>
                      )}
                    </section>
                  )}
                  {reviewViewKind === 'failed' && (
                    <p className="review-error" role="alert">
                      {reviewError ?? '这次审查失败'}
                    </p>
                  )}
                  {reviewViewKind === 'stopped' && (
                    <p className="review-note">本次审查已停止，没有生成结论。</p>
                  )}

                  <ReviewProcess state={reviewProcess} streaming={false} />

                  <div className="review-foot">
                    <button type="button" className="review-back" onClick={resetReview}>
                      重新选择
                    </button>
                    <button
                      type="button"
                      className="review-again"
                      disabled={reviewRange === null}
                      title={
                        reviewRange === null
                          ? '这条历史记录无法映射到当前轮次，请重新选择范围'
                          : '再次审查当前范围'
                      }
                      onClick={() => {
                        if (reviewRange !== null) void startReview(reviewRange);
                      }}
                    >
                      {reviewViewKind === 'completed' ? '再次审查' : '重新审查'}
                    </button>
                  </div>
                </div>
              ) : reviewStopped ? (
                <div className="review-report">
                  <div className="review-report-head">
                    <div>
                      <p className="review-overline">审查范围 · {reviewRangeText}</p>
                      <h3>审查已停止</h3>
                    </div>
                  </div>
                  <p className="review-note">本次审查已取消，没有生成结论。</p>
                  <ReviewProcess state={reviewProcess} streaming={false} />
                  <div className="review-foot">
                    <button type="button" className="review-back" onClick={resetReview}>
                      重新选择
                    </button>
                    <button
                      type="button"
                      className="review-again"
                      disabled={reviewRange === null}
                      onClick={() => {
                        if (reviewRange !== null) void startReview(reviewRange);
                      }}
                    >
                      重新审查
                    </button>
                  </div>
                </div>
              ) : reviewError !== null ? (
                <div className="review-report">
                  <div className="review-report-head">
                    <div>
                      <p className="review-overline">审查范围 · {reviewRangeText}</p>
                      <h3>审查失败</h3>
                    </div>
                  </div>
                  <p className="review-error" role="alert">
                    {reviewError}
                  </p>
                  <ReviewProcess state={reviewProcess} streaming={false} />
                  <div className="review-foot">
                    <button type="button" className="review-back" onClick={resetReview}>
                      重新选择
                    </button>
                    <button
                      type="button"
                      className="review-again"
                      disabled={reviewRange === null}
                      onClick={() => {
                        if (reviewRange !== null) void startReview(reviewRange);
                      }}
                    >
                      重新审查
                    </button>
                  </div>
                </div>
              ) : (
                <div className="review-idle">
                  <div className="review-scope-row">
                    <button
                      type="button"
                      className="review-range"
                      aria-expanded={reviewPickerOpen}
                      aria-haspopup="dialog"
                      onClick={toggleReviewPicker}
                    >
                      {reviewRangeText} <span>▾</span>
                    </button>
                    {reviewRangeHasInterrupted && (
                      <span className="review-interrupt-note">含中断轮次，只审查已生成部分</span>
                    )}
                    <button
                      type="button"
                      className="review-start"
                      disabled={reviewRange === null}
                      onClick={() => {
                        if (reviewRange !== null) void startReview(reviewRange);
                      }}
                    >
                      开始审查
                    </button>
                  </div>

                  {reviewPickerOpen && (
                    <div className="review-picker" role="dialog" aria-label="选择审查轮次">
                      <div className="review-pop-head">
                        选择审查轮次
                      </div>
                      <p className="review-picker-hint">
                        点击起点，再点终点；Shift + 点击扩展范围；滚轮或 ← → 横向浏览
                      </p>
                      <div
                        className="review-timeline"
                        ref={reviewTimelineRef}
                        role="group"
                        aria-label="审查轮次时间轴"
                        onKeyDown={handleReviewTimelineKeyDown}
                      >
                        <ol className="review-timeline-list">
                          {reviewTurns.map((t) => {
                            const selectable = isReviewableTurn(t);
                            const inRange =
                              reviewRange !== null && t.index >= reviewRange.start && t.index <= reviewRange.end;
                            const isStart = reviewRange !== null && t.index === reviewRange.start;
                            const isEnd = reviewRange !== null && t.index === reviewRange.end;
                            const isFocused = reviewFocus === t.index;
                            const stateLabel = reviewTurnStateLabel(t.state);
                            return (
                              <li
                                key={t.user.id}
                                className={`review-step${inRange ? ' is-selected' : ''}${isStart ? ' is-start' : ''}${isEnd ? ' is-end' : ''}${selectable ? '' : ' is-disabled'}${t.state === 'interrupted' ? ' is-interrupted' : ''}${isFocused ? ' is-focused' : ''}`}
                              >
                                <button
                                  type="button"
                                  className="review-step-dot"
                                  data-review-index={t.index}
                                  disabled={!selectable}
                                  tabIndex={reviewTabStop === t.index ? 0 : -1}
                                  aria-pressed={inRange}
                                  aria-label={`第 ${t.index + 1} 轮，${stateLabel}${inRange ? '，已选范围内' : ''}${selectable ? '' : '，不可选'}`}
                                  title={`第 ${t.index + 1} 轮 · ${stateLabel}${selectable ? '' : '（不可选）'}`}
                                  onClick={(e) => selectReviewTurn(t.index, e.shiftKey)}
                                  onFocus={() => setReviewFocus(t.index)}
                                >
                                  {String(t.index + 1).padStart(2, '0')}
                                </button>
                                {isStart && reviewRange !== null && (
                                  <span className="review-step-mark" aria-hidden="true">
                                    {reviewRange.start === reviewRange.end ? '单轮' : '起点'}
                                  </span>
                                )}
                                {isEnd && reviewRange !== null && reviewRange.start !== reviewRange.end && (
                                  <span className="review-step-mark" aria-hidden="true">
                                    终点
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ol>
                      </div>
                      {reviewPreviewTurn !== null && (
                        <div className="review-preview" key={reviewPreviewTurn.index} aria-live="polite">
                          <span className="review-preview-label">第 {reviewPreviewTurn.index + 1} 轮预览</span>
                          <p className="review-preview-text">{reviewPreviewText(reviewPreviewTurn.user.text)}</p>
                        </div>
                      )}
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

              {reviewHistoryOpen && (
                <>
                  <button
                    type="button"
                    className="review-history-scrim"
                    aria-label="关闭历史审查"
                    tabIndex={-1}
                    onClick={closeReviewHistory}
                  />
                  <section className="review-history" role="dialog" aria-label="历史审查">
                    <div className="review-history-head">
                      <span className="review-history-title">
                        <Icon name="history" size={13} /> 历史审查
                      </span>
                      <span className="review-history-count">
                        {reviewHistoryLoading ? '读取中…' : `${reviewHistory.length} 条`}
                      </span>
                      <button
                        ref={reviewHistoryCloseRef}
                        type="button"
                        className="review-history-close"
                        aria-label="关闭历史审查"
                        onClick={closeReviewHistory}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                    <div className="review-history-list">
                      {reviewHistoryError !== null ? (
                        <div className="review-history-error">
                          <p>{reviewHistoryError}</p>
                          <button
                            type="button"
                            className="text-btn"
                            onClick={() => {
                              if (sessionId !== null) void loadReviewHistory(sessionId);
                            }}
                          >
                            重试
                          </button>
                        </div>
                      ) : reviewHistoryLoading && reviewHistory.length === 0 ? (
                        <p className="review-history-empty">正在读取历史…</p>
                      ) : reviewHistory.length === 0 ? (
                        <p className="review-history-empty">还没有审查记录</p>
                      ) : (
                        reviewHistory.map((run, index) => {
                          const status = reviewRunStatus(run);
                          const report = run.report ?? null;
                          const verdict = reviewVerdictOf(report);
                          const legacy = report?.legacy === true;
                          const showVerdict =
                            report !== null && (status === 'completed' || report.verdict !== undefined);
                          const turnIds = Array.isArray(run.turnIds)
                            ? run.turnIds.filter(
                                (value): value is string => typeof value === 'string',
                              )
                            : [];
                          const scope = mapReviewScope(turnIds, reviewTurnIndexById).label;
                          const createdAt =
                            typeof run.createdAt === 'number' ? run.createdAt : null;
                          const traceCount = Array.isArray(run.traces) ? run.traces.length : 0;
                          const active = run.id !== undefined && run.id === reviewActiveId;
                          return (
                            <button
                              key={run.id ?? `review-history-${index}`}
                              type="button"
                              className={`review-history-item${active ? ' is-active' : ''}`}
                              disabled={reviewBusy}
                              title={reviewBusy ? '审查进行中，结束后可恢复历史' : '恢复这次审查'}
                              onClick={() => {
                                restoreReviewHistory(run);
                                reviewHistoryToggleRef.current?.focus();
                              }}
                            >
                              <span className="review-history-top">
                                <span className="review-history-time">
                                  {createdAt !== null ? formatDateTime(createdAt) : '时间未知'}
                                </span>
                                {showVerdict && (
                                  <span
                                    className={`review-verdict review-verdict--small is-${verdict}`}
                                    data-verdict={verdict}
                                    title={`结论：${REVIEW_VERDICT_LABEL[verdict]}`}
                                  >
                                    {REVIEW_VERDICT_LABEL[verdict]}
                                  </span>
                                )}
                                {legacy && (
                                  <span className="review-legacy review-legacy--small">旧记录</span>
                                )}
                                <span className={`review-history-state is-${status}`}>
                                  {reviewStatusLabel(status)}
                                </span>
                              </span>
                              <span className="review-history-scope">
                                {scope.length > 0
                                  ? scope
                                  : turnIds.length > 0
                                    ? `${turnIds.length} 个轮次`
                                    : '轮次未知'}
                                {` · ${traceCount > 0 ? `${traceCount} 次工具调用` : '无工具轨迹'}`}
                              </span>
                              <span className="review-history-summary">{reviewRunSummary(run)}</span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </section>
                </>
              )}
            </div>
          </section>
        </>
      )}

      <aside className="turn-rail" aria-label="轮次导航">
        <div
          className="turn-dots"
          ref={turnDotsRef}
          onWheel={() => {
            railTouchedRef.current = true;
          }}
          onPointerDown={() => {
            railTouchedRef.current = true;
          }}
          onTouchStart={() => {
            railTouchedRef.current = true;
          }}
          onKeyDown={() => {
            railTouchedRef.current = true;
          }}
          onScroll={syncRailScrollbar}
        >
          {reviewTurns.map((t) => {
            const label = turnDotLabel(t.index, t.user.text);
            return (
              <button
                key={t.user.id}
                type="button"
                className={`turn-dot${currentTurnIndex === t.index ? ' is-current' : ''}`}
                title={label}
                aria-label={label}
                aria-current={currentTurnIndex === t.index ? 'true' : undefined}
                onClick={() => jumpToTurn(t.index)}
              />
            );
          })}
          {liveTurns.length > 0 && (
            <span className="turn-dot is-running" aria-hidden="true" />
          )}
        </div>
        {railThumb !== null && (
          <div
            className="turn-rail-scroll"
            aria-hidden="true"
            style={{ height: `${railThumb.track}px` }}
          >
            <span
              className="turn-rail-thumb"
              style={{
                height: `${railThumb.height}px`,
                transform: `translateY(${railThumb.top}px)`,
              }}
            />
          </div>
        )}
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

          {activeApproval !== null && (
            <ApprovalCard
              approval={activeApproval}
              pendingCount={approvals.length}
              answering={answering}
              onAnswer={(allow) => void answerApproval(allow)}
            />
          )}

          <div className={`composer ${streaming ? 'is-busy' : ''}`}>
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              placeholder={
                canChat
                  ? streaming
                    ? '运行中也能补充；Enter 中途发送，Shift+Enter 换行'
                    : '说说你想办的事…（Enter 发送，Shift+Enter 换行）'
                  : '未配置模型，暂不能对话'
              }
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
                  title="添加图片或文档"
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
                {(listening || attachments.length > 0) && (
                  <span className="composer-hint">
                    {listening
                      ? '正在听… 再点麦克风结束'
                      : `${attachments.length} 张图片`}
                  </span>
                )}
              </div>

              <SessionControls
                profiles={modelCatalog}
                model={chatModel}
                reasoning={activeReasoning}
                saving={settingsSaving}
                catalogLoading={modelCatalogLoading}
                catalogError={modelCatalogError}
                settingsError={settingsError}
                onRefreshCatalog={() => void loadModelCatalog()}
                onSelectModel={selectChatModel}
                onSelectReasoning={selectReasoning}
                onOpenSettings={onOpenSettings}
              />
              {streaming ? (
                <>
                  {input.trim().length > 0 && (
                    <button
                      type="button"
                      className="send-btn send-btn--steer"
                      onClick={() => void send()}
                      title="发送给正在执行的这一轮"
                      aria-label="中途发送"
                    >
                      <Icon name="arrowUp" size={17} />
                    </button>
                  )}
                  <button type="button" className="send-btn send-btn--stop" onClick={stop} aria-label="断开接收">
                    <Icon name="stop" size={16} />
                  </button>
                </>
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

      {/* 历史只在侧栏；这里不再保留抽屉，也不重复加载会话列表。 */}
      <SessionSettingsSheet
        open={settingsTargetId !== null && settingsTarget !== null}
        session={settingsTarget}
        notify={notify}
        onClose={() => setSettingsTargetId(null)}
        onSaved={handleSessionSaved}
      />

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

/**
 * 轮次点的可读文案：只描述用户说了什么，不暴露轮次状态。
 *
 * · 换行/连续空白折叠为一个空格；
 * · 严格取前 30 个字符（按 Unicode 码点，避免拆坏 emoji），超出加 `…`；
 * · 用户只发了图片/文件、没有文字时显示「图片/文件」。
 *   MessageDto 目前没有附件字段，所以这里不猜具体类型。
 */
function turnDotLabel(index: number, userText: string): string {
  const compact = userText.replace(/\s+/g, ' ').trim();
  const chars = Array.from(compact);
  const text =
    chars.length === 0
      ? '图片/文件'
      : chars.length > 30
        ? `${chars.slice(0, 30).join('')}…`
        : compact;
  return `第 ${index + 1} 轮 · ${text}`;
}

function reviewTurnStateLabel(state: ReviewTurn['state']): string {
  if (state === 'done') return '完成';
  if (state === 'interrupted') return '中断（可审查）';
  if (state === 'failed') return '失败';
  return '运行中';
}

/**
 * 时间轴预览：只取用户消息的第一段文本。
 * 换行/连续空白折叠为空格，按 Unicode 码点截 80 字；没有文字时显示「图片/文件」。
 * （MessageDto 没有附件字段，和 turnDotLabel 保持同一判定。）
 */
function reviewPreviewText(userText: string): string {
  const compact = userText.replace(/\s+/g, ' ').trim();
  const chars = Array.from(compact);
  if (chars.length === 0) return '图片/文件';
  return chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : compact;
}

/**
 * 审查可选：终态且有助手回复。
 *
 * · done        —— 完整回复，整轮可审；
 * · interrupted —— 中断但保留了已生成部分，只审这部分；
 * · failed / running 仍不可选。
 */
function isReviewableTurn(turn: ReviewTurn): boolean {
  return (turn.state === 'done' || turn.state === 'interrupted') && turn.assistant !== null;
}

/**
 * 哪些消息算作一轮的“助手回复”。
 *
 * ★ 当前角色是 butler；早期会话历史里是 servant。
 *   servant 这里只用于识别旧轮次，不改变任何当前角色判断。
 */
function isReviewAssistantMessage(message: MessageDto): boolean {
  return message.role === 'butler' || message.role === 'servant';
}

/** 助手消息状态 → 审查轮状态；streaming 还没写完，按运行中处理。 */
function reviewTurnStateOf(assistant: MessageDto | null): ReviewTurn['state'] {
  if (assistant === null) return 'running';
  if (assistant.status === 'done') return 'done';
  if (assistant.status === 'interrupted') return 'interrupted';
  if (assistant.status === 'failed') return 'failed';
  return 'running';
}

function buildReviewTurns(messages: readonly MessageDto[]): readonly ReviewTurn[] {
  const turns: ReviewTurn[] = [];
  let pendingUser: MessageDto | null = null;
  let pendingAssistant: MessageDto | null = null;

  /**
   * 一个用户回合结束：保留该用户消息之后、下一条用户消息之前的**最后一条**
   * 助手回复。多助手消息时后到的覆盖先到的，等下一个 user 再落盘。
   */
  const flush = (): void => {
    if (pendingUser === null) return;
    turns.push({
      index: turns.length,
      user: pendingUser,
      assistant: pendingAssistant,
      state: reviewTurnStateOf(pendingAssistant),
    });
    pendingUser = null;
    pendingAssistant = null;
  };

  for (const m of messages) {
    if (m.role === 'user') {
      flush();
      pendingUser = m;
    } else if (pendingUser !== null && isReviewAssistantMessage(m)) {
      pendingAssistant = m;
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
        <MemoizedMarkdown text={message.text} />
      </div>

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
          {/*
            * 这里的「now」直接取 Date.now()：实时轮在流式期间每 48ms 就会重渲染，
            * 时间自然跟着走；流结束后组件不再刷新，显示的停在那次渲染，
            * 这正是我们要的（结束时刻）。
            */}
          <span>{relativeTime(turn.startedAt, Date.now())}</span>
        </div>
      </div>

      {turn.steering.length > 0 && (
        <div className="steering-stack" role="group" aria-label="运行中补充的消息">
          {turn.steering.map((message) => (
            <div className="msg msg--user msg--steering" key={`steering-${message.seq}`}>
              <div className="user-bubble">{message.text}</div>
              <div className="msg-meta">
                <span
                  className={message.delivered || !streaming ? 'steering-sent' : undefined}
                >
                  {steeringStatusLabel(message.delivered, !streaming)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

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
              <MemoizedMarkdown text={a.narration} streaming={streaming} />
            </div>
          ) : a.text.length > 0 ? (
            <MemoizedMarkdown text={a.text} />
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
