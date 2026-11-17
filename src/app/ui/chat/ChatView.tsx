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

import dynamic from 'next/dynamic';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

import { Icon, type IconName } from '../components/Icon';
import { BrandMark } from '../components/BrandMark';
import { Markdown } from '../components/Markdown';
import { Badge, InlineError, Skeleton } from '../components/Common';
import { primaryPathOf } from '@/core/tools/pathFields.js';
import { useAutoResize, useMounted, useNow } from '../lib/hooks.js';
import { ApiError, errorMessage, fetchJson, patchJson, postJson } from '../lib/api.js';
import {
  formatChatTime,
  formatDateFull,
  formatDateTime,
  formatDayLabel,
  formatNumber,
  greeting,
  plainText,
  sameLocalDay,
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
import { StudyPane } from './StudyPane';

/**
 * 重面板按需加载。
 *
 * 这些面板只在用户点开对应入口时才需要；静态引入会让首屏连 xterm、
 * 浏览器控制、工作区树一起下载。动态导入把首次打开成本推迟到真正使用时。
 */
const WorkPanel = dynamic(() => import('./WorkPanel').then((m) => m.WorkPanel), {
  ssr: false,
  loading: PaneLoading,
});
const BrowserPanel = dynamic(() => import('./BrowserPanel').then((m) => m.BrowserPanel), {
  ssr: false,
  loading: PaneLoading,
});
const ExternalFilePanel = dynamic(
  () => import('./ExternalFilePanel').then((m) => m.ExternalFilePanel),
  { ssr: false, loading: PaneLoading },
);
const TerminalPanel = dynamic(() => import('./TerminalPanel').then((m) => m.TerminalPanel), {
  ssr: false,
  loading: PaneLoading,
});

/** 懒加载面板首次打开时的轻量占位，避免空白一块。 */
function PaneLoading(): JSX.Element {
  return (
    <div className="pane-loading" role="status">
      正在打开面板…
    </div>
  );
}
import { TtsBlobCache, ttsCacheKey } from './ttsCache.js';
import type { WorkPanelAiOp } from './WorkPanel';

import type { ExternalFileHandleDto } from './ExternalFilePanel';
import type { TerminalSessionInfo } from './TerminalPanel';

/**
 * 草稿 key 前缀。
 *
 * ★ 旧版本所有会话共用一个全局 key：在 A 里写的草稿会出现在 B 里。
 *   现在按会话分 key；同一个前缀继续作为「还没有会话」时的兜底 key
 *   （首屏没有会话、数据被清空），旧草稿也因此不会被直接丢掉。
 */
const DRAFT_STORAGE_KEY = 'butler.chat.draft';

/** 会话 id → 草稿 key；null 表示还没有会话，用固定兜底 key。 */
function draftStorageKey(sessionId: string | null): string {
  return sessionId === null ? DRAFT_STORAGE_KEY : `${DRAFT_STORAGE_KEY}.${sessionId}`;
}

function readDraftText(key: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeDraftText(key: string, text: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (text.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, text);
  } catch {
    // localStorage 不可用时不阻塞输入。
  }
}

function clearDraftText(key: string): void {
  writeDraftText(key, '');
}

interface TtsConfig {
  readonly profileId: string;
  readonly modelId: string;
  readonly voice: string;
  readonly style: string;
  readonly format: 'mp3' | 'wav';
}

interface ModelCatalogResponse {
  readonly profiles: readonly PickableProfile[];
  readonly lastChat: ModelChoice | null;
  readonly tts?: TtsConfig | null;
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
  /**
   * 专注空间的左抽屉模式。
   *
   * ★ 不是另一份对话：仍是同一个 ChatView 实例、同一个会话与同一条流。
   *   只把头部换成抽屉头、隐藏模型选择与统计，保留输入 / 发送 / 停止 / 附件 / 审批。
   */
  readonly focusMode?: boolean;
  /** 专注左抽屉当前是否真的打开；用于抽屉被收起时关掉内部设置浮层。 */
  readonly focusDrawerOpen?: boolean;
  /** 专注抽屉的关闭按钮；由外层收起左抽屉。 */
  readonly onFocusClose?: () => void;
  /** 审批数量变化；外层据此在专注空间里把抽屉自动露出来。 */
  readonly onApprovalCountChange?: (count: number) => void;
  readonly overview: Overview | null;
  readonly dataResetNonce: number;
  readonly onOpenMemory: (opts?: MemoryTarget) => void;
  readonly onOpenSettings: () => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onRefreshOverview: () => void;
  readonly onBootState: (state: ChatBootState) => void;
  readonly onReviewModeChange: (open: boolean) => void;
}

/**
 * 右栏面板类型：工作区 / 外部文件 / 终端可多开，浏览器 / 审查各单实例。
 * ★ 用实例数组（而不是一个 paneTab 单值）记录，多个面板才能同时活着、
 *   各自保留目录、文件草稿与终端会话；当前显示哪一个由 activePaneId 决定。
 * ★ 内部 kind 仍叫 files（= 工作区）：改名只改用户看到的文案，
 *   这样后端、测试和已有实例判断都不用跟着连锁改动。
 */
type PaneKind = 'files' | 'browser' | 'review' | 'external-file' | 'terminal' | 'study';

interface PaneInstance {
  readonly id: string;
  readonly kind: PaneKind;
  readonly label: string;
  /** 外部文件句柄；仅 kind === 'external-file' 时存在。 */
  readonly externalFile?: ExternalFileHandleDto;
  /** 终端信息；kind === 'terminal' 且启动成功时存在。 */
  readonly terminal?: TerminalSessionInfo;
  /** 终端启动失败的原因；此时没有 terminal，但面板要留下一个可见的错误落点。 */
  readonly terminalError?: string;
}

/** 面板 kind → 图标。二级菜单的「新建」项与已打开面板行共用一份映射，避免两处各写一份后走样。 */
const PANE_KIND_ICON: Record<PaneKind, IconName> = {
  files: 'file',
  browser: 'console',
  review: 'eye',
  // 图标集里没有 terminal，用同义的 console 表示终端。
  'external-file': 'file',
  terminal: 'console',
  study: 'book',
};

/** 初始就有一个工作区面板：右栏默认关着，但一打开就该有东西可看。 */
const INITIAL_PANES: readonly PaneInstance[] = [
  { id: 'pane-1', kind: 'files', label: '工作区 1' },
];
const INITIAL_ACTIVE_PANE_ID = 'pane-1';

/** POST /api/files/open-dialog 的返回：file 就是后续所有请求要带的句柄。 */
interface OpenExternalFileResponse {
  readonly ok: boolean;
  readonly file: ExternalFileHandleDto;
}

/** POST /api/terminal 的返回。 */
interface StartTerminalResponse {
  readonly ok: boolean;
  readonly terminal: TerminalSessionInfo;
}

/**
 * 浮层几何：主列表从按钮下方展开；「新建」的二级菜单仍从该行左侧展开。
 * ★ 11px 是二级卡片相对「新建」行内容盒的间距，不是两层卡片的可见缝隙：
 *   行左缘本身距卡片左缘还有 5px（1px 边框 + 4px 内边距），所以 11 = 5 + 6。
 * ★ 11px 与 190px 卡片宽度和 chat.css 是同一份约定，改宽度/间距时两边要一起改。
 */
const PANEL_FLYOUT_GAP = 11;
const PANEL_MENU_WIDTH = 190;
/** 离视口左缘至少留 8px：贴边时卡片阴影不会被裁掉。 */
const PANEL_VIEWPORT_EDGE = 8;

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
/** 原图上限：再大就不解码了，避免一张图直接把标签页内存打爆。 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * 发送前的图片压缩参数。
 *
 * ★ 32 MiB 的图转成 data URL 约 42 MiB，随 JSON 发出去会让请求体和主线程
 *   一起卡死。实测长边 1568px、JPEG 0.85 对模型识别足够清晰，单张通常只有
 *   几百 KB；0.7 是最后一级降质，仍超 2 MiB 就拒绝，不把大图塞给后端。
 */
const IMAGE_MAX_EDGE_PX = 1568;
const IMAGE_JPEG_QUALITY = 0.85;
const IMAGE_JPEG_QUALITY_RETRY = 0.7;
const IMAGE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * 发送闸门的兜底超时。
 *
 * ★ 建会话的请求在异常网络/后端卡住时可能一直不返回，闸门不释放的话之后
 *   所有发送都会被静默丢掉。到点自动放开；正常路径会提前释放并清掉定时器。
 */
const SEND_PENDING_TIMEOUT_MS = 20_000;

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

/**
 * 一次「已拼完参数」的工具调用碰了哪个文件。
 *
 * ★ 为什么在界面侧再解析一次 JSON：
 *   SSE 的 toolCall 参数是逐片到达的（partial:true），完成事件（partial:false）
 *   只带空 argsDelta，不带参数全文；参数全文只有界面自己按 callId 拼得出来。
 *   拿到全文后仍调用 core 的 primaryPathOf，保证「哪个参数算路径」只有一处规则。
 */
function aiOpOfToolCall(name: string, argsText: string): WorkPanelAiOp | null {
  if (name.length === 0) return null;
  const trimmed = argsText.trim();
  let args: unknown = {};
  if (trimmed.length > 0) {
    try {
      args = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  return primaryPathOf(name, args);
}

/**
 * 从 ApiError 的数据里取后端错误码。
 * ★ 用户取消外部文件选择框和真正的失败都是 HTTP 400，只有 code=dialog_failed
 *   能区分；只看状态码会把“用户点了取消”也报成错误。
 */
function apiErrorCodeOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const data = err.data;
  if (typeof data !== 'object' || data === null) return null;
  const code = (data as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : null;
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

/** data URL 解码后的近似字节数；2 MiB 是阈值，不要求逐位精确。 */
function dataUrlByteSize(url: string): number {
  const comma = url.indexOf(',');
  if (comma < 0) return 0;
  const body = url.slice(comma + 1);
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

/**
 * 把用户选的图片压成可发送的 data URL。
 *
 * ★ 为什么在浏览器里压：后端协议收的就是 data URL，不能改；只能在上传前
 *   把长边降到 {@link IMAGE_MAX_EDGE_PX}、转成 JPEG 0.85（透明图先铺白底，
 *   否则 JPEG 的透明区域会变成黑色），必要时再降到 0.7。
 * ★ 返回 null = 压到 0.7 仍超过 2 MiB；调用方提示换图，绝不发出去。
 */
async function compressImageToDataUrl(file: File): Promise<string | null> {
  // createImageBitmap 能按图片方向解码，且不占额外 Image 元素。
  const bitmap = await createImageBitmap(file);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > IMAGE_MAX_EDGE_PX ? IMAGE_MAX_EDGE_PX / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('浏览器不支持图片画布');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    let url = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
    if (dataUrlByteSize(url) > IMAGE_MAX_OUTPUT_BYTES) {
      url = canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY_RETRY);
    }
    return dataUrlByteSize(url) > IMAGE_MAX_OUTPUT_BYTES ? null : url;
  } finally {
    bitmap.close();
  }
}

/**
 * 把刚结束的一轮与 live 视图对齐。
 *
 * ★ 为什么不能直接 setMessages + 清空 liveTurns：
 *   服务端只持久化**成功完成**的一轮；失败/停止时历史里只有用户消息。
 *   无脑替换会把用户正看着的失败信息/已生成内容抹掉，或者让同一条用户
 *   消息在历史和实时视图里各出现一次。
 * ★ 这里按发送时刻把每一轮对到历史：
 *   · 已经完整落盘的轮次交给历史渲染 —— 轮次轨道/审查因此立刻看得到它；
 *   · 只有“最后一段还没落盘”的轮次继续留在 live 视图（live 永远渲染在
 *     历史之后，中间夹一轮会导致时间顺序错乱），并从历史里藏掉对应的用户消息。
 */
function reconcileLiveTurns(
  persisted: readonly MessageDto[],
  liveTurns: readonly LiveTurn[],
): { readonly messages: readonly MessageDto[]; readonly liveTurns: readonly LiveTurn[] } {
  if (liveTurns.length === 0) return { messages: persisted, liveTurns };

  // 第一遍：每一轮在历史里匹配哪条用户消息（-1 = 没匹配到）。
  const claimed = new Set<number>();
  const matchedIndices: number[] = [];
  for (const turn of liveTurns) {
    // 本机部署，前后端是同一个时钟；允许请求/写入的毫秒级偏差。
    // 取时间最近的一条，避免把本轮中途补充的消息误认成这一轮的开头。
    let matched = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < persisted.length; i += 1) {
      const message = persisted[i];
      if (message === undefined || message.role !== 'user' || claimed.has(i)) continue;
      const gap = message.createdAt - turn.startedAt;
      if (gap < -1_500 || gap > 120_000) continue;
      if (gap < bestGap) {
        bestGap = gap;
        matched = i;
      }
    }
    if (matched >= 0) claimed.add(matched);
    matchedIndices.push(matched);
  }

  // 第二遍：这一轮是否已完整落盘。窗口止于下一轮的用户消息：
  // 中途补充的消息也是 user，不能一见到 user 就认为本轮没有回复。
  const persistedFlags = liveTurns.map((_turn, index) => {
    const matched = matchedIndices[index] ?? -1;
    if (matched < 0) return false;
    let windowEnd = persisted.length;
    for (let next = index + 1; next < matchedIndices.length; next += 1) {
      const nextMatch = matchedIndices[next] ?? -1;
      if (nextMatch >= 0) {
        windowEnd = nextMatch;
        break;
      }
    }
    for (let i = matched + 1; i < windowEnd; i += 1) {
      const message = persisted[i];
      if (message !== undefined && isReviewAssistantMessage(message)) return true;
    }
    return false;
  });

  /**
   * 只保留末尾这段没落盘的轮次。
   * 更早的失败/停止轮如果留在 live，会被渲染到它们后面的历史消息之后；
   * 丢掉 live 后它的用户消息仍在历史里，和刷新页面看到的一致。
   */
  let suffixStart = liveTurns.length;
  for (let i = liveTurns.length - 1; i >= 0; i -= 1) {
    if (persistedFlags[i] === true) break;
    suffixStart = i;
  }

  const keptLive = liveTurns.slice(suffixStart);
  const hiddenMessageIds = new Set<string>();
  for (let i = suffixStart; i < liveTurns.length; i += 1) {
    const matched = matchedIndices[i] ?? -1;
    if (matched < 0) continue;
    const userMessage = persisted[matched];
    if (userMessage !== undefined) hiddenMessageIds.add(userMessage.id);
  }

  if (hiddenMessageIds.size === 0) return { messages: persisted, liveTurns: keptLive };
  return {
    messages: persisted.filter((message) => !hiddenMessageIds.has(message.id)),
    liveTurns: keptLive,
  };
}

export function ChatView({
  active,
  focusEnabled,
  focusMode = false,
  focusDrawerOpen,
  onFocusClose,
  onApprovalCountChange,
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
  /** 收尾刷新时用于判断“这次是否真的产出了新练习”。 */
  const quizzesRef = useRef<readonly QuizItem[]>([]);
  const [liveTurns, setLiveTurns] = useState<readonly LiveTurn[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  /** 图片压缩中：按钮禁用、发送拦截，避免同一张图被重复处理/带着旧附件发出去。 */
  const [imageProcessing, setImageProcessing] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<readonly PickableProfile[]>([]);
  const [ttsConfig, setTtsConfig] = useState<TtsConfig | null>(null);
  const [lastChatModel, setLastChatModel] = useState<ModelChoice | null>(null);
  const [chatModel, setChatModel] = useState<ModelChoice | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(true);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [activeReasoning, setActiveReasoning] = useState<ReasoningLevel>(DEFAULT_REASONING);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsTargetId, setSettingsTargetId] = useState<string | null>(null);
  /** 专注空间里的对话设置浮层：会话列表 + 每段对话的内嵌配置。 */
  const [focusSettingsOpen, setFocusSettingsOpen] = useState(false);
  const [focusSettingsView, setFocusSettingsView] = useState<'list' | 'config'>('list');
  const [focusConfigSessionId, setFocusConfigSessionId] = useState<string | null>(null);
  const focusSettingsRef = useRef<HTMLDivElement | null>(null);
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
  /**
   * 工作区面板展开：右栏占满主区域，对话变成浮动窗。
   * 它依附于 reviewOpen —— 面板关掉时由 effect 复位，避免留下不可见的“展开”状态。
   */
  const [panelMax, setPanelMax] = useState(false);
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
  /**
   * 右栏已打开的面板实例。
   * ★ 原来只有一个 paneTab 单值；多开后工作区面板各自保留目录/文件/草稿，
   *   当前显示哪一个由 activePaneId 决定，reviewOpen 只表示右栏整体是否可见。
   */
  const [panes, setPanes] = useState<readonly PaneInstance[]>(INITIAL_PANES);
  const [activePaneId, setActivePaneId] = useState<string>(INITIAL_ACTIVE_PANE_ID);
  /**
   * panes / activePaneId 的同步副本。
   * ★ SSE 回调是发送那一刻的旧闭包，读 state 拿不到用户中途新建的面板；
   *   ref 在每次写状态时同步更新，异步路径（AI 写文件自动开面板）才有最新列表。
   */
  const panesRef = useRef<readonly PaneInstance[]>(INITIAL_PANES);
  const activePaneRef = useRef<string>(INITIAL_ACTIVE_PANE_ID);
  /** 实例 id / 工作区编号：只增不减，关掉中间一个也不会和现有面板撞号。 */
  const paneSeqRef = useRef(1);
  const filePaneSeqRef = useRef(1);
  /** 外部文件 / 终端编号：各自递增；工作区编号语义不同，不能共用。 */
  const externalFileSeqRef = useRef(0);
  const terminalSeqRef = useRef(0);
  /** 选择框 / 启动请求在途：防止连点菜单重复弹框、重复起进程。 */
  const externalFileOpeningRef = useRef(false);
  const terminalOpeningRef = useRef(false);
  /**
   * 头部「面板」浮层菜单是否展开。
   * ★ 它只是菜单的显隐，与右栏 reviewOpen 解耦：菜单开着不代表面板开着。
   */
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  /**
   * 「新建」的二级浮层是否展开。
   * ★ 默认收起：新建是低频操作；展开后是「新建」行左侧的第二层卡片，不再往第三层飞。
   */
  const [panelCreateOpen, setPanelCreateOpen] = useState(false);
  /**
   * 二级浮层被视口左缘挤回来时向右推的像素数。
   * ★ 窗口够宽时恒为 0；窄窗口下把卡片整体往右挪，宁可压住主列表也不越出屏幕。
   */
  const [panelSubShift, setPanelSubShift] = useState(0);
  /** 菜单 id：只在展开时挂到 aria-controls 上，读屏能回到同一块弹层。 */
  const panelMenuId = useId();
  const panelCreateMenuId = useId();
  /** AI 最近一次完整工具调用碰到的文件；只用于工作区面板的自动打开/高亮。 */
  const [aiOp, setAiOp] = useState<WorkPanelAiOp | null>(null);

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
  const ttsAbortRef = useRef<AbortController | null>(null);
  const ttsCacheRef = useRef(new TtsBlobCache());
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsObjectUrlRef = useRef<string | null>(null);
  const voiceBaseRef = useRef('');
  const reviewAbortRef = useRef<AbortController | null>(null);
  /** 重新打开面板时，是否等历史加载完再恢复最近一条 completed。 */
  const reviewAutoRestoreRef = useRef(false);
  /** 防止旧会话的历史请求覆盖新会话列表。 */
  const reviewHistorySeqRef = useRef(0);
  /** 抽屉开关按钮 / 抽屉关闭按钮：用于打开时送入焦点、关闭后还回焦点。 */
  const reviewHistoryToggleRef = useRef<HTMLButtonElement | null>(null);
  const reviewHistoryCloseRef = useRef<HTMLButtonElement | null>(null);
  /** 面板浮层菜单：容器用来判断点击是否落在菜单外，按钮用于关闭后归还焦点。 */
  const panelMenuRef = useRef<HTMLDivElement | null>(null);
  const panelMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  /** 「新建」行：二级浮层收起后把焦点还给它，键盘用户不会掉回 body。 */
  const panelCreateButtonRef = useRef<HTMLButtonElement | null>(null);
  /**
   * 这次展开是否由键盘触发（Enter/Space 合成的 click，detail 为 0）。
   * ★ 只有键盘打开才把焦点送进第一项：鼠标打开也抢焦点的话，
   *   第一项（工作区 1）会亮起绿色 focus ring，看起来像“已被默认选中”，
   *   和右侧表示当前面板的 ✓ 混淆。
   */
  const panelMenuKeyboardOpenRef = useRef(false);
  /**
   * 工具参数分片按 callId 累积。
   * 完成事件只带空 argsDelta，必须靠这份拼接结果才能解析出完整参数。
   */
  const toolArgsRef = useRef<Map<string, string>>(new Map());
  /**
   * 已经解析出路径、但还在执行的工具调用。
   * 写文件的 toolCall 事件在真正落盘**之前**就发出，所以必须等 toolResult
   * 回来再推一次 aiOp，面板才会重新拉取到写完后的内容。
   */
  const pendingAiOpsRef = useRef<Map<string, WorkPanelAiOp>>(new Map());
  const atBottomRef = useRef(true);
  /**
   * 只在用户主动发送 / 打开会话时置 true：流式增量不能把正在回看的用户拽回底部。
   * 消费它的 effect 会立刻复位，所以它表达的是“这一次变更必须贴底”。
   */
  const forceScrollRef = useRef(true);
  /** 草稿防抖定时器（window.setTimeout 的 id）；null 表示没有在等。 */
  const draftTimerRef = useRef<number | null>(null);
  /**
   * 还没落盘的草稿；null 表示没有待写内容（空串仍要写，用来清掉旧草稿）。
   *
   * ★ 必须连 key 一起记：切换会话后 pending 仍属于上一个会话，
   *   只按当前 sessionId 写盘会把旧会话的草稿写进新会话。
   */
  const pendingDraftRef = useRef<{ readonly key: string; readonly text: string } | null>(null);
  /**
   * 正在切换/新建会话的过渡期：此时 input 还属于旧会话，
   * 禁止草稿 effect 按新 sessionId 写盘（会串 key）。
   */
  const draftSwitchRef = useRef(false);
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
  /** 闸门令牌 / 兜底释放定时器：超时释放后，迟到的 finally 不能再动新一轮的闸门。 */
  const sendPendingTokenRef = useRef<object | null>(null);
  const sendPendingTimerRef = useRef<number | null>(null);
  /** 图片压缩中（ref 给事件处理器用：连点/粘贴时 state 可能还没刷新）。 */
  const imageProcessingRef = useRef(false);
  /** liveTurns 的最新值：异步收尾刷新里读 state 闭包会拿到旧数组。 */
  const liveTurnsRef = useRef<readonly LiveTurn[]>([]);
  /** 收尾刷新的序号：只允许最后一次请求落盘，避免旧响应覆盖新会话。 */
  const historyRefreshSeqRef = useRef(0);
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

  /**
   * 只有“面板开着 + 点了展开”才进入浮窗布局。
   * reviewOpen 在跳轮次 / 切会话时也会变 false，用这个派生值兜底，
   * 避免出现没有面板却仍按浮窗排版的中间态。
   */
  const panelExpanded = reviewOpen && panelMax;
  const chatFloat = useChatFloat(sessionId, panelExpanded, chatBodyRef);

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
  /**
   * 没有任何可审查 / 可展示的审查内容。
   *
   * ★ 旧版头部按钮还要兼作“关闭”，所以只在面板关着时禁用；现在收起只由头部 × 负责，
   *   面板开着也不该留一个点了只弹提示的死入口——有没有内容才决定能不能点。
   */
  const reviewUnavailable =
    lastReviewable === null &&
    reviewHistory.length === 0 &&
    reviewRun === null &&
    !reviewBusy &&
    !reviewStopped &&
    reviewError === null;
  /**
   * 当前激活的面板实例。
   * ★ activePaneId 可能指向一个刚被关掉的 id，所以回退到列表第一项；
   *   列表为空时才是 null（此时 reviewOpen 一定是 false）。
   */
  const activePane = panes.find((pane) => pane.id === activePaneId) ?? panes[0] ?? null;
  /**
   * 当前激活面板的 kind：CSS 的 is-work / is-browser / is-review 仍按它切换。
   * ★ 只作为派生值，不再有 setPaneTab —— 否则多开面板又会退回“全局一个页签”的旧逻辑。
   */
  const paneTab: PaneKind = activePane?.kind ?? 'files';
  /** 练习面板当前是否正显示在右栏。 */
  const quizPaneOpen = reviewOpen && paneTab === 'study';
  /*
   * ★ 分体按钮不再派生面板名：文案会随「工作区 10」变长而挤压标题，
   *   当前在哪一栏改由列表里的勾选表达，按钮只负责“显隐”这一件事。
   */
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
   * ★ 用稳定闭包：不能等 React 下一次渲染才知道当前是否在流式执行，
   *   否则「steer 失败后重发」等回调会在流式中途把页面状态弄乱。
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
      setTtsConfig(res.tts ?? null);
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

  // 从设置页返回对话时重新读取模型角色，TTS 配置刚改完也能立刻生效。
  const wasActiveRef = useRef(active);
  useEffect(() => {
    if (active && !wasActiveRef.current) void loadModelCatalog();
    wasActiveRef.current = active;
  }, [active, loadModelCatalog]);

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

  /**
   * 面板浮层菜单：点击菜单外部关闭，Esc 关闭并把焦点还给触发按钮。
   * ★ Esc 必须归还焦点：菜单项随菜单一起卸载，否则焦点掉回 body，
   *   键盘用户要重新 Tab 一整圈才能回到头部。
   * ★ 点外用 mousedown 而不是 click：点在别的按钮上时先关菜单，
   *   那一次点击仍然落在用户真正点的元素上，不会被弹层吃掉。
   */
  useEffect(() => {
    if (!panelMenuOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (
        panelMenuRef.current !== null &&
        event.target instanceof Node &&
        !panelMenuRef.current.contains(event.target)
      ) {
        setPanelMenuOpen(false);
        // 二级浮层跟着整个列表一起收：下次打开仍从「新建」收起态开始。
        setPanelCreateOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Esc 只关菜单、不动右栏：焦点回到箭头，键盘用户不用重新 Tab 一圈。
      setPanelMenuOpen(false);
      setPanelCreateOpen(false);
      panelMenuButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [panelMenuOpen]);

  /**
   * 只有键盘打开（Enter/Space，click detail === 0）才把焦点送进第一个可用项。
   * ★ 鼠标打开不抢焦点：焦点留在触发按钮上，第一项不会亮起绿色 focus ring，
   *   用户直接点菜单项即可。Esc 的归焦逻辑不依赖这里，保持不变。
   */
  useEffect(() => {
    if (!panelMenuOpen) return;
    if (!panelMenuKeyboardOpenRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      panelMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panelMenuOpen]);

  /**
   * 二级浮层开着时窗口变窄：重新算一次“向内收”的距离。
   * ★ 只监听窗口 resize（不用 ResizeObserver）：浮层尺寸由 CSS 固定，
   *   位置只跟视口有关，监听窗口足够，也不会自己触发自己。
   */
  useEffect(() => {
    if (!panelMenuOpen || !panelCreateOpen) return;
    const onResize = (): void => updatePanelSubShift();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [panelMenuOpen, panelCreateOpen]);

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
    quizzesRef.current = quizzes;
  }, [quizzes]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    liveTurnsRef.current = liveTurns;
  }, [liveTurns]);

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
    writeDraftText(pending.key, pending.text);
  }, []);

  /**
   * 丢弃指定会话的草稿并取消待写内容。
   *
   * ★ 发送成功后必须连定时器一起取消：否则 300ms 后旧草稿会被重新写回，
   *   下次打开空白会话又看见刚发出去的内容。
   * ★ key 由调用方按“发送开始时的会话”算：ensureSession 之后当前会话可能
   *   已经变成新建的那一个，用此刻的 sessionId 会清错 key。
   */
  const discardDraft = useCallback((key: string): void => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    pendingDraftRef.current = null;
    clearDraftText(key);
  }, []);

  /**
   * 草稿只在空白新会话（或还没有会话）里保存。
   *
   * ★ 300ms 合并写盘：中文输入法长句时，逐字符同步写 localStorage 会卡候选窗。
   * ★ 切换会话期间不写：这时 input 还是旧会话的文字，按新 sessionId 写会
   *   把 A 的草稿落到 B 的 key 下。
   */
  useEffect(() => {
    if (draftSwitchRef.current) return;
    // 首屏还没决定落到哪个会话：此时 input 是空的，写盘会把兜底草稿清掉。
    if (sessionId === null && !bootDoneRef.current) return;
    if (sessionId !== null && !isDraftSession) return;
    pendingDraftRef.current = { key: draftStorageKey(sessionId), text: input };
    if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      flushDraft();
    }, DRAFT_WRITE_DEBOUNCE_MS);
  }, [flushDraft, input, isDraftSession, sessionId]);

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

  /**
   * AI 操作提示只保留一个短窗口：横幅由面板自己计时，这里把状态也清掉，
   * 避免用户几分钟后才切到「工作区」页签时看到一条早已结束的「AI 正在…」。
   */
  useEffect(() => {
    if (aiOp === null) return;
    const timer = window.setTimeout(() => setAiOp(null), 8000);
    return () => window.clearTimeout(timer);
  }, [aiOp]);

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

  /**
   * 把面板列表写入 state，同时同步 ref。
   * ★ 所有写入都走这里，异步回调（SSE）才总能读到最新列表。
   */
  function commitPanes(next: readonly PaneInstance[]): void {
    panesRef.current = next;
    setPanes(next);
  }

  /** 新建一个工作区 / 浏览器 / 审查实例（只构造对象，不写状态）。 */
  function createPane(kind: 'files' | 'browser' | 'review'): PaneInstance {
    paneSeqRef.current += 1;
    if (kind === 'files') {
      filePaneSeqRef.current += 1;
      return {
        id: `pane-${paneSeqRef.current}`,
        kind,
        label: `工作区 ${filePaneSeqRef.current}`,
      };
    }
    return {
      id: `pane-${paneSeqRef.current}`,
      kind,
      label: kind === 'browser' ? '浏览器' : '审查',
    };
  }

  /** 新建外部文件实例：编号「文件 1、文件 2…」递增。 */
  function createExternalFilePane(file: ExternalFileHandleDto): PaneInstance {
    paneSeqRef.current += 1;
    externalFileSeqRef.current += 1;
    return {
      id: `pane-${paneSeqRef.current}`,
      kind: 'external-file',
      label: `文件 ${externalFileSeqRef.current}`,
      externalFile: file,
    };
  }

  /**
   * 新建终端实例。
   * ★ 启动失败也建实例：错误要留在面板里，而不是一条会自动消失的 toast。
   */
  function createTerminalPane(
    terminal: TerminalSessionInfo | null,
    errorText: string | null,
  ): PaneInstance {
    paneSeqRef.current += 1;
    terminalSeqRef.current += 1;
    const pane = {
      id: `pane-${paneSeqRef.current}`,
      kind: 'terminal' as const,
      label: `终端 ${terminalSeqRef.current}`,
    };
    return terminal !== null
      ? { ...pane, terminal }
      : { ...pane, terminalError: errorText ?? '终端启动失败' };
  }

  /** 学习面板是会话级单实例：不复制题目，只承载当前会话的 quizzes。 */
  function createStudyPane(): PaneInstance {
    paneSeqRef.current += 1;
    return { id: `pane-${paneSeqRef.current}`, kind: 'study', label: '学习' };
  }

  function openStudyPane(): void {
    const existing = panesRef.current.find((pane) => pane.kind === 'study');
    showPane(existing ?? createStudyPane());
  }

  /**
   * 激活一个面板实例（不在列表里就先加入），并显示右栏。
   * ★ 浏览器/审查“单实例”由调用方保证；这里只负责“实例存在 + 选中 + 右栏可见”。
   */
  function showPane(pane: PaneInstance): void {
    if (!panesRef.current.some((item) => item.id === pane.id)) {
      commitPanes([...panesRef.current, pane]);
    }
    activePaneRef.current = pane.id;
    setActivePaneId(pane.id);
    setReviewOpen(true);
  }

  /**
   * 找“当前该用的工作区面板”：激活的本来就是工作区面板时沿用，否则用第一个，都没有才新建。
   * ★ AI 写文件时要落到用户当前看的工作区面板里，而不是永远跳回工作区 1。
   */
  function ensureFilesPane(): PaneInstance {
    const current = panesRef.current;
    const active = current.find((pane) => pane.id === activePaneRef.current);
    return active?.kind === 'files'
      ? active
      : (current.find((pane) => pane.kind === 'files') ?? createPane('files'));
  }

  /**
   * 进入审查面板前补一次范围 / 历史恢复。
   *
   * ★ “收起右栏”会重置 reviewAutoRestoreRef；重新激活已有实例时如果只 showPane，
   *   那次落在历史列表上的恢复就再也不会发生。新建与重新激活都走这里，行为才一致。
   * ★ 不负责“能不能进”：已有面板即使暂时没有内容也要能进去看空态，
   *   可用性判断留给新建分支。
   */
  function prepareReviewRestore(): void {
    const hasReviewView =
      reviewRun !== null ||
      reviewBusy ||
      reviewStopped ||
      reviewError !== null ||
      reviewProcess.rounds.length > 0;
    if (hasReviewView) return;
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

  /**
   * 打开审查面板。
   *
   * ★ 单实例：已有实例时直接进入，即使暂时没有可审查内容，也让它显示空态；
   *   只有真的要新建实例时才做“没有内容就提示”的判断。
   */
  function openReview(): void {
    const existing = panesRef.current.find((pane) => pane.kind === 'review');
    if (existing !== undefined) {
      setReviewPickerOpen(false);
      setPanelMax(false);
      // 手动打开时不重放上一次 AI 操作（与原 openWorkspace 的语义一致）。
      if (!reviewOpen) setAiOp(null);
      prepareReviewRestore();
      showPane(existing);
      return;
    }
    const hasReviewView =
      reviewRun !== null ||
      reviewBusy ||
      reviewStopped ||
      reviewError !== null ||
      reviewProcess.rounds.length > 0;
    if (!hasReviewView && lastReviewable === null && reviewHistory.length === 0) {
      notify('还没有可审查的完成或中断轮次', 'warning');
      return;
    }
    prepareReviewRestore();
    setReviewPickerOpen(false);
    setPanelMax(false);
    if (!reviewOpen) setAiOp(null);
    showPane(createPane('review'));
  }

  /**
   * 收起右栏（分体按钮主体、关掉最后一个面板都走这里）。
   * ★ 只改 reviewOpen：面板实例与审查结果都保留，下次打开原样回来。
   */
  function closeReview(): void {
    // ★ 只收起面板：不清结果/过程/历史，也不 abort 仍在跑的审查。
    reviewAutoRestoreRef.current = false;
    setReviewPickerOpen(false);
    setReviewHistoryOpen(false);
    // 面板收起后 AI 提示不再有意义，清掉避免下次打开时显示很久以前的操作。
    setAiOp(null);
    setReviewOpen(false);
  }

  /**
   * 打开工作区：优先激活已有的工作区面板，没有才新建。
   * ★ 多开后“打开工作区”不再等于新建；要再加一个工作区走 openNewWorkspacePane。
   * ★ AI 自动打开不走这里（这里会清 aiOp），而是 ensureFilesPane + showPane。
   */
  function openWorkspace(): void {
    // 手动打开时不重放上一次 AI 操作：只有面板开着时收到的 aiOp 才用于自动打开。
    if (!reviewOpen) setAiOp(null);
    // 工作区面板没有全屏入口：从浏览器最大化切过来时必须还原，否则缩不回去。
    setPanelMax(false);
    showPane(ensureFilesPane());
  }

  /** 新建工作区面板：总是新建一个实例（工作区 1、工作区 2…编号递增），并激活。 */
  function openNewWorkspacePane(): void {
    if (!reviewOpen) setAiOp(null);
    // 新面板从普通分栏开始：浏览器全屏状态下新建工作区面板，用户会看不到它。
    setPanelMax(false);
    showPane(createPane('files'));
  }

  /**
   * 打开浏览器：单实例 —— 已有就激活，没有才创建。
   * ★ 这里不重置 panelMax：浏览器最大化由面板自己的全屏按钮控制，保持现状。
   */
  function openBrowser(): void {
    if (!reviewOpen) setAiOp(null);
    const existing = panesRef.current.find((pane) => pane.kind === 'browser');
    showPane(existing ?? createPane('browser'));
  }

  /**
   * 打开工作区外的文件。
   * ★ 原生选择框由服务端弹（浏览器拿不到真实路径），用户取消时回 400
   *   code=dialog_failed：这是用户意图，不是错误——只给一句轻提示，不建面板、不弹错误框。
   * ★ 选择框是窗口模态的，期间用户可能切走会话：旧会话的句柄不能挂到新会话界面上。
   */
  async function openExternalFile(): Promise<void> {
    if (externalFileOpeningRef.current) return;
    externalFileOpeningRef.current = true;
    try {
      const currentSessionId = sessionIdRef.current;
      const targetSessionId = currentSessionId ?? (await ensureSession('无法打开外部文件'));
      if (targetSessionId === null) return;
      if (!reviewOpen) setAiOp(null);
      setPanelMax(false);
      try {
        const res = await postJson<OpenExternalFileResponse>('/api/files/open-dialog', {
          sessionId: targetSessionId,
        });
        if (sessionIdRef.current !== targetSessionId) {
          void postJson('/api/files/close', {
            handle: res.file.id,
            sessionId: targetSessionId,
          }).catch(() => {});
          notify('会话已切换，文件没有打开', 'warning');
          return;
        }
        showPane(createExternalFilePane(res.file));
      } catch (err) {
        if (apiErrorCodeOf(err) === 'dialog_failed') {
          notify('已取消选择文件', 'default');
          return;
        }
        notify(errorMessage(err), 'danger');
      }
    } finally {
      externalFileOpeningRef.current = false;
    }
  }

  /**
   * 打开终端：可多开，每次起一个独立的 shell 会话。
   * ★ 启动失败也要有可见落点：创建一个带错误态的终端面板，原因留在面板里，
   *   而不是一条会自动消失、用户可能没看见的提示。
   */
  async function openTerminal(): Promise<void> {
    if (terminalOpeningRef.current) return;
    terminalOpeningRef.current = true;
    try {
      const currentSessionId = sessionIdRef.current;
      const targetSessionId = currentSessionId ?? (await ensureSession('无法启动终端'));
      if (targetSessionId === null) return;
      if (!reviewOpen) setAiOp(null);
      setPanelMax(false);
      try {
        const res = await postJson<StartTerminalResponse>('/api/terminal', {
          sessionId: targetSessionId,
        });
        if (sessionIdRef.current !== targetSessionId) {
          void postJson('/api/terminal/close', {
            id: res.terminal.id,
            sessionId: targetSessionId,
          }).catch(() => {});
          notify('会话已切换，终端没有打开', 'warning');
          return;
        }
        showPane(createTerminalPane(res.terminal, null));
      } catch (err) {
        if (sessionIdRef.current !== targetSessionId) {
          notify(errorMessage(err), 'danger');
          return;
        }
        showPane(createTerminalPane(null, errorMessage(err)));
      }
    } finally {
      terminalOpeningRef.current = false;
    }
  }

  /**
   * 切换当前面板（列表里的实例项）。
   * ★ 切去非浏览器面板时退出浏览器全屏，否则 .is-panel-max 会把布局留在浮窗模式。
   * ★ 审查要额外补范围 / 历史恢复，统一走 openReview；已经停在当前项则什么都不做。
   */
  function activatePane(id: string): void {
    const pane = panesRef.current.find((item) => item.id === id);
    if (pane === undefined) return;
    // 等价旧版菜单项对“当前视图”的提前返回：点自己不会重放恢复逻辑。
    if (reviewOpen && activePaneRef.current === pane.id) return;
    if (!reviewOpen) setAiOp(null);
    if (pane.kind === 'review') {
      openReview();
      return;
    }
    if (pane.kind !== 'browser') setPanelMax(false);
    showPane(pane);
  }

  /**
   * 关闭一个面板实例。
   * ★ 关掉当前激活项时自动切到相邻项（优先左边那个）；关完最后一个等价于收起右栏。
   * ★ 不 abort 正在跑的审查：和收起一样，已收到的结果/过程保留在内存里，重新打开还能看。
   */
  function closePane(id: string): void {
    const current = panesRef.current;
    const index = current.findIndex((pane) => pane.id === id);
    if (index < 0) return;
    const closing = current[index];
    const next = current.filter((pane) => pane.id !== id);
    // 一个实例都不剩时编号归零：下次打开还是工作区 1，不会留下一个突兀的工作区 3。
    if (next.length === 0) {
      paneSeqRef.current = 0;
      filePaneSeqRef.current = 0;
      externalFileSeqRef.current = 0;
      terminalSeqRef.current = 0;
    }
    commitPanes(next);
    if (closing?.kind === 'browser') setPanelMax(false);
    if (activePaneRef.current !== id) {
      refocusPanelMenuAfterClose(activePaneRef.current);
      return;
    }
    const candidate = next[Math.max(0, index - 1)] ?? next[0];
    if (candidate === undefined) {
      closeReview();
      refocusPanelMenuAfterClose(null);
      return;
    }
    activePaneRef.current = candidate.id;
    setActivePaneId(candidate.id);
    refocusPanelMenuAfterClose(candidate.id);
  }

  /**
   * 关闭面板后 × 按钮会随行卸载：把焦点交给新的激活项（没有就交给列表第一项），
   * 键盘用户不会因为一次关闭掉回 body、再 Tab 一整圈才能回来。
   */
  function refocusPanelMenuAfterClose(paneId: string | null): void {
    window.requestAnimationFrame(() => {
      const root = panelMenuRef.current;
      const target =
        root === null
          ? // 菜单没开（例如点了面板头部自带的关闭按钮）：把焦点交给分体按钮，
            // 不让它掉回 body；菜单开着时优先落到相邻面板，其次第一项。
            panelMenuButtonRef.current
          : (paneId === null
              ? null
              : root.querySelector<HTMLButtonElement>(`[data-pane-id="${paneId}"]`)) ??
            root.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      target?.focus();
    });
  }

  /**
   * 分体按钮主体：切换右栏显隐。
   * ★ 收起只改 reviewOpen，面板实例留在列表里；再点开还是原来那一栏。
   * ★ 一个实例都没有时先建工作区面板，避免打开一条什么都没有的空栏。
   */
  function togglePaneVisibility(): void {
    // 主体按钮会改变右栏显隐，浮层没必要继续压着内容。
    setPanelMenuOpen(false);
    setPanelCreateOpen(false);
    if (reviewOpen) {
      closeReview();
      return;
    }
    const target =
      panesRef.current.find((pane) => pane.id === activePaneRef.current) ?? panesRef.current[0];
    if (target === undefined) {
      openWorkspace();
      return;
    }
    // 手动打开不重放上一次 AI 操作；浏览器全屏状态只属于浏览器面板。
    setAiOp(null);
    if (target.kind !== 'browser') setPanelMax(false);
    showPane(target);
  }

  /**
   * 切换会话时的面板重置。
   * ★ 浏览器 / 审查是“上一个会话的现场”（标签页、审查结果），切走后删除实例；
   *   外部文件 / 终端按会话登记（句柄与进程），也必须删除——组件卸载时会调 close。
   *   工作区面板保留：用户可能只是换个会话继续看同一批文件，删掉会丢目录状态。
   * ★ 至少留一个工作区面板，下次打开右栏不会是一条空栏。
   */
  function resetPanesForSession(): void {
    const current = panesRef.current;
    const files = current.filter((pane) => pane.kind === 'files');
    // 外部文件 / 终端编号跟着实例一起归零，新会话里从 1 开始。
    externalFileSeqRef.current = 0;
    terminalSeqRef.current = 0;
    // 一个工作区都没留下时编号也归零，新会话里第一个面板才是「工作区 1」。
    if (files.length === 0) filePaneSeqRef.current = 0;
    const next = files.length > 0 ? files : [createPane('files')];
    commitPanes(next);
    const active = next.find((pane) => pane.id === activePaneRef.current) ?? next[0];
    if (active !== undefined) {
      activePaneRef.current = active.id;
      setActivePaneId(active.id);
    }
    setPanelMax(false);
  }

  /**
   * 菜单项的统一收尾：先关菜单、把焦点还给触发按钮，再执行动作。
   * ★ 菜单项会随菜单卸载，不先归还焦点的话焦点会掉回 body，键盘用户丢失位置。
   */
  function runPanelMenuItem(action: () => void): void {
    setPanelMenuOpen(false);
    // 二级浮层也一起收：否则下次打开列表会直接停在展开态。
    setPanelCreateOpen(false);
    panelMenuButtonRef.current?.focus();
    action();
  }

  /**
   * 算二级浮层要不要往右让：它从「新建」行左侧展开，窄窗口会顶出视口左缘。
   * ★ 基准位置用「新建」行的矩形算，不量二级浮层自己的 rect：
   *   已经推过的位置再量会把偏移算进去，推一次、收一次来回抖。
   */
  function updatePanelSubShift(): void {
    const row = panelMenuRef.current?.querySelector<HTMLElement>('.panel-menu-new');
    if (row === null || row === undefined) {
      setPanelSubShift(0);
      return;
    }
    const baseLeft = row.getBoundingClientRect().left - PANEL_FLYOUT_GAP - PANEL_MENU_WIDTH;
    setPanelSubShift(Math.max(0, Math.ceil(PANEL_VIEWPORT_EDGE - baseLeft)));
  }

  /** 展开二级浮层后把焦点送进第一个可用项（工作区永远可用，禁用的审查会被跳过）。 */
  function focusFirstCreateItem(): void {
    window.requestAnimationFrame(() => {
      panelMenuRef.current
        ?.querySelector<HTMLButtonElement>('.panel-menu-sub [role="menuitem"]:not(:disabled)')
        ?.focus();
    });
  }

  /**
   * 「新建」行：展开 / 收起二级浮层。
   * ★ 鼠标展开不抢焦点（detail > 0），键盘展开（Enter/Space，detail === 0）才把焦点送进第一项：
   *   鼠标点一下就亮起 focus ring，会让人误以为「工作区」已经被选中。
   */
  function togglePanelCreateMenu(focusFirst: boolean): void {
    if (panelCreateOpen) {
      setPanelCreateOpen(false);
      return;
    }
    // 先算位置再挂载：第一帧就落在视口内，不会先溢出再跳回来。
    updatePanelSubShift();
    setPanelCreateOpen(true);
    if (focusFirst) focusFirstCreateItem();
  }

  /**
   * 「新建」行的键盘操作：→ 展开并进第一项，← 收起。
   * ★ Enter/Space 走 button 自带的 click（detail === 0），由 onClick 统一判断，
   *   这里不重复处理，否则一次按键会展开后立刻又被收起。
   */
  function handlePanelCreateKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (!panelCreateOpen) {
        updatePanelSubShift();
        setPanelCreateOpen(true);
      }
      focusFirstCreateItem();
      return;
    }
    if (event.key === 'ArrowLeft' && panelCreateOpen) {
      event.preventDefault();
      setPanelCreateOpen(false);
    }
  }

  /**
   * 二级浮层里的 ← ：收起并把焦点还给「新建」行。
   * ★ 先聚焦再收起：二级项会随状态卸载，顺序反过来焦点就掉回 body。
   */
  function handlePanelCreateSubKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft') return;
    event.preventDefault();
    panelCreateButtonRef.current?.focus();
    setPanelCreateOpen(false);
  }

  /**
   * role="menu" 的键盘约定：上下键在可用项间循环，Home/End 跳到首尾。
   * ★ 打开时焦点已在第一项（见上面的 effect），这里只负责在菜单内部移动；
   *   二级浮层展开后它的五项也在同一串里，↓ 可以从「新建」直接走进「工作区」。
   * ★ 禁用的「审查」不参与循环，避免焦点停在一个点不动的项上。
   */
  function handlePanelMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? current < 0
              ? 0
              : (current + 1) % items.length
            : current < 0
              ? items.length - 1
              : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  /**
   * 浏览器「发给管家」：只把整理好的问题填进输入框，绝不自动发送。
   *
   * ★ 页面正文是不可信输入，发不发、要不要补充，得由用户看过再决定。
   * ★ 展开模式下对话是浮窗、还可能被收成气泡：先把它还原出来，
   *   否则文字填进的是一个看不见的输入框，用户会以为按钮没反应。
   */
  /**
   * 浏览器截图 → 图片附件 + 提问草稿。
   * ★ 只填不发：截图可能包含隐私内容，发不发由用户按发送键决定。
   */
  function attachBrowserScreenshot(dataUrl: string, text: string): void {
    setAttachments((prev) =>
      prev.length >= MAX_IMAGES
        ? prev
        : [...prev, { name: `浏览器截图-${Date.now()}.png`, url: dataUrl }],
    );
    if (input.trim().length === 0) setInput(text);
    if (panelExpanded && chatFloat.collapsed) {
      chatFloat.restore();
      return;
    }
    textareaRef.current?.focus();
  }

  function sendBrowserPageToButler(text: string): void {
    setInput(text);
    if (panelExpanded && chatFloat.collapsed) {
      chatFloat.restore();
      // 还原后的浮窗要等 React 提交才可见，这里不抢先 focus（隐藏元素 focus 不生效）。
      return;
    }
    // 填完把焦点还给输入框，用户可以直接补一句问题再回车。
    textareaRef.current?.focus();
  }

  /** 收起历史抽屉，并把焦点还给入口按钮。 */
  function closeReviewHistory(): void {
    setReviewHistoryOpen(false);
    reviewHistoryToggleRef.current?.focus();
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
    // 过渡期先关掉草稿写盘：此刻 input 还是上一个会话的文字。
    // 等新会话的草稿读进 composer 之后再恢复（见下方 finally）。
    draftSwitchRef.current = true;
    setCurrentId(id);
    sessionIdRef.current = id;
    setApprovals([]);
    setSettingsError(null);
    setSettingsTargetId(null);
    setReviewOpen(false);
    setReviewRange(null);
    setReviewAnchor(null);
    setReviewPickerOpen(false);
    // 工作区面板跟会话走：切换会话后不能还显示上一个工作区的 AI 操作。
    setAiOp(null);
    // 浏览器 / 审查是上一个会话的现场：删除实例；工作区面板保留（见函数注释）。
    resetPanesForSession();
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
      // 草稿按会话分开读；只在空白会话里恢复（沿用原有产品行为）。
      draftSwitchRef.current = false;
      setInput(res.messages.length === 0 ? readDraftText(draftStorageKey(id)) : '');
      return { ok: true, error: null };
    } catch (err) {
      if (token !== loadSeqRef.current) return { ok: false, error: null };
      const message = errorMessage(err);
      setSessionError(message);
      return { ok: false, error: message };
    } finally {
      if (token === loadSeqRef.current) {
        draftSwitchRef.current = false;
        setLoadingSession(false);
      }
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

  const refreshCancellations = useCallback(async (id: string): Promise<void> => {
    try {
      const res = await fetchJson<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}`);
      setCancellations(res.cancellations ?? []);
    } catch {
      // 取消回执是旁路：读不到不覆盖主对话状态
    }
  }, []);

  const createNewChat = useCallback(async (): Promise<void> => {
    // 记下出发点：从「还没有会话」新建时，兜底草稿要跟着搬进新会话。
    const originSessionId = sessionIdRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    updateStreaming(false);
    setApprovals([]);
    try {
      const res = await postJson<SessionCreateResponse>('/api/sessions', {});
      applySummary(res.session);
      // 过渡期禁止草稿写盘：旧会话的文字不能落到新会话的 key 下。
      draftSwitchRef.current = true;
      setCurrentId(res.session.id);
      sessionIdRef.current = res.session.id;
      // 新对话默认 high / 记忆 on（由后端会话投影给出，不在前端另写一套）。
      syncActiveSettings(res.session);
      setSettingsError(null);
      setSettingsTargetId(null);
      setMessages([]);
      // 新建空白会话会把草稿带回 composer：先落盘，别读到防抖窗口里的旧值。
      flushDraft();
      draftSwitchRef.current = false;
      /**
       * 每个会话只读自己的草稿 key（不会再把上一个会话的草稿带进来）。
       * 例外：从「还没有会话」新建时，兜底草稿本来就是这段输入的家，
       * 把它搬进新会话并清掉兜底 key，否则刚打的字会从 composer 里消失。
       */
      const fallbackKey = draftStorageKey(null);
      const carried = originSessionId === null ? readDraftText(fallbackKey) : '';
      if (carried.length > 0) clearDraftText(fallbackKey);
      setInput(
        carried.length > 0 ? carried : readDraftText(draftStorageKey(res.session.id)),
      );
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
      // 新对话是新的工作区，不能继承上一个会话的 AI 操作提示。
      setAiOp(null);
      // 浏览器 / 审查属于上一个会话的现场：新会话里不保留实例；工作区面板保留。
      resetPanesForSession();
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
        } else {
          // 一个会话都没有：composer 属于「无会话」，恢复兜底草稿。
          setInput(readDraftText(draftStorageKey(null)));
        }
        bootDoneRef.current = true;
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
  }, [loadSession, onBootState, refreshSessionIndex]);

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

  /**
   * 展开 / 还原 / 收起会改变消息区高度。
   * 原本贴底的话要把最后一条重新贴回可视区底部，否则缩高后看起来像“跳到了上一屏”。
   */
  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    setPinnedToBottom(true);
  }, [panelExpanded, chatFloat.collapsed]);

  useEffect(() => {
    if (!active || !focusEnabled) return;
    textareaRef.current?.focus();
  }, [active, focusEnabled]);

  /**
   * 进入专注抽屉时收起右栏与浮层菜单。
   *
   * ★ 专注抽屉只保留对话本身：工作区 / 浏览器 / 审查这些面板
   *   在 460px 的抽屉里没有意义，也会破坏“只有时间和当前安排”的画面。
   */
  useEffect(() => {
    if (!focusMode) return;
    setReviewOpen(false);
    setPanelMax(false);
    setPanelMenuOpen(false);
    setPanelCreateOpen(false);
    setReviewHistoryOpen(false);
    setReviewPickerOpen(false);
    setFocusSettingsOpen(false);
    recognitionRef.current?.abort();
    setListening(false);
  }, [focusMode]);

  // 专注设置浮层里按 Esc 只关它，不继续冒泡去关抽屉或退出专注。
  useEffect(() => {
    if (!focusSettingsOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        setFocusSettingsOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const root = focusSettingsRef.current;
      if (root === null) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const active = document.activeElement;
      // 模型浮层 portal 在 root 之外，Tab 交给它自己处理。
      if (active instanceof Element && active.closest('.session-controls-pop') !== null) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [focusSettingsOpen]);

  // 浮层收起后回到会话列表，下次打开不直接落在某段对话的配置里。
  useEffect(() => {
    if (focusSettingsOpen) return;
    setFocusSettingsView('list');
    setFocusConfigSessionId(null);
  }, [focusSettingsOpen]);

  // 左抽屉被外层收起（点空白、切到日程等）时，内部的设置浮层不能留着。
  useEffect(() => {
    if (focusMode && focusDrawerOpen === false) setFocusSettingsOpen(false);
  }, [focusDrawerOpen, focusMode]);

  // 审批数量交给外层：专注空间里一旦出现待审批工具，就把左抽屉露出来。
  useEffect(() => {
    onApprovalCountChange?.(approvals.length);
  }, [approvals.length, onApprovalCountChange]);

  useEffect(() => {
    setVoiceSupported(speechRecognitionCtor() !== null);
    setTtsSupported(typeof window !== 'undefined' && 'speechSynthesis' in window);
    return () => {
      recognitionRef.current?.abort();
      ttsAbortRef.current?.abort();
      if (ttsAudioRef.current !== null) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current.src = '';
        ttsAudioRef.current = null;
      }
      if (ttsObjectUrlRef.current !== null) {
        URL.revokeObjectURL(ttsObjectUrlRef.current);
        ttsObjectUrlRef.current = null;
      }
      ttsCacheRef.current.clear();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      // 闸门定时器不能留到卸载之后：它会在已销毁的组件上继续持有 ref。
      if (sendPendingTimerRef.current !== null) {
        window.clearTimeout(sendPendingTimerRef.current);
        sendPendingTimerRef.current = null;
      }
    };
  }, []);

  /**
   * 拿发送闸门。
   *
   * ★ 建会话的请求可能因为网络/后端异常永远不返回：拿闸门时挂一个 20s 的
   *   兜底定时器自动释放，否则之后再也发不出消息。
   * ★ 用令牌而不是裸 boolean：超时释放后新一轮可能已经拿到闸门，迟到的
   *   finally 不能再把新一轮的闸门放开。
   */
  function acquireSendPending(): object | null {
    if (sendPendingRef.current) return null;
    const token: object = {};
    sendPendingRef.current = true;
    sendPendingTokenRef.current = token;
    sendPendingTimerRef.current = window.setTimeout(() => {
      if (sendPendingTokenRef.current !== token) return;
      sendPendingTokenRef.current = null;
      sendPendingTimerRef.current = null;
      sendPendingRef.current = false;
    }, SEND_PENDING_TIMEOUT_MS);
    return token;
  }

  /** 正常释放闸门（幂等）：只有当令牌仍是自己的时候才清定时器和标记。 */
  function releaseSendPending(token: object): void {
    if (sendPendingTokenRef.current !== token) return;
    sendPendingTokenRef.current = null;
    if (sendPendingTimerRef.current !== null) {
      window.clearTimeout(sendPendingTimerRef.current);
      sendPendingTimerRef.current = null;
    }
    sendPendingRef.current = false;
  }

  /**
   * 一轮结束后把历史拉回来。
   *
   * ★ 「轮次轨道 / 审查」都从 messages 构建：live 轮结束后不刷新的话，刚完成
   *   的这一轮要切会话再切回来才出现。
   * ★ 成功/失败/停止都会调用；失败与停止时服务端只落了用户消息，
   *   reconcileLiveTurns 会把同一轮留在 live 视图里，避免内容消失或重复。
   * ★ 请求回来时若新一轮已经在跑、或用户切了会话，直接丢弃这份快照：
   *   不能拿旧历史覆盖正在生成的视图。
   */
  async function refreshHistoryAfterTurn(id: string): Promise<void> {
    const seq = ++historyRefreshSeqRef.current;
    // loadSession 也有自己的 token：切走/重载后旧响应不得落盘。
    const loadToken = loadSeqRef.current;
    try {
      const res = await fetchJson<SessionDetailResponse>(
        `/api/sessions/${encodeURIComponent(id)}`,
      );
      if (seq !== historyRefreshSeqRef.current) return;
      if (loadToken !== loadSeqRef.current) return;
      if (sessionIdRef.current !== id) return;
      if (turnTokenRef.current !== null || streamingRef.current) return;
      const merged = reconcileLiveTurns(res.messages, liveTurnsRef.current);
      const knownQuizIds = new Set(quizzesRef.current.map((quiz) => quiz.id));
      const hasNewQuiz = res.quizzes.some((quiz) => !knownQuizIds.has(quiz.id));
      setMessages(merged.messages);
      setLiveTurns(merged.liveTurns);
      setVerdicts(res.verdicts);
      setQuizzes(res.quizzes);
      quizzesRef.current = res.quizzes;
      setCancellations(res.cancellations ?? []);
      // AI 明确产出了新练习 → 自动打开右侧练习栏；历史加载/复盘不触发。
      if (hasNewQuiz) openStudyPane();
    } catch {
      // 刷新只是收尾的补充：失败保留 live 视图，切会话仍能看到已落盘结果。
    }
  }

  /**
   * 没有当前会话时先建一个。
   *
   * ★ 创建失败的提示由调用方给：发送路径要说明“消息没发出去、输入和附件还在”，
   *   设置路径只需要原因；两条路径共用同一份创建流程，避免各写一遍。
   * ★ autoSwitch=false 时不改当前会话：发送路径建会话期间用户可能已经切走，
   *   硬切会把人家拽回来。返回值仍是新会话 id，消息照旧发到新会话。
   */
  async function ensureSession(
    failureNote?: string,
    autoSwitch = true,
  ): Promise<string | null> {
    if (sessionId !== null) return sessionId;
    try {
      const res = await postJson<SessionCreateResponse>('/api/sessions', {});
      applySummary(res.session);
      if (autoSwitch) {
        sessionIdRef.current = res.session.id;
        setCurrentId(res.session.id);
      }
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
    // 压缩还没结束就发送 = 把「没有图片的消息」发出去；宁可挡住并说明原因。
    if (imageProcessingRef.current) {
      notify('图片还在处理中，请稍候再发。', 'warning');
      return;
    }
    if (!canChat) {
      notify('还没有配置模型。请在设置里查看接入方式。', 'warning');
      return;
    }

    const outgoing = attachments.map((a) => a.url);
    // 这两个变量只回答“是不是首轮”（标题补生成用），与清空时机无关。
    const sendingDraft = isDraftSession || sessionId === null;
    const firstTurn = sendingDraft || (currentSession?.turnCount ?? 0) === 0;
    /**
     * 发送开始时用户所在的会话（没有会话时是 null）。
     *
     * ★ 建会话要等一次请求；期间用户可能切到别的会话。这个快照用来判断
     *   “用户还停在原处吗”，只有还停着才自动进入新会话。
     * ★ 草稿 key 也按它算：ensureSession 之后当前会话可能已经变了。
     */
    const originSessionId = sessionIdRef.current;

    /**
     * 先建会话，成功之后再清输入。
     *
     * ★ 旧顺序先清再 await：创建会话失败时直接 return，用户刚打的字、附件、
     *   草稿全没了，只能重打。失败提示必须说清“内容还在”，否则用户会以为丢了。
     * ★ 建会话期间输入框还留着原文，必须挡住第二次提交（见 sendPendingRef）。
     */
    const gate = acquireSendPending();
    if (gate === null) return;
    let id: string | null = null;
    let gateHeld = false;
    try {
      id = await ensureSession('消息没有发出去，输入内容和附件都还在输入框里', false);
    } finally {
      /**
       * 超时兜底可能已经把闸门放开：这时即使会话建好了也不再发，
       * 否则用户重试之后会收到两条一样的消息。
       */
      gateHeld = sendPendingTokenRef.current === gate;
      releaseSendPending(gate);
    }
    if (id === null || !gateHeld) return;

    /**
     * 只有用户仍停在发送开始时那一屏（通常是还没有会话）才自动切到新会话；
     * 否则保持用户现在的选择，消息仍然落到 id 对应的新会话里，不丢。
     */
    if (originSessionId === null && sessionIdRef.current === null) {
      sessionIdRef.current = id;
      setCurrentId(id);
    }

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
    if (sendingDraft) discardDraft(draftStorageKey(originSessionId));
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
    // 上一轮被中断时可能留下没等到完成事件的参数分片，这里整批作废。
    toolArgsRef.current.clear();
    pendingAiOpsRef.current.clear();
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
        /**
         * 只跟随“发送开始时还在原处”的用户。
         *
         * ★ 建会话期间用户可能已经切到别的会话：这时再按服务端事件切过去
         *   会把人硬拽回来。消息仍然发在 ev.sessionId 里（id 不变）。
         */
        if (sessionIdRef.current === originSessionId && sessionIdRef.current !== ev.sessionId) {
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

      if (ev.type === 'agent' && ev.kind === 'toolCall') {
        /**
         * 工具参数是逐片到达的，完成事件本身反而只带空 argsDelta。
         * 所以先按 callId 拼全文，看到 partial:false 才认为这次调用已完整。
         */
        const previous = toolArgsRef.current.get(ev.callId) ?? '';
        if (ev.partial) {
          toolArgsRef.current.set(ev.callId, previous + ev.argsDelta);
        } else {
          toolArgsRef.current.delete(ev.callId);
          const op = aiOpOfToolCall(ev.name, previous);
          if (op !== null) {
            pendingAiOpsRef.current.set(ev.callId, op);
            setAiOp(op);
            /**
             * 只对「写文件」自动展开右栏：
             * 读文件在一次回答里可能发生十几次，每次都把对话挤成半宽会打断阅读；
             * 写入是用户最需要当场看到结果的动作，值得主动让出空间。
             *
             * ★ 走 ensureFilesPane 而不是 openWorkspace：后者会清掉刚设置的 aiOp，
             *   提示就被吞了；这里用 ref 读最新列表，落到用户当前看的工作区面板上。
             */
            if (op.writing) {
              setPanelMax(false);
              showPane(ensureFilesPane());
            }
          }
        }
      }

      if (ev.type === 'agent' && ev.kind === 'toolResult') {
        const op = pendingAiOpsRef.current.get(ev.callId);
        if (op !== undefined) {
          pendingAiOpsRef.current.delete(ev.callId);
          /**
           * toolCall 是「模型刚决定要写」时发的，文件可能还没落盘；
           * 写成功后再推一次（新对象 = 新 identity），WorkPanel 才会重新读取。
           * 若用户此时正在编辑，面板会自己拦住覆盖并给「载入 AI 版本」。
           */
          if (op.writing && ev.ok && !ev.denied) setAiOp({ ...op });
        }
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
        /**
         * 把这一轮拉回历史：轮次轨道/审查只读 messages，
         * 不刷新的话刚完成的一轮要切会话才会出现。
         * 成功、失败、停止都会走到这里。
         */
        void refreshHistoryAfterTurn(id);
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

  /** 面板关闭就退出展开：展开是面板的一种排版，面板没了不该留着浮窗状态。 */
  useEffect(() => {
    if (!reviewOpen) setPanelMax(false);
  }, [reviewOpen]);

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

  function stopCloudSpeech(): void {
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    const audio = ttsAudioRef.current;
    ttsAudioRef.current = null;
    if (audio !== null) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = '';
    }
    if (ttsObjectUrlRef.current !== null) {
      URL.revokeObjectURL(ttsObjectUrlRef.current);
      ttsObjectUrlRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  function speakWithBrowser(text: string, id: string): void {
    if (!('speechSynthesis' in window)) {
      setSpeakingId(null);
      notify('当前浏览器不支持语音朗读。', 'warning');
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

  async function playCloudBlob(blob: Blob, cacheKey: string, text: string, id: string): Promise<void> {
    const url = URL.createObjectURL(blob);
    ttsObjectUrlRef.current = url;
    const audio = new Audio(url);
    ttsAudioRef.current = audio;
    audio.onended = () => {
      if (ttsAudioRef.current === audio) {
        ttsAudioRef.current = null;
        if (ttsObjectUrlRef.current === url) {
          URL.revokeObjectURL(url);
          ttsObjectUrlRef.current = null;
        }
        setSpeakingId(null);
      }
    };
    audio.onerror = () => {
      if (ttsAudioRef.current !== audio) return;
      ttsAudioRef.current = null;
      if (ttsObjectUrlRef.current === url) {
        URL.revokeObjectURL(url);
        ttsObjectUrlRef.current = null;
      }
      ttsCacheRef.current.delete(cacheKey);
      setSpeakingId(null);
      notify('云端音频无法播放，已切换系统朗读。', 'warning');
      speakWithBrowser(text, id);
    };
    try {
      await audio.play();
    } catch (err) {
      if (ttsAudioRef.current === audio) {
        ttsAudioRef.current = null;
        audio.pause();
        audio.src = '';
      }
      if (ttsObjectUrlRef.current === url) {
        URL.revokeObjectURL(url);
        ttsObjectUrlRef.current = null;
      }
      ttsCacheRef.current.delete(cacheKey);
      throw err;
    }
  }

  async function speak(text: string, id: string): Promise<void> {
    if (speakingId === id) {
      stopCloudSpeech();
      setSpeakingId(null);
      return;
    }
    stopCloudSpeech();
    setSpeakingId(id);

    if (ttsConfig === null) {
      speakWithBrowser(text, id);
      return;
    }

    const cacheKey = ttsCacheKey(id, text.slice(0, 4_000), ttsConfig);
    const cached = ttsCacheRef.current.get(cacheKey);
    if (cached !== undefined) {
      const cachedController = new AbortController();
      ttsAbortRef.current = cachedController;
      try {
        await playCloudBlob(cached, cacheKey, text, id);
      } catch (err) {
        if (cachedController.signal.aborted) return;
        notify(`云端朗读失败：${errorMessage(err)}；已切换系统朗读。`, 'warning');
        speakWithBrowser(text, id);
      } finally {
        if (ttsAbortRef.current === cachedController) ttsAbortRef.current = null;
      }
      return;
    }

    const controller = new AbortController();
    ttsAbortRef.current = controller;
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 4_000) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: unknown } | null;
        const detail = typeof payload?.error === 'string' ? payload.error : `HTTP ${res.status}`;
        throw new Error(detail);
      }
      const blob = await res.blob();
      if (controller.signal.aborted) return;
      ttsCacheRef.current.set(cacheKey, blob);
      await playCloudBlob(blob, cacheKey, text, id);
    } catch (err) {
      if (controller.signal.aborted) return;
      ttsCacheRef.current.delete(cacheKey);
      stopCloudSpeech();
      notify(`云端朗读失败：${errorMessage(err)}；已切换系统朗读。`, 'warning');
      speakWithBrowser(text, id);
    } finally {
      if (ttsAbortRef.current === controller) ttsAbortRef.current = null;
    }
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

    if (images.length > 0) {
      /**
       * 压缩要解码像素、跑 canvas，不是瞬时操作：连点按钮或重复粘贴时
       * 上一批还没处理完，这里直接忽略新的一批，避免同一张图压两遍、
       * 附件列表重复。ref 是同步的，state 要等下一次渲染才生效。
       */
      if (imageProcessingRef.current) return;
      imageProcessingRef.current = true;
      setImageProcessing(true);
      try {
        if (attachments.length + images.length > MAX_IMAGES) {
          notify(`一次最多附 ${MAX_IMAGES} 张图片`, 'warning');
        }
        const room = Math.max(0, MAX_IMAGES - attachments.length);
        for (const file of images.slice(0, room)) {
          if (file.size > MAX_IMAGE_BYTES) {
            notify(`「${file.name}」超过 32 MiB，已跳过`, 'warning');
            continue;
          }
          try {
            const url = await compressImageToDataUrl(file);
            if (url === null) {
              // 压到 0.7 仍超过 2 MiB：不把它放进附件，发送自然不会带上它。
              notify(`「${file.name}」图片太大，请换一张`, 'warning');
              continue;
            }
            setAttachments((prev) =>
              prev.length >= MAX_IMAGES ? prev : [...prev, { name: file.name, url }],
            );
          } catch {
            notify(`「${file.name}」图片处理失败，请换一张`, 'warning');
          }
        }
      } finally {
        imageProcessingRef.current = false;
        setImageProcessing(false);
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
      ? `${currentSession.turnCount} 次对话 · 最后活动 ${formatChatTime(currentSession.updatedAt, now)}`
      : '一段新的上下文';

  const activeApproval = currentApproval(approvals);

  /** 专注抽屉里的最近会话：当前草稿也保留，其余空会话不占位置。 */
  const focusSessionList = sessions
    .filter(
      (session) =>
        session.isPet !== true && (session.messageCount > 0 || session.id === sessionId),
    )
    .slice(0, 20);
  const focusConfigSession =
    focusConfigSessionId !== null
      ? (sessions.find((session) => session.id === focusConfigSessionId) ?? null)
      : null;
  const focusConfigReady = focusConfigSessionId !== null && focusConfigSessionId === sessionId;

  function switchFocusSession(id: string): void {
    setFocusSettingsOpen(false);
    if (id === sessionId) return;
    void loadSession(id);
  }

  function openFocusSettingsList(): void {
    setFocusSettingsView('list');
    setFocusConfigSessionId(null);
    setFocusSettingsOpen(true);
  }

  /**
   * 打开某段对话的配置。
   *
   * ★ 模型/思考沿用当前会话的保存路径；因此先把这段对话切为当前，
   *   配置页里的两个控件才真正写回这段对话。
   * ★ 不关闭浮层：loadSession 完成后仍停在配置页。
   */
  function openFocusConfig(id: string): void {
    setFocusSettingsView('config');
    setFocusConfigSessionId(id);
    setFocusSettingsOpen(true);
    if (id !== sessionId) void loadSession(id);
  }

  function backToFocusSettingsList(): void {
    setFocusSettingsView('list');
    setFocusConfigSessionId(null);
  }

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
    <div
      className={`chat-view${focusMode ? ' is-focus' : ''} ${active ? 'is-active' : ''} ${reviewOpen ? 'is-review' : ''}${
        reviewOpen && paneTab === 'files' ? ' is-work' : ''
      }${reviewOpen && paneTab === 'browser' ? ' is-browser' : ''}${
        reviewOpen && paneTab === 'external-file' ? ' is-external-file' : ''
      }${reviewOpen && paneTab === 'terminal' ? ' is-terminal' : ''}${
        reviewOpen && paneTab === 'study' ? ' is-study' : ''
      }${panelExpanded ? ' is-panel-max' : ''}${
        panelExpanded && chatFloat.collapsed ? ' is-chat-collapsed' : ''
      }`}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {focusMode ? (
        <header className="chat-head chat-head--focus">
          <div className="chat-head-main">
            <div className="chat-head-title">
              <p className="chat-head-eyebrow">AI 对话</p>
              <h1 title={derivedTitle}>{derivedTitle}</h1>
            </div>
          </div>
          <div className="focus-chat-head-actions">
            <button
              type="button"
              className="focus-chat-close"
              onClick={openFocusSettingsList}
              aria-label="对话设置"
              title="对话设置"
              aria-expanded={focusSettingsOpen}
            >
              <Icon name="settings" size={16} />
            </button>
            <button
              type="button"
              className="focus-chat-close"
              onClick={onFocusClose}
              aria-label="收起 AI 对话"
              title="收起"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </header>
      ) : (
      <header className="chat-head">
        <div className="chat-head-main">
          <div className="chat-head-title">
            <h1 title={derivedTitle}>{derivedTitle}</h1>
            <p>{subtitle}</p>
          </div>
        </div>
        <div className="chat-head-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void createNewChat()}>
            <Icon name="plus" size={15} /> 新对话
          </button>
          {/*
            右栏入口：纯图标分体按钮 + 左侧浮层菜单。
            ★ 主体只切换右栏显隐、不打开列表：想收起侧栏时不会手滑展开菜单。
            ★ 按钮不再写面板名：文案会随「工作区 10」变长而挤压标题；当前在哪一栏由列表里的勾选表达。
            ★ 箭头只开列表；列表从按钮下方展开、右对齐，不把头部撑高。
          */}
          <div className="panel-menu" ref={panelMenuRef}>
            <div className="panel-split">
              <button
                type="button"
                className="panel-split-main"
                aria-label={reviewOpen ? '收起侧栏' : '展开侧栏'}
                aria-pressed={reviewOpen}
                title={reviewOpen ? '收起侧栏' : '展开侧栏'}
                onClick={togglePaneVisibility}
              >
                <Icon name="panelLeft" size={15} />
              </button>
              <button
                ref={panelMenuButtonRef}
                type="button"
                className="panel-split-arrow"
                aria-haspopup="menu"
                aria-expanded={panelMenuOpen}
                aria-controls={panelMenuOpen ? panelMenuId : undefined}
                aria-label="侧栏面板列表"
                title="侧栏面板列表"
                onClick={(event) => {
                  // click.detail：键盘（Enter/Space）触发为 0，真实指针点击 > 0。
                  // 只记录“怎么打开的”，真正聚焦在第一项的 effect 里判断。
                  panelMenuKeyboardOpenRef.current = event.detail === 0;
                  setPanelCreateOpen(false);
                  setPanelMenuOpen(!panelMenuOpen);
                }}
                onKeyDown={(event) => {
                  // ↓ 直接展开列表：role="menu" 的键盘惯例，省掉一次 Tab。
                  if (event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  panelMenuKeyboardOpenRef.current = true;
                  if (!panelMenuOpen) {
                    setPanelCreateOpen(false);
                    setPanelMenuOpen(true);
                    return;
                  }
                  // 列表已经开着（Esc 只会关掉它）：把焦点送进第一项，而不是原地不动。
                  panelMenuRef.current
                    ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
                    ?.focus();
                }}
              >
                <Icon name="chevronDown" size={12} className="panel-menu-caret" />
              </button>
            </div>

            {panelMenuOpen ? (
              <div
                className="panel-menu-pop"
                id={panelMenuId}
                role="menu"
                aria-label="侧栏面板"
                onKeyDown={handlePanelMenuKeyDown}
              >
                {/* 「新建」行 + 二级浮层：主列表向下展开，二级仍从该行左侧弹出。 */}
                <div className="panel-menu-new" role="none">
                  <button
                    ref={panelCreateButtonRef}
                    type="button"
                    role="menuitem"
                    className="panel-menu-item"
                    aria-expanded={panelCreateOpen}
                    aria-controls={panelCreateOpen ? panelCreateMenuId : undefined}
                    title={panelCreateOpen ? '收起新建菜单' : '新建面板'}
                    onClick={(event) => togglePanelCreateMenu(event.detail === 0)}
                    onKeyDown={handlePanelCreateKeyDown}
                  >
                    <Icon name="plus" size={14} />
                    <span>新建</span>
                    <Icon
                      name="chevronDown"
                      size={11}
                      className={`panel-menu-new-caret${panelCreateOpen ? ' is-open' : ''}`}
                    />
                  </button>
                  {panelCreateOpen ? (
                    <div
                      className="panel-menu-sub"
                      id={panelCreateMenuId}
                      role="group"
                      aria-label="新建面板"
                      style={
                        panelSubShift > 0
                          ? { right: `calc(100% + ${PANEL_FLYOUT_GAP}px - ${panelSubShift}px)` }
                          : undefined
                      }
                      onKeyDown={handlePanelCreateSubKeyDown}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="panel-menu-item"
                        title="新建一个工作区面板（总是新实例）"
                        onClick={() => runPanelMenuItem(openNewWorkspacePane)}
                      >
                        <Icon name={PANE_KIND_ICON.files} size={13} />
                        <span>工作区</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="panel-menu-item"
                        title="查看当前对话的练习历史"
                        onClick={() => runPanelMenuItem(openStudyPane)}
                      >
                        <Icon name={PANE_KIND_ICON.study} size={13} />
                        <span>学习</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="panel-menu-item"
                        title="打开工作区外的文件（原生选择框）"
                        onClick={() => runPanelMenuItem(() => void openExternalFile())}
                      >
                        <Icon name={PANE_KIND_ICON['external-file']} size={13} />
                        <span>文件</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="panel-menu-item"
                        title="打开内嵌浏览器（已打开时直接切换）"
                        onClick={() => runPanelMenuItem(openBrowser)}
                      >
                        <Icon name={PANE_KIND_ICON.browser} size={13} />
                        <span>浏览器</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="panel-menu-item"
                        disabled={reviewUnavailable}
                        title={
                          reviewUnavailable
                            ? '还没有可审查的完成或中断轮次'
                            : '打开审查面板（已打开时直接切换）'
                        }
                        onClick={() => runPanelMenuItem(openReview)}
                      >
                        <Icon name={PANE_KIND_ICON.review} size={13} />
                        <span>审查</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="panel-menu-item"
                        title="新建一个终端面板（可多开）"
                        onClick={() => runPanelMenuItem(() => void openTerminal())}
                      >
                        <Icon name={PANE_KIND_ICON.terminal} size={13} />
                        <span>终端</span>
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* 没有已打开面板时（右栏刚关到空）不画分隔线：下面没有内容，留一条空线更怪。 */}
                {panes.length > 0 ? (
                  <div className="panel-menu-separator" role="separator" />
                ) : null}

                {panes.map((pane) => {
                  const active = reviewOpen && pane.id === activePane?.id;
                  return (
                    <div
                      key={pane.id}
                      role="none"
                      className={`panel-menu-row${active ? ' is-active' : ''}`}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        data-pane-id={pane.id}
                        className={`panel-menu-item${active ? ' is-active' : ''}`}
                        aria-current={active ? 'true' : undefined}
                        title={active ? '当前面板' : `切换到${pane.label}`}
                        onClick={() => runPanelMenuItem(() => activatePane(pane.id))}
                      >
                        <Icon name={PANE_KIND_ICON[pane.kind]} size={14} />
                        <span>{pane.label}</span>
                        {active ? <Icon name="check" size={12} className="panel-menu-check" /> : null}
                      </button>
                      <button
                        type="button"
                        className="panel-menu-close"
                        aria-label={`关闭${pane.label}`}
                        title={`关闭${pane.label}`}
                        onClick={(event) => {
                          // × 只关闭自己：不让点击冒泡成一次“切换面板”。
                          event.stopPropagation();
                          closePane(pane.id);
                        }}
                      >
                        <Icon name="close" size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </header>
      )}

      <div
        className="chat-body"
        ref={chatBodyRef}
        style={
          reviewOpen && !panelExpanded
            ? { gridTemplateColumns: `${1 - reviewRatio}fr 1px ${reviewRatio}fr` }
            : undefined
        }
      >
      {/*
        ★ 消息 + 输入框始终是同一个容器里的同一份 DOM。
          展开工作区时只是让 .chat-float 改成 absolute 并套用记忆里的矩形，
          不复制对话组件、不重新挂载，所以滚动位置、草稿、输入焦点都不会丢。
      */}
      <div className="chat-float" style={chatFloat.style}>
        {panelExpanded ? (
          <div
            className="chat-float-bar"
            onPointerDown={chatFloat.startMove}
            onPointerMove={chatFloat.moveDrag}
            onPointerUp={chatFloat.endDrag}
            onPointerCancel={chatFloat.endDrag}
            onLostPointerCapture={chatFloat.lostPointerCapture}
            title="拖动这里移动对话窗"
          >
            <Icon name="menu" size={13} className="chat-float-grip" />
            <span className="chat-float-label">对话</span>
            <button
              type="button"
              className="chat-float-collapse"
              onClick={chatFloat.collapse}
              title="收起为气泡"
              aria-label="收起对话浮窗"
            >
              <Icon name="minus" size={14} />
            </button>
          </div>
        ) : null}
      <div className="chat-scroll-wrap">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} aria-busy={streaming}>
        <div className="chat-column">
          {!hasContent && !loadingSession && sessionError === null && (
            focusMode ? (
              <section className="focus-chat-empty">
                <p className="focus-chat-empty-kicker">当前会话</p>
                <h2>接着聊。</h2>
                <p>
                  你在这里说的话，会回到同一个会话里。需要动手时，
                  审批会出现在输入框上方，等你看过才会继续。
                </p>
              </section>
            ) : (
            <section className="chat-hero">
              <div className="hero-orbit" aria-hidden="true">
                <span className="hero-orbit-ring hero-orbit-ring--1" />
                <span className="hero-orbit-ring hero-orbit-ring--2" />
                <span className="hero-orbit-core">
                  <BrandMark className="hero-orbit-mark" size={22} />
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
            )
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
            {messages.map((m, i) => {
              const previous = messages[i - 1];
              const showDay =
                previous === undefined || !sameLocalDay(previous.createdAt, m.createdAt);
              return (
                <Fragment key={m.id}>
                  {showDay && <ChatDayDivider ts={m.createdAt} now={now} />}
                  <ServerMessage
                    message={m}
                    verdict={verdictFor(messages, verdicts, i)}
                    notify={notify}
                    now={now}
                    canSpeak={ttsSupported || ttsConfig !== null}
                    speaking={speakingId === m.id}
                    onSpeak={() => { void speak(m.text, m.id); }}
                  />
                </Fragment>
              );
            })}

            {liveTurns.map((turn, i) => {
              const previousAt =
                i > 0 ? liveTurns[i - 1]?.startedAt : messages[messages.length - 1]?.createdAt;
              const showDay =
                previousAt === undefined || !sameLocalDay(previousAt, turn.startedAt);
              return (
                <Fragment key={`live-${i}`}>
                  {showDay && <ChatDayDivider ts={turn.startedAt} now={now} />}
                  <LiveTurnView
                    turn={turn}
                    now={now}
                    onOpenMemory={onOpenMemory}
                    onRetry={(text) => {
                      setInput(text);
                      window.setTimeout(() => textareaRef.current?.focus(), 60);
                    }}
                    onCopy={(text) => void copyText(text)}
                  />
                </Fragment>
              );
            })}

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

            {quizzes.length > 0 && sessionId !== null && !quizPaneOpen && (
              <QuizInvite quizzes={quizzes} onOpen={openStudyPane} />
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
                  disabled={imageProcessing}
                  title={imageProcessing ? '图片处理中，请稍候' : '添加图片或文档'}
                  aria-label="添加图片或文档"
                >
                  <Icon name="paperclip" size={18} />
                </button>
                {!focusMode && (
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
                )}
                {(listening || attachments.length > 0 || imageProcessing) && (
                  <span className="composer-hint" aria-live="polite">
                    {listening
                      ? '正在听… 再点麦克风结束'
                      : imageProcessing
                        ? '图片处理中…'
                        : `${attachments.length} 张图片`}
                  </span>
                )}
              </div>

              {!focusMode && (
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
              )}
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
                  disabled={
                    !canChat ||
                    imageProcessing ||
                    (input.trim().length === 0 && attachments.length === 0)
                  }
                  aria-label="发送"
                  title={imageProcessing ? '图片处理中，请稍候' : undefined}
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

      {panelExpanded ? (
        <div
          className="chat-float-resize"
          onPointerDown={chatFloat.startResize}
          onPointerMove={chatFloat.moveDrag}
          onPointerUp={chatFloat.endDrag}
          onPointerCancel={chatFloat.endDrag}
          onLostPointerCapture={chatFloat.lostPointerCapture}
          aria-hidden="true"
          title="拖动调整对话窗大小"
        />
      ) : null}
      </div>

      {/* 展开时右栏占满主区域，分隔条没有意义，直接不渲染。 */}
      {reviewOpen && !panelExpanded ? (
        <div
          className="review-splitter"
          role="separator"
          aria-label="调整主对话与右栏宽度"
          aria-orientation="vertical"
          aria-valuemin={35}
          aria-valuemax={65}
          aria-valuenow={Math.round(reviewRatio * 100)}
          tabIndex={0}
          onPointerDown={handleReviewSplitterPointerDown}
          onKeyDown={handleReviewSplitterKeyDown}
        />
      ) : null}
      {/*
        ★ 右栏整体收起时只 hidden、不卸载：外部文件与终端实例还留在面板列表里，
          真正的实例关闭发生在列表 × / 切会话。如果跟着收起一起卸载，组件的卸载清理
          会关闭服务端句柄与终端进程，再展开同一个实例就只剩“句柄已失效”。
        ★ 工作区 / 浏览器 / 审查仍只在右栏打开时挂载，保持原有开销与现场语义。
      */}
      <section
        className="review-pane"
        aria-label="工作区、外部文件、浏览器、审查、学习与终端"
        hidden={!reviewOpen}
      >
            {/*
              工作区面板可以多开：每个实例都保持挂载，非激活的只用 hidden 收起来。
              ★ 各自保留文件树、打开的文件和未保存草稿，切换面板不会丢状态；
                hidden 有全局 [hidden]{display:none!important} 兜底，不占布局。
              ★ aiOp 只给当前激活的面板：隐藏面板不该在后台悄悄打开 AI 改的文件。
            */}
            {reviewOpen && panes
              .filter((pane) => pane.kind === 'files')
              .map((pane) => (
                <div
                  key={pane.id}
                  className="work-panel-slot"
                  hidden={pane.id !== activePane?.id}
                >
                  <WorkPanel
                    sessionId={sessionId}
                    open={reviewOpen}
                    aiOp={pane.id === activePane?.id ? aiOp : null}
                  />
                </div>
              ))}
            {/*
              浏览器面板只在激活时挂载：没激活就不发 /api/browser/start，也不占一条 SSE 连接。
              画面尺寸全部交给 flex（.browser-stage 是 flex:1），
              因此展开成浮窗时画面会跟着面板缩放，不依赖任何写死的高度。
            */}
            {reviewOpen && paneTab === 'browser' && activePane !== null ? (
              <div className="browser-panel-slot">
                <BrowserPanel
                  sessionId={sessionId}
                  onSendToButler={sendBrowserPageToButler}
                  onAttachScreenshot={attachBrowserScreenshot}
                  maximized={panelMax}
                  onMaximizedChange={setPanelMax}
                />
              </div>
            ) : null}
            {reviewOpen && paneTab === 'review' && activePane !== null ? (
              <>
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
              </>
            ) : null}
        {/*
          外部文件与终端实例在收起右栏时也保持挂载（见上方说明），非激活实例 hidden。
          ★ 句柄 / 终端会话跟着实例走：列表里关掉（或切会话移除）才卸载并调 close。
        */}
        {reviewOpen && paneTab === 'study' && activePane !== null ? (
          <div className="study-pane-slot">
            <StudyPane sessionId={sessionId} quizzes={quizzes} notify={notify} />
          </div>
        ) : null}
        {panes
          .filter((pane) => pane.kind === 'external-file')
          .map((pane) => (
            <div
              key={pane.id}
              className="external-file-slot"
              hidden={pane.id !== activePane?.id}
            >
              {pane.externalFile !== undefined ? (
                <ExternalFilePanel
                  sessionId={pane.externalFile.sessionId}
                  file={pane.externalFile}
                  onClose={() => closePane(pane.id)}
                />
              ) : null}
            </div>
          ))}
        {panes
          .filter((pane) => pane.kind === 'terminal')
          .map((pane) => (
            <div
              key={pane.id}
              className="terminal-slot"
              hidden={pane.id !== activePane?.id}
            >
              {pane.terminal !== undefined ? (
                <TerminalPanel
                  sessionId={pane.terminal.sessionId}
                  terminal={pane.terminal}
                  onClose={() => closePane(pane.id)}
                />
              ) : (
                <div className="terminal-panel is-failed" role="alert">
                  <div className="terminal-failed">
                    <Icon name="alert" size={22} />
                    <h3>终端启动失败</h3>
                    <p>{pane.terminalError ?? '服务端没有返回原因'}</p>
                    <p className="terminal-failed-hint">
                      关掉这个面板后可以从「新建 → 终端」再试一次。
                    </p>
                  </div>
                </div>
              )}
            </div>
          ))}
      </section>

      {/* 收起后的入口：位置/尺寸仍留在 chatFloat.rect 里，点一下原样恢复。 */}
      {panelExpanded && chatFloat.collapsed ? (
        <button
          type="button"
          className={`chat-bubble${streaming ? ' is-generating' : ''}`}
          onClick={chatFloat.restore}
          title={streaming ? '正在生成 · 展开对话' : '展开对话'}
          aria-label={streaming ? '展开对话，正在生成' : '展开对话'}
        >
          <Icon name="chat" size={21} />
          {streaming ? <span className="chat-bubble-dot" aria-hidden="true" /> : null}
        </button>
      ) : null}

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

      {/* 历史只在侧栏；这里不再保留抽屉，也不重复加载会话列表。 */}
      {focusMode && focusSettingsOpen && (
        <div
          ref={focusSettingsRef}
          className="focus-chat-settings"
          role="dialog"
          aria-modal="true"
          aria-label={focusSettingsView === 'config' ? '修改对话配置' : '对话设置'}
        >
          <header className="focus-chat-settings-head">
            {focusSettingsView === 'config' && (
              <button
                type="button"
                className="focus-chat-settings-back"
                onClick={backToFocusSettingsList}
                aria-label="返回会话列表"
                title="返回"
              >
                <Icon name="arrowLeft" size={16} />
              </button>
            )}
            <div className="focus-chat-settings-heading">
              <p className="focus-chat-settings-eyebrow">
                {focusSettingsView === 'config' ? '修改配置' : '对话设置'}
              </p>
              <h2>
                {focusSettingsView === 'config'
                  ? (focusConfigSession?.title ?? '这段对话')
                  : (currentSession?.title ?? derivedTitle)}
              </h2>
              <small>
                {focusSettingsView === 'config'
                  ? '模型、思考、人格、工作区、权限与记忆只对这段对话生效。'
                  : '切换会话，或点每段对话右侧的按钮修改配置。'}
              </small>
            </div>
            <button
              type="button"
              className="focus-chat-close"
              onClick={() => setFocusSettingsOpen(false)}
              aria-label="关闭对话设置"
              title="关闭"
              autoFocus
            >
              <Icon name="close" size={16} />
            </button>
          </header>

          {focusSettingsView === 'config' ? (
            <div className="focus-chat-config">
              <div className="focus-chat-config-model">
                <div className="focus-chat-settings-section-head">
                  <span>模型与思考</span>
                  <small>{settingsSaving ? '保存中…' : '修改即保存'}</small>
                </div>
                {focusConfigReady ? (
                  <div className="focus-chat-settings-model">
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
                      popoverClassName="is-focus-popover"
                    />
                  </div>
                ) : (
                  <p className="focus-chat-settings-empty">正在打开这段对话…</p>
                )}
                {settingsError !== null && (
                  <p className="focus-chat-settings-error" role="alert">
                    {settingsError}
                  </p>
                )}
              </div>

              {focusConfigSession !== null ? (
                <SessionSettingsSheet
                  embedded
                  open
                  session={focusConfigSession}
                  notify={notify}
                  onClose={backToFocusSettingsList}
                  onSaved={handleSessionSaved}
                />
              ) : (
                <p className="focus-chat-settings-empty">这段对话已经不存在。</p>
              )}
            </div>
          ) : (
            <div className="focus-chat-settings-body">
              <section className="focus-chat-settings-section">
                <div className="focus-chat-settings-section-head">
                  <span>会话</span>
                  <button
                    type="button"
                    className="focus-chat-settings-new"
                    onClick={() => {
                      setFocusSettingsOpen(false);
                      void createNewChat();
                    }}
                  >
                    <Icon name="plus" size={14} /> 新对话
                  </button>
                </div>
                <div className="focus-chat-session-list">
                  {focusSessionList.map((session) => {
                    const isCurrent = session.id === sessionId;
                    return (
                      <div
                        key={session.id}
                        className={`focus-chat-session-row${isCurrent ? ' is-current' : ''}`}
                      >
                        <button
                          type="button"
                          className={`focus-chat-session${isCurrent ? ' is-current' : ''}`}
                          onClick={() => switchFocusSession(session.id)}
                          aria-current={isCurrent ? 'true' : undefined}
                        >
                          <span className="focus-chat-session-copy">
                            <strong>{session.title.length > 0 ? session.title : '新对话'}</strong>
                            <small>
                              {session.turnCount} 次对话 · 最后活动 {formatChatTime(session.updatedAt, now)}
                            </small>
                          </span>
                          {isCurrent && <Icon name="check" size={14} />}
                        </button>
                        <button
                          type="button"
                          className="focus-chat-session-config"
                          onClick={() => openFocusConfig(session.id)}
                          aria-label={`修改「${session.title.length > 0 ? session.title : '新对话'}」的配置`}
                          title="修改配置"
                        >
                          <Icon name="settings" size={15} />
                        </button>
                      </div>
                    );
                  })}
                  {focusSessionList.length === 0 && (
                    <p className="focus-chat-settings-empty">还没有对话，点「新对话」开始。</p>
                  )}
                </div>
              </section>

              <p className="focus-chat-settings-note">
                每段对话右侧的设置按钮里，可以单独修改模型、思考、人格、工作区、权限和记忆。
              </p>
            </div>
          )}
        </div>
      )}

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
// 工作区展开时的对话浮动窗
// ═══════════════════════════════════════════════════════════

interface ChatFloatRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface ChatFloatStored extends ChatFloatRect {
  readonly collapsed: boolean;
}

interface ChatFloatDrag {
  readonly mode: 'move' | 'resize';
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startRect: ChatFloatRect;
}

interface ChatFloatController {
  readonly collapsed: boolean;
  readonly style: CSSProperties | undefined;
  readonly startMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly startResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly moveDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly endDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly lostPointerCapture: () => void;
  readonly collapse: () => void;
  readonly restore: () => void;
}

/**
 * 位置/尺寸按会话存。
 *
 * ★ 为什么带 sessionId：每个会话各有自己的工作区，A 会话把浮窗拖到左下角，
 *   不该让 B 会话也继承这个位置。
 */
const CHAT_FLOAT_STORAGE_KEY = 'butler.chat.float';
const CHAT_FLOAT_MIN_WIDTH = 340;
const CHAT_FLOAT_MIN_HEIGHT = 280;
const CHAT_FLOAT_DEFAULT_WIDTH = 720;
const CHAT_FLOAT_DEFAULT_HEIGHT = 600;
const CHAT_FLOAT_DEFAULT_TOP = 52;

function chatFloatStorageKey(sessionId: string | null): string {
  return sessionId === null ? CHAT_FLOAT_STORAGE_KEY : `${CHAT_FLOAT_STORAGE_KEY}.${sessionId}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readChatFloatStored(sessionId: string | null): ChatFloatStored | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(chatFloatStorageKey(sessionId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const left = finiteNumber(record['left']);
    const top = finiteNumber(record['top']);
    const width = finiteNumber(record['width']);
    const height = finiteNumber(record['height']);
    if (left === null || top === null || width === null || height === null) return null;
    return { left, top, width, height, collapsed: record['collapsed'] === true };
  } catch {
    // 坏数据或隐私模式禁写：退回默认位置，不能因此打不开面板。
    return null;
  }
}

function writeChatFloatStored(
  sessionId: string | null,
  rect: ChatFloatRect,
  collapsed: boolean,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      chatFloatStorageKey(sessionId),
      JSON.stringify({ ...rect, collapsed }),
    );
  } catch {
    // 存不了就只在本次页面里记住，不影响拖动。
  }
}

/** 把矩形夹回主区域：宽高先满足下限，再保证四边都不越界。 */
function clampChatFloatRect(
  rect: ChatFloatRect,
  boundsWidth: number,
  boundsHeight: number,
): ChatFloatRect {
  const width = Math.min(
    Math.max(rect.width, CHAT_FLOAT_MIN_WIDTH),
    Math.max(CHAT_FLOAT_MIN_WIDTH, boundsWidth),
  );
  const height = Math.min(
    Math.max(rect.height, CHAT_FLOAT_MIN_HEIGHT),
    Math.max(CHAT_FLOAT_MIN_HEIGHT, boundsHeight),
  );
  const left = Math.min(Math.max(rect.left, 0), Math.max(0, boundsWidth - width));
  const top = Math.min(Math.max(rect.top, 0), Math.max(0, boundsHeight - height));
  return { left, top, width, height };
}

function defaultChatFloatRect(boundsWidth: number, boundsHeight: number): ChatFloatRect {
  // 右侧留出 160px：默认位置不要压住 tab 栏最右边的「还原」按钮。
  const width = Math.min(
    CHAT_FLOAT_DEFAULT_WIDTH,
    Math.max(CHAT_FLOAT_MIN_WIDTH, boundsWidth - 160),
  );
  const height = Math.min(
    CHAT_FLOAT_DEFAULT_HEIGHT,
    Math.max(CHAT_FLOAT_MIN_HEIGHT, boundsHeight - CHAT_FLOAT_DEFAULT_TOP - 16),
  );
  return { left: 24, top: CHAT_FLOAT_DEFAULT_TOP, width, height };
}

function useChatFloat(
  sessionId: string | null,
  expanded: boolean,
  bodyRef: { readonly current: HTMLDivElement | null },
): ChatFloatController {
  const [rect, setRect] = useState<ChatFloatRect | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const rectRef = useRef<ChatFloatRect | null>(null);
  const collapsedRef = useRef(false);
  const dragRef = useRef<ChatFloatDrag | null>(null);
  /** 事件回调里读最新 sessionId：拖动结束时可能已经切过会话。 */
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  function applyRect(next: ChatFloatRect): void {
    rectRef.current = next;
    setRect(next);
  }

  function persist(nextCollapsed: boolean): void {
    const current = rectRef.current;
    if (current !== null) writeChatFloatStored(sessionRef.current, current, nextCollapsed);
  }

  // 切会话先载入该会话的「是否收起」；位置尺寸在展开时再按当前主区域夹一次。
  useEffect(() => {
    const stored = readChatFloatStored(sessionId);
    const nextCollapsed = stored?.collapsed ?? false;
    collapsedRef.current = nextCollapsed;
    setCollapsed(nextCollapsed);
    rectRef.current = stored;
    setRect(stored);
  }, [sessionId]);

  // 每次展开（或展开中换会话）都重新夹一次：窗口变小后旧坐标可能已经在区域外。
  useEffect(() => {
    if (!expanded) return;
    const body = bodyRef.current;
    if (body === null) return;
    const bounds = body.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const stored = readChatFloatStored(sessionId);
    const next = clampChatFloatRect(
      stored ?? defaultChatFloatRect(bounds.width, bounds.height),
      bounds.width,
      bounds.height,
    );
    applyRect(next);
    const nextCollapsed = stored?.collapsed ?? false;
    collapsedRef.current = nextCollapsed;
    setCollapsed(nextCollapsed);
    // bodyRef 是稳定 ref；真正需要重跑的是「会话」和「展开」两个时机。
  }, [expanded, sessionId, bodyRef]);

  // 窗口缩放时同步夹住；纯浏览器窗口事件，卸载/收起都清掉。
  useEffect(() => {
    if (!expanded) return;
    const onResize = (): void => {
      const body = bodyRef.current;
      const current = rectRef.current;
      if (body === null || current === null) return;
      const bounds = body.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      applyRect(clampChatFloatRect(current, bounds.width, bounds.height));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [expanded, bodyRef]);

  // 指针捕获在元素卸载时由浏览器释放；这里只清掉本地拖动态，避免闭包残留。
  useEffect(() => {
    return () => {
      dragRef.current = null;
    };
  }, []);

  /**
   * ★ 使用 pointer capture 而不是 window 监听：
   *   pointermove/pointerup 都绑在把手自己身上，松手、指针被取消、
   *   组件卸载时浏览器会自动释放捕获，不存在忘记 removeEventListener 的泄漏。
   */
  function beginDrag(mode: 'move' | 'resize', event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const body = bodyRef.current;
    const current = rectRef.current;
    if (body === null || current === null) return;
    const bounds = body.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const startRect = clampChatFloatRect(current, bounds.width, bounds.height);
    applyRect(startRect);
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 个别环境不支持捕获：退化为在把手内部拖动，仍然不会泄漏监听。
    }
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect,
    };
  }

  function startMove(event: ReactPointerEvent<HTMLDivElement>): void {
    // 顶部条里的收起按钮不能当作拖拽起点，否则点一下会先拖动再触发 click。
    const target = event.target;
    if (target instanceof Element && target.closest('button') !== null) return;
    beginDrag('move', event);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    beginDrag('resize', event);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const body = bodyRef.current;
    if (drag === null || body === null || event.pointerId !== drag.pointerId) return;
    const bounds = body.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (drag.mode === 'move') {
      const { width, height } = drag.startRect;
      const left = Math.min(
        Math.max(drag.startRect.left + dx, 0),
        Math.max(0, bounds.width - width),
      );
      const top = Math.min(
        Math.max(drag.startRect.top + dy, 0),
        Math.max(0, bounds.height - height),
      );
      applyRect({ left, top, width, height });
      return;
    }

    // 缩放只改右下角：left/top 不动，上限由“到右/下边还剩多少”决定。
    const width = Math.min(
      Math.max(drag.startRect.width + dx, CHAT_FLOAT_MIN_WIDTH),
      Math.max(CHAT_FLOAT_MIN_WIDTH, bounds.width - drag.startRect.left),
    );
    const height = Math.min(
      Math.max(drag.startRect.height + dy, CHAT_FLOAT_MIN_HEIGHT),
      Math.max(CHAT_FLOAT_MIN_HEIGHT, bounds.height - drag.startRect.top),
    );
    applyRect({ left: drag.startRect.left, top: drag.startRect.top, width, height });
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // 指针已经结束：无需再释放。
    }
    persist(collapsedRef.current);
  }

  function lostPointerCapture(): void {
    if (dragRef.current === null) return;
    dragRef.current = null;
    persist(collapsedRef.current);
  }

  function collapse(): void {
    const current = rectRef.current;
    if (current !== null) writeChatFloatStored(sessionRef.current, current, true);
    collapsedRef.current = true;
    setCollapsed(true);
  }

  function restore(): void {
    const body = bodyRef.current;
    const current = rectRef.current;
    if (body !== null && current !== null) {
      const bounds = body.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        applyRect(clampChatFloatRect(current, bounds.width, bounds.height));
      }
    }
    if (rectRef.current !== null) {
      writeChatFloatStored(sessionRef.current, rectRef.current, false);
    }
    collapsedRef.current = false;
    setCollapsed(false);
  }

  const style: CSSProperties | undefined =
    expanded && !collapsed && rect !== null
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : undefined;

  return {
    collapsed,
    style,
    startMove,
    startResize,
    moveDrag,
    endDrag,
    lostPointerCapture,
    collapse,
    restore,
  };
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
          {formatChatTime(cancellation.createdAt, now)}
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
  quizzes,
  onOpen,
}: {
  readonly quizzes: readonly QuizItem[];
  readonly onOpen: () => void;
}): JSX.Element {
  const questions = quizzes.reduce((n, q) => n + q.questions.length, 0);

  return (
    <section className="quiz-invite">
      <div className="quiz-invite-head">
        <span className="quiz-invite-icon">
          <Icon name="file" size={18} />
        </span>
        <div className="quiz-invite-text">
          <strong>练习已生成</strong>
          <p>
            {quizzes.length} 套 · {questions} 题 · 选择题确定性判分 · 主观题 AI 批改
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onOpen}>
          查看练习
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
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

/** 中断原因 → 用户话术（后端只给四个稳定值）。 */
function interruptReasonLabel(reason: string | null | undefined): string {
  if (reason === 'user_stopped') return '你点的停止';
  if (reason === 'insufficient_balance') return '余额不足';
  if (reason === 'network') return '网络断开';
  return '出现错误';
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
 * · failed      —— 失败但保留了已生成部分，只审这部分；
 * · running     —— 仍在生成，不可选。
 */
function isReviewableTurn(turn: ReviewTurn): boolean {
  return (
    (turn.state === 'done' || turn.state === 'interrupted' || turn.state === 'failed') &&
    turn.assistant !== null
  );
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

function ChatDayDivider({ ts, now }: { readonly ts: number; readonly now: number }): JSX.Element {
  const label = formatDayLabel(ts, now);
  return (
    <div className="chat-day" role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );
}

function ServerMessage({
  message,
  verdict,
  notify,
  now,
  canSpeak,
  speaking,
  onSpeak,
}: {
  readonly message: MessageDto;
  readonly verdict: VerdictDto | undefined;
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
          <time
            className="msg-meta-time"
            dateTime={new Date(message.createdAt).toISOString()}
            title={formatDateTime(message.createdAt)}
          >
            {formatChatTime(message.createdAt, now)}
          </time>
        </div>
      </div>
    );
  }

  if (message.role === 'system') {
    return (
      <div className="msg-system">
        <Icon name="info" size={14} />
        <span className="msg-system-text">{message.text}</span>
        <time
          className="msg-system-time"
          dateTime={new Date(message.createdAt).toISOString()}
          title={formatDateTime(message.createdAt)}
        >
          {formatChatTime(message.createdAt, now)}
        </time>
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
        <time
          className="msg-time"
          dateTime={new Date(message.createdAt).toISOString()}
          title={formatDateTime(message.createdAt)}
        >
          {formatChatTime(message.createdAt, now)}
        </time>
        {message.status === 'failed' && <Badge tone="danger">未完成</Badge>}
        {message.status === 'interrupted' && (
          <Badge tone="warn" title="这一轮没有正常结束；已保留完成的部分，可以审查">
            已中断 · {interruptReasonLabel(message.interruptReason)}
          </Badge>
        )}
      </header>

      <ProcessPanel
        rounds={rounds}
        narration={message.narration ?? ''}
        narrationReasoning={message.reasoning ?? ''}
        narrationTranslated={message.reasoningTranslated ?? ''}
        // ★ 中断轮次默认展开：已完成的思考/工具轨迹不该被折叠藏起来。
        defaultOpen={message.status === 'interrupted'}
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
  now,
  onOpenMemory,
  onRetry,
  onCopy,
}: {
  readonly turn: LiveTurn;
  readonly now: number;
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
          <time
            className="msg-meta-time"
            dateTime={new Date(turn.startedAt).toISOString()}
            title={formatDateTime(turn.startedAt)}
          >
            {formatChatTime(turn.startedAt, now)}
          </time>
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
          <time
            className="msg-time"
            dateTime={new Date(turn.startedAt).toISOString()}
            title={formatDateTime(turn.startedAt)}
          >
            {formatChatTime(turn.startedAt, now)}
          </time>
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
          </footer>
        )}
      </article>
    </>
  );
}
