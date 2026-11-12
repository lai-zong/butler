'use client';

/**
 * 内嵌浏览器面板 —— 右栏「浏览器」页签
 *
 * 九块能力：
 *   · 画面：订阅 `/api/browser/stream` 的 SSE 帧，等比缩放到面板里；
 *   · 标签：工具栏最上面一行列出所有标签页，可新建 / 切换 / 关闭（/api/browser/tabs）；
 *   · 操作：地址栏、前进后退刷新、鼠标/滚轮/键盘都转发给服务端的 CDP 浏览器；
 *   · 输入：画面里藏一个看不见的 <textarea> 专门承接中文输入法，另有一个
 *     「粘贴」按钮把本地剪贴板读成 text 送进页面；
 *   · 下载：弹层列出 `<数据目录>/browser-downloads` 里的文件（GET /api/browser/downloads）；
 *   · 给 AI：读当前页正文与截图，整理成问题交给父组件**填进输入框**（不自动发送）；
 *   · 自愈：轮询发现浏览器进程被外部关掉时，收起画面、清空标签与地址栏，
 *     等用户点「重新启动」——不自动拉起，因为可能是用户自己在别的程序里关的；
 *   · 窄栏：右栏被拖窄时由 CSS 容器查询把「粘贴 / 下载 / 让 AI 看」收成纯图标，
 *     地址栏保底 120px（见 chat.css 的 @container 段）；
 *   · 沉浸：工具栏最右侧的「全屏」把画面铺满面板（纯面板内状态，不调用
 *     requestFullscreen），Esc 或画面右上角的浮钮退出。
 *
 * ★ 为什么键盘要经过一个看不见的 <textarea>：
 *   Chromium 只给「可编辑元素」派发 composition 事件。画面容器是个 div，
 *   没有可编辑性，输入法根本不会启动 —— 中文只能一个字母一个字母地被 keydown
 *   当成拼音发出去。所以画面里放一个 1px、透明、不吃指针事件的 textarea 承接组字：
 *   它的 value 永远清空，只当输入法的落点；普通字符与特殊键仍由 keydown 逐键转发。
 *
 * ★ 为什么要懒启动：
 *   一个 Chromium 实例要几百 MB。这里只在组件挂载时（= 用户第一次点中「浏览器」页签）
 *   才 POST /api/browser/start；页面打开、用户不点浏览器时完全不起进程。
 *
 * ★ 为什么坐标要自己换算：
 *   `/api/browser/input` 收的是页面 viewport 坐标（服务端固定 1280×800），
 *   画面却按面板宽度缩放，`object-fit: contain` 还会留出黑边。
 *   直接拿 `<img>` 盒子尺寸去除会整体偏移，越靠右下偏得越多，
 *   所以先反推出「真正画出来的矩形」，再按 视口宽 / 显示宽 换算。
 *
 * ★ 为什么画面用 `<img>` 而不是 canvas：
 *   服务端已经压过 jpeg，`<img>` 让浏览器自己解码与缓存；帧到达时只换一次 src，
 *   不必再写 requestAnimationFrame 绘制循环。也刻意不把 base64 放进 React state：
 *   每秒十几次的整帧数据会让面板反复重渲染。
 */

import { useEffect, useRef, useState } from 'react';
import type {
  ClipboardEvent as ReactClipboardEvent,
  CompositionEvent as ReactCompositionEvent,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

import { Icon } from '../components/Icon';
import { ApiError, errorMessage, fetchJson, postJson } from '../lib/api.js';
import {
  gatewayRpc,
  loadGatewayInfo,
  sendGatewayInput,
  streamGatewayFrames,
  type GatewayInfo,
} from './browserGatewayClient.js';

interface BrowserPanelProps {
  /** 只用于「切换会话时收起 AI 阅读面板」；浏览器进程本身是全局的单实例。 */
  readonly sessionId: string | null;
  /** 把整理好的问题填进对话输入框；实现方只填空、不发送。 */
  readonly onSendToButler: (text: string) => void;
  /** 面板是否已占满主区域（由 ChatView 持有；全屏按钮会切换它） */
  readonly maximized: boolean;
  /** 切换占满/还原；全屏与「展开」现在是同一个状态机 */
  readonly onMaximizedChange: (next: boolean) => void;
}

interface OkResponse {
  readonly ok: boolean;
}

interface NavigateResponse extends OkResponse {
  readonly url: string;
  readonly kind: 'url' | 'search';
}

interface BrowserStateResponse extends OkResponse {
  readonly running: boolean;
  readonly url?: string;
  readonly title?: string;
  readonly canBack?: boolean;
  readonly canForward?: boolean;
  /** 进程还在但这次读取失败（切页/卡顿），不是"已退出" */
  readonly error?: string;
}

interface BrowserReadResponse extends OkResponse {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly screenshot: string;
}

interface BrowserFrame {
  readonly data: string;
  readonly width: number;
  readonly height: number;
  /** 服务端产生这一帧的时间；用于丢弃乱序到达的旧帧 */
  readonly at: number;
}

/** 一个标签页；`active` 由服务端按当前串流页判定，地址栏与画面都跟着它。 */
interface BrowserTab {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
}

interface TabsResponse extends OkResponse {
  /** 浏览器没起来时服务端回 `{ok:true,tabs:[],code}`，所以按可选处理。 */
  readonly tabs?: readonly unknown[];
}

/** 下载目录里的一项；服务端只给了这三个字段，展示需要的也只有这三个。 */
interface DownloadItem {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface DownloadsResponse extends OkResponse {
  /** 服务端在浏览器没起来时会回 `{ok:true, items:[], code}`，所以按可选处理。 */
  readonly items?: readonly unknown[];
}

interface PageState {
  readonly running: boolean;
  readonly url: string;
  readonly title: string;
  readonly canBack: boolean;
  readonly canForward: boolean;
}

interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

type BootState =
  | { readonly status: 'starting' }
  | { readonly status: 'ready' }
  /**
   * 浏览器进程在启动成功之后被外部关掉了（轮询发现 running:false）。
   *
   * ★ 为什么和 failed 分开：failed 是「起不来」，要解释缺浏览器 / 启动报错；
   *   exited 是「本来好好的、现在没了」，只需要一句提示和一个重启入口。
   *   混用 failed 会让一个只是被关掉的进程看起来像环境坏了。
   */
  | { readonly status: 'exited' }
  | { readonly status: 'failed'; readonly message: string; readonly noBrowser: boolean };

type ReadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly page: BrowserReadResponse }
  | { readonly status: 'error'; readonly message: string };

type DownloadsState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly DownloadItem[] }
  | { readonly status: 'error'; readonly message: string };

type BrowserAction = 'back' | 'forward' | 'reload';
type TabAction = 'new' | 'activate' | 'close';
type MouseAction = 'down' | 'up' | 'move' | 'wheel';
type MouseButton = 'left' | 'middle' | 'right';

/** 服务端的页面 viewport；帧里带真实宽高，这里只是第一帧到达前的兜底。 */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
/** 状态轮询间隔：页签可见时每 2 秒同步一次标题 / URL / 前进后退可用性。 */
const STATE_POLL_MS = 1_000;
/**
 * 标签轮询间隔。
 *
 * ★ 比状态轮询略慢：每轮要用 CDP 逐个标签取标题。1.2 秒足够让
 *   「点进新页面 → 标签标题变化」看起来是即时的，又不会白烧 CPU。
 */
const TABS_POLL_MS = 1_200;
/** AI 面板里展示的正文长度（需求是前 800 字）。 */
const READ_PREVIEW_CHARS = 800;
/** 真正发给管家的正文上限；太长会把一轮上下文挤满。 */
const READ_SEND_CHARS = 4_000;
/**
 * 单键转发集合。
 *
 * ★ 只收这些：可打印字符走 `{type:'text'}`（服务端用 Input.insertText，中文/emoji 也能进），
 *   特殊键必须走 `{type:'key'}` 才能拿到 keyCode（回车提交、Tab 换焦点、方向键移动）。
 *   Delete 服务端也支持，顺手带上，退格之外的删除行为才完整。
 */
const SPECIAL_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/**
 * 输入法上屏后的「补发按键」忽略窗口（毫秒）。
 *
 * ★ Chrome 在 compositionend 之后还会替确认键（回车 / 空格）补一个 keydown，
 *   那是输入法在选候选词，不是用户想发给远端的回车。不吞掉的话，
 *   中文输入完按回车确认，远端页面的输入框会被同时"提交"一次。
 *   窗口取 100ms：比人手连按两下的间隔短，不会误吞真正的回车。
 */
const IME_COMMIT_GUARD_MS = 100;

function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const data = err.data;
  if (typeof data !== 'object' || data === null) return null;
  const code = (data as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : null;
}

/** SSE 的 `event: error` 里是 `{error, code}`；解析不出来就当作普通连接错误。 */
function serverErrorOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const error = (value as Record<string, unknown>)['error'];
    return typeof error === 'string' && error.length > 0 ? error : null;
  } catch {
    return null;
  }
}

/** 帧格式由服务端约定；形状不对就丢弃，避免一帧脏数据把画面弄坏。 */
function parseFrame(raw: string): BrowserFrame | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const rec = value as Record<string, unknown>;
    const data = rec['data'];
    if (typeof data !== 'string' || data.length === 0) return null;
    const width = rec['width'];
    const height = rec['height'];
    const at = rec['at'];
    return {
      data,
      width: typeof width === 'number' && width > 0 ? width : DEFAULT_VIEWPORT.width,
      height: typeof height === 'number' && height > 0 ? height : DEFAULT_VIEWPORT.height,
      at: typeof at === 'number' ? at : Date.now(),
    };
  } catch {
    return null;
  }
}

function buttonOf(button: number): MouseButton | null {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return null;
}

/**
 * 下载列表的响应是外部输入（目录里有什么就是什么），形状不对的项直接丢。
 * 只保留 name 是字符串的项，size / mtimeMs 缺了就用 0，展示层自己会藏起来。
 */
function parseDownloads(raw: unknown): readonly DownloadItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DownloadItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const name = rec['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const size = rec['size'];
    const mtimeMs = rec['mtimeMs'];
    out.push({
      name,
      size: typeof size === 'number' && Number.isFinite(size) ? size : 0,
      mtimeMs: typeof mtimeMs === 'number' && Number.isFinite(mtimeMs) ? mtimeMs : 0,
    });
  }
  return out;
}

/**
 * 标签列表同样是外部输入（浏览器里开着什么就是什么），形状不对的项直接丢。
 * ★ id 是后续 activate / close 的唯一凭据：没有 id 的项留在界面上，
 *   点下去只会换回一个 400。
 */
function parseTabs(raw: unknown): readonly BrowserTab[] {
  if (!Array.isArray(raw)) return [];
  const out: BrowserTab[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const id = rec['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    const title = rec['title'];
    const url = rec['url'];
    out.push({
      id,
      title: typeof title === 'string' ? title : '',
      url: typeof url === 'string' ? url : '',
      active: rec['active'] === true,
    });
  }
  return out;
}

/** URL 的 host；about:blank、chrome-error: 这类地址没有 host，返回空串。 */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 服务端给的标题里，哪些算「真有标题」。
 *
 * ★ 有些内核会把 about:blank 或者网址本身当作标题回给我们（页面没写 <title> 时），
 *   这种"标题"没有信息量，按无标题处理才能显示「新标签页」或主机名。
 */
function tabTitleOf(tab: BrowserTab): string {
  const title = tab.title.trim();
  if (title.length === 0 || title === 'about:blank' || title === tab.url) return '';
  return title;
}

/**
 * 标签上显示的文字。
 *
 * ★ 顺序：页面标题 → URL 主机名 → 「新标签页」。
 *   新开的就是 about:blank，既没标题也没 host；有 URL 却没标题时（部分单页应用）
 *   显示主机名比显示整条网址有用 —— 标签很窄，路径在这里是噪音。
 *   超长不在这里截：交给 CSS 的 text-overflow: ellipsis，跟着实际宽度省略。
 */
function tabLabel(tab: BrowserTab): string {
  const title = tabTitleOf(tab);
  if (title.length > 0) return title;
  const host = urlHost(tab.url);
  return host.length > 0 ? host : '新标签页';
}

/** 字节数 → 一眼能比出量级的大小；列表里不需要精确到字节。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? 'KB'}`;
}

/**
 * mtimeMs → `YYYY-MM-DD HH:mm`。
 *
 * ★ 不用 toLocaleString：格式跟着系统区域走，中英文环境下长度都不一样，
 *   一列时间参差不齐；面板里这一列用的是等宽字体，定长才好对齐。
 */
function formatMtime(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return '';
  const date = new Date(mtimeMs);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function BrowserPanel({
  sessionId,
  onSendToButler,
  maximized,
  onMaximizedChange,
}: BrowserPanelProps): JSX.Element {
  // ── 启动 / 画面连接 ────────────────────────────────────────────────
  const [boot, setBoot] = useState<BootState>({ status: 'starting' });
  const [streamError, setStreamError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);

  // ── 页面状态 / 地址栏 ──────────────────────────────────────────────
  const [pageInfo, setPageInfo] = useState<PageState | null>(null);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── 标签条 ─────────────────────────────────────────────────────────
  const [tabs, setTabs] = useState<readonly BrowserTab[]>([]);
  /**
   * 是否有标签操作在途。
   * 和 busy 分开：切换标签时地址栏、前进后退都不该被一起锁住；
   * 这个只用来禁用标签条自己，避免连点发出多个 activate / close。
   */
  const [tabBusy, setTabBusy] = useState(false);

  /**
   * 当前活动标签 id。
   * 只给下面的「把活动标签滚进可视区」当依赖用：标签很多时要横向滚动，
   * 切过去的那个可能整个在可视区外，不滚过去用户会以为点了没反应。
   */
  const activeTabId = tabs.find((tab) => tab.active)?.id ?? '';

  // ── 「让 AI 看」面板 ───────────────────────────────────────────────
  const [read, setRead] = useState<ReadState>({ status: 'idle' });

  // ── 下载弹层 ───────────────────────────────────────────────────────
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [downloads, setDownloads] = useState<DownloadsState>({ status: 'idle' });

  /**
   * 粘贴失败时的兜底提示。
   * 单独一个 state 而不是复用 actionError：这不是"操作失败"，是"换个办法"，
   * 红框会让人以为页面出问题了；但也不能不说 —— 点了没反应等于功能坏了。
   */
  const [hint, setHint] = useState<string | null>(null);

  /** 画面是否持有键盘；只用来画那圈高亮边框（见 CSS 的 .browser-stage.is-focused）。 */
  const [stageFocused, setStageFocused] = useState(false);

  /**
   * 面板内「沉浸全屏」。
   *
   * ★ 为什么不用 requestFullscreen()：需求是「面板内沉浸」，让画面盖住整个应用窗口
   *   反而会把旁边的对话一起藏掉；而且原生全屏的进入 / 退出语义由浏览器掌握，
   *   我们没法保证 Esc 先关弹层、再退沉浸的顺序。
   * ★ 为什么只隐藏不卸载工具栏：标签轮询、状态轮询与 SSE 都挂在组件上，
   *   DOM 重建会顺手把流断开；沉浸只是一个显示状态，CSS 隐藏就够。
   */
  const [immersive, setImmersive] = useState(false);

  /**
   * 组件是否还活着。
   * 请求都是异步的，卸载后回来再 setState 虽然 React 18 不再报警，
   * 但会白跑一遍 EventSource 重连逻辑，用一个 ref 直接剪掉。
   */
  const aliveRef = useRef(true);
  const streamRef = useRef<EventSource | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 本地网关：输入与画面直连它，绕开 Next dev 的每请求开销。 */
  const gatewayRef = useRef<GatewayInfo | null>(null);
  /** 网关帧流的取消句柄（与 SSE 二选一）。 */
  const gatewayAbortRef = useRef<AbortController | null>(null);
  /** 渲染序号：解码是异步的，旧帧解码完不能覆盖新帧。 */
  const renderSeqRef = useRef(0);
  /** 工具栏上的「全屏」按钮；退出沉浸后要把键盘焦点还给它（它随工具栏一起被隐藏过）。 */
  const immersiveToggleRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  /** 承接输入法的隐藏输入框；它才是真正持有焦点、产生 composition 事件的元素。 */
  const imeRef = useRef<HTMLTextAreaElement | null>(null);
  /** 下载按钮 + 弹层的外壳，用来判断"点在弹层外面"。 */
  const downloadsWrapRef = useRef<HTMLDivElement | null>(null);
  /** 是否正在输入法组字（拼音还没上屏）；组字期间一个键都不往页面发。 */
  const composingRef = useRef(false);
  /** 最近一次 compositionend 的时刻，用来吞掉上屏那一下的补发按键。 */
  const commitAtRef = useRef(0);
  /** 最近一帧的 viewport 尺寸；坐标换算按它算，不用写死 1280。 */
  /** 已显示帧的时间戳：resize/补帧可能乱序到达，旧帧不能覆盖新帧。 */
  const lastFrameAtRef = useRef(0);
  const frameSizeRef = useRef<{ width: number; height: number }>({
    width: DEFAULT_VIEWPORT.width,
    height: DEFAULT_VIEWPORT.height,
  });
  /** 状态请求序号：轮询与手动刷新可能并发，只认最后一次的响应。 */
  const stateSeqRef = useRef(0);
  /** 标签请求序号：2.5s 轮询、手动刷新、标签操作后会并发，同样只认最后一次。 */
  const tabsSeqRef = useRef(0);
  /** 标签条的横向滚动区；用来把切过去的活动标签滚进可视区。 */
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  /** 上一次的非空活动标签 id；用来区分「用户切了标签」和「标签列表第一次加载出来」。 */
  const lastActiveTabRef = useRef('');
  /**
   * 当前启动状态。
   * refreshTabs 会被定时器闭包和事件回调调用，读 state 会拿到创建闭包那一刻的旧值，
   * 所以用 ref 存一份"现在是 ready 吗"，请求只在浏览器已启动时发出。
   */
  const bootStatusRef = useRef<BootState['status']>('starting');
  /** 标签操作是否在途（同步判断）：state 要等一次渲染才生效，连点会同时过检查。 */
  const tabBusyRef = useRef(false);
  const dragRef = useRef<{ active: boolean; button: MouseButton }>({
    active: false,
    button: 'left',
  });
  const lastPointRef = useRef<ViewportPoint | null>(null);
  const lastMoveRef = useRef<ViewportPoint | null>(null);
  /** 滚轮增量先累加、定时合并发送：触控板一次滑动几十个事件，逐个 POST 只会拖慢主线程。 */
  const wheelDeltaRef = useRef({ x: 0, y: 0, timer: 0 });
  /** 指针移动节流：拖拽/悬停时 pointermove 每秒可达上百个，30ms 一次足够跟手。 */
  const lastMoveAtRef = useRef(0);
  /** 滚轮发生的位置：合并成一次发送时仍要落到用户真正指着的点上。 */
  const wheelPointRef = useRef<{ x: number; y: number } | null>(null);
  /** 最近一次上报给服务端的视口尺寸，避免 1~3px 抖动重复触发 resize。 */
  const lastResizeRef = useRef<{ width: number; height: number } | null>(null);
  const resizeTimerRef = useRef<number | null>(null);

  // ── 启动 ───────────────────────────────────────────────────────────

  /**
   * 清掉画面上的当前帧。
   *
   * ★ 为什么连 src 一起删：hasFrame=false 只是用 CSS 把 <img> 藏起来，
   *   元素里还攥着上一帧的 base64（1280×800 的 jpeg，几百 KB）。
   *   重启后新帧到达之前它仍可能被重绘，用户第一眼看到的就是"上一帧旧画面"。
   */
  function clearFrame(): void {
    setHasFrame(false);
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas !== null && canvas !== undefined && ctx !== null && ctx !== undefined) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  /**
   * 浏览器进程在启动成功后退出时的收尾。
   *
   * ★ 为什么必须立刻离开 ready：服务端已经在回 running:false，但面板如果停在 ready，
   *   画面会永远停在最后一帧、按钮全部可点，用户只有点下去才会收到 409。
   * ★ 为什么主动关 EventSource：进程没了，服务端那条流不会自己报错，
   *   而 EventSource 断线后会自动重连 —— 留着就是一个每几秒打一次服务端的循环。
   * ★ 为什么不自动重启：进程可能是用户自己在别的程序里关掉的。
   *   悄悄再拉起一个，用户会以为"关不掉"；只提示，等用户点「重新启动」。
   */
  function markBrowserExited(): void {
    streamRef.current?.close();
    streamRef.current = null;
    // 作废在途的状态 / 标签请求：它们描述的都是"退出前"的浏览器，
    // 晚一步回来就会把刚清空的标签条和地址栏重新填满。
    stateSeqRef.current += 1;
    tabsSeqRef.current += 1;
    bootStatusRef.current = 'exited';
    setBoot({ status: 'exited' });
    // 画面流此时已经不可信：留着"画面已断开"的横幅，会和「浏览器已退出」说两遍。
    setStreamError(null);
    setPageInfo(null);
    setAddress('');
    setTabs([]);
    setActionError(null);
    setHint(null);
    // 在途操作可能永远不返回（进程都没了）：不在这里解锁的话，重启后标签条会一直点不动。
    setBusy(false);
    tabBusyRef.current = false;
    setTabBusy(false);
    dragRef.current = { active: false, button: 'left' };
    lastMoveRef.current = null;
    clearFrame();
  }

  /**
   * 启动浏览器并接上画面流。
   *
   * ★ 重试 / 重新连接也走这里：`/api/browser/start` 是幂等的（已启动会返回 reused），
   *   浏览器进程意外退出时它还能重新拉起一个新的，比只重连 SSE 更彻底。
   */
  async function bootBrowser(): Promise<void> {
    closeFrameStream();
    bootStatusRef.current = 'starting';
    setBoot({ status: 'starting' });
    setStreamError(null);
    // ★ 先清掉上一帧再启动：新进程起来后第一帧到达前，画面不能停在旧内容上。
    clearFrame();
    try {
      await postJson<OkResponse>('/api/browser/start', {});
      if (!aliveRef.current) return;
      bootStatusRef.current = 'ready';
      setBoot({ status: 'ready' });
      openStream();
      void refreshState();
    } catch (err) {
      if (!aliveRef.current) return;
      bootStatusRef.current = 'failed';
      // 浏览器没起来就没有标签可操作；留着上一轮的旧标签，只会是一排点不动的按钮。
      setTabs([]);
      setBoot({
        status: 'failed',
        message: errorMessage(err),
        noBrowser: apiErrorCode(err) === 'no_browser',
      });
    }
  }

  /**
   * 把一帧 JPEG 画到 canvas 上。
   *
   * ★ 为什么不用 <img src=blob>：每帧换 src 都会触发一次图片解码与布局/合成，
   *   30fps 下主线程容易抖；createImageBitmap 在后台解码，drawImage 只是一次拷贝，
   *   帧与帧之间更稳定，也没有 object URL 需要回收。
   * ★ 解码是异步的：用序号丢弃迟到的旧帧，避免"回退一帧"的顿挫。
   */
  function renderJpeg(width: number, height: number, jpeg: Uint8Array): void {
    if (!aliveRef.current) return;
    const seq = ++renderSeqRef.current;
    // Uint8Array 可能来自共享缓冲；复制成独立 ArrayBuffer 再交给 Blob
  const copy = new Uint8Array(jpeg.length);
  copy.set(jpeg);
  const blob = new Blob([copy], { type: 'image/jpeg' });
    void createImageBitmap(blob)
      .then((bitmap) => {
        if (!aliveRef.current || seq !== renderSeqRef.current) {
          bitmap.close();
          return;
        }
        const canvas = canvasRef.current;
        if (canvas === null) {
          bitmap.close();
          return;
        }
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (ctx === null) {
          bitmap.close();
          return;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        frameSizeRef.current = { width, height };
        setHasFrame(true);
      })
      .catch(() => {
        // 解码失败（半帧/已断开）直接丢，下一帧再来
      });
  }

  /** 关掉画面流（网关或 SSE）。 */
  function closeFrameStream(): void {
    gatewayAbortRef.current?.abort();
    gatewayAbortRef.current = null;
    streamRef.current?.close();
    streamRef.current = null;
  }

  /** 网关帧流：一条连接持续读二进制帧，失败时回退到 SSE。 */
  function openGatewayFrames(info: GatewayInfo): void {
    const controller = new AbortController();
    gatewayAbortRef.current = controller;
    void streamGatewayFrames(info, controller.signal, (frame) => {
      if (gatewayAbortRef.current !== controller) return;
      renderJpeg(frame.width, frame.height, frame.jpeg);
    })
      .catch(() => {
        if (!aliveRef.current || controller.signal.aborted) return;
        if (gatewayAbortRef.current === controller) gatewayAbortRef.current = null;
        // 网关不可用时仍有一条 SSE 可用，别让用户卡在"等待画面"
        openSseStream();
      })
      .finally(() => {
        if (gatewayAbortRef.current === controller) gatewayAbortRef.current = null;
      });
  }

  /** 旧版 SSE 通道：网关不可用时的兜底。 */
  function openSseStream(): void {
    streamRef.current?.close();
    const source = new EventSource('/api/browser/stream');
    streamRef.current = source;

    source.onmessage = (event: MessageEvent<string>) => {
      if (!aliveRef.current || streamRef.current !== source) return;
      const frame = parseFrame(event.data);
      if (frame === null) return;
      if (frame.at < lastFrameAtRef.current) return;
      lastFrameAtRef.current = frame.at;
      try {
        const raw = atob(frame.data);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
        renderJpeg(frame.width, frame.height, bytes);
      } catch {
        // base64 损坏：等下一帧
      }
    };

    source.addEventListener('error', (event: Event) => {
      if (!aliveRef.current || streamRef.current !== source) return;
      const message = event instanceof MessageEvent ? serverErrorOf(event.data) : null;
      source.close();
      streamRef.current = null;
      setStreamError(message ?? '画面连接中断');
    });
  }

  /** 建画面流：有网关走网关（低延迟二进制），否则回退 SSE。 */
  function openStream(): void {
    closeFrameStream();
    const gateway = gatewayRef.current;
    if (gateway !== null) {
      openGatewayFrames(gateway);
      return;
    }
    openSseStream();
  }

  /** 刷新标题 / URL / 前进后退可用性。 */
  async function refreshState(): Promise<void> {
    const seq = stateSeqRef.current + 1;
    stateSeqRef.current = seq;
    try {
      const res = await callBrowser<BrowserStateResponse>('state', {}, () => fetchJson<BrowserStateResponse>('/api/browser/state'));
      if (!aliveRef.current || seq !== stateSeqRef.current) return;
      /**
       * ★ 进程被杀掉时服务端回的是 200 + running:false，不是错误；
       *   不把这里当成"退出事件"，面板就会一直停在 ready：画面停住、
       *   按钮还能点，点了才 409。
       */
      /**
       * ★ 只有明确 `running === false` 才是退出；`running:true + error`
       *   是单次 CDP 抖动（切页/页面卡住），下一轮轮询通常会自愈，
       *   不能把标签和画面清掉。
       */
      if (res.running === false) {
        if (bootStatusRef.current === 'ready') markBrowserExited();
        return;
      }
      if (typeof res.error === 'string' && res.error.length > 0) return;
      // 退出 / 重启过程中旧的请求可能晚一步回来：那时画面已经清空，
      // 不能再把上一轮浏览器的标题和 URL 写回面板。
      if (bootStatusRef.current !== 'ready') return;
      const rawUrl = typeof res.url === 'string' ? res.url : '';
      // 起始页是内部 data: 页面，地址栏留空更像真实浏览器的新标签页
      const url = rawUrl.startsWith('data:text/html') ? '' : rawUrl;
      setPageInfo({
        running: res.running === true,
        url,
        title: typeof res.title === 'string' ? res.title : '',
        canBack: res.canBack === true,
        canForward: res.canForward === true,
      });
      // 地址栏只在用户没在编辑时跟随页面：否则输到一半的网址会被轮询冲掉。
      // 注意空字符串也要写回（新标签起始页），否则会一直留着上一个页面的网址。
      if (document.activeElement !== addressRef.current) setAddress(url);
    } catch {
      // 轮询失败保留上一份状态：真断线由画面流提示，这里再报一次只会来回闪。
    }
  }

  /**
   * 拉一次标签列表。
   *
   * ★ 浏览器没启动时直接不发请求：GET 会回 200 + 空列表，但标签操作（POST）会 409，
   *   而那时候按钮本来就该是禁用的 —— 不发比发完再解释便宜。
   * ★ 失败保留上一份：轮询 2.5 秒一次，偶发失败就清空会让标签条一闪一闪。
   */
  async function refreshTabs(): Promise<void> {
    if (bootStatusRef.current !== 'ready') return;
    const seq = tabsSeqRef.current + 1;
    tabsSeqRef.current = seq;
    try {
      const res = await callBrowser<TabsResponse>('tabs', {}, () => fetchJson<TabsResponse>('/api/browser/tabs'));
      if (!aliveRef.current || seq !== tabsSeqRef.current) return;
      // 退出时在途的标签请求也可能晚一步回来：不能在 exited 状态下把标签条重新填满。
      if (bootStatusRef.current !== 'ready') return;
      setTabs(parseTabs(res.tabs));
    } catch {
      // 断线由画面流统一提示；这里每 2.5 秒再弹一次只会刷屏。
    }
  }

  // ── 操作 ───────────────────────────────────────────────────────────

  async function navigateTo(): Promise<void> {
    const input = address.trim();
    if (input.length === 0 || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await callBrowser<NavigateResponse>('navigate', { input }, () => postJson<NavigateResponse>('/api/browser/navigate', { input }));
      if (!aliveRef.current) return;
      setAddress(res.url);
      void refreshState();
      // 导航会改页面标题，标签条要跟着变（服务端没有 title 变化的事件通道）。
      void refreshTabs();
      window.setTimeout(() => {
        if (!aliveRef.current || bootStatusRef.current !== 'ready') return;
        void refreshState();
        void refreshTabs();
      }, 700);
    } catch (err) {
      // 退出 / 重启期间不再弹 409：面板已经切到「浏览器已退出」，
      // 这时补一条"浏览器还没启动"只会和退出提示互相打架。
      if (aliveRef.current && bootStatusRef.current === 'ready') setActionError(errorMessage(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function runAction(action: BrowserAction): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await callBrowser<OkResponse>('action', { action }, () => postJson<OkResponse>('/api/browser/action', { action }));
      if (aliveRef.current) {
        void refreshState();
        // 前进 / 后退 / 刷新都可能换标题，顺手同步一次标签。
        void refreshTabs();
        window.setTimeout(() => {
          if (!aliveRef.current || bootStatusRef.current !== 'ready') return;
          void refreshState();
          void refreshTabs();
        }, 500);
      }
    } catch (err) {
      if (aliveRef.current && bootStatusRef.current === 'ready') setActionError(errorMessage(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  /**
   * 新建 / 切换 / 关闭标签。
   *
   * ★ 服务端在响应返回前就把串流切到新页面了，所以这里不重建 EventSource，
   *   只补拉一次标签列表与页面状态（地址栏、前进后退都跟着当前页变）。
   * ★ 用 tabBusy 而不是 busy：切标签时不该把地址栏和前进后退一起锁住。
   */
  async function runTabAction(action: TabAction, id?: string): Promise<void> {
    if (tabBusyRef.current || bootStatusRef.current !== 'ready') return;
    tabBusyRef.current = true;
    setTabBusy(true);
    setActionError(null);
    try {
      await callBrowser<OkResponse>(
        'tab',
        { action, ...(id !== undefined ? { id } : {}) },
        () =>
          postJson<OkResponse>('/api/browser/tabs', {
            action,
            ...(id !== undefined ? { id } : {}),
          }),
      );
      if (!aliveRef.current) return;
      void refreshTabs();
      void refreshState();
    } catch (err) {
      if (aliveRef.current && bootStatusRef.current === 'ready') setActionError(errorMessage(err));
    } finally {
      // ★ 失败也必须解锁：否则一次 409 会让整条标签条从此点不动。
      tabBusyRef.current = false;
      if (aliveRef.current) setTabBusy(false);
    }
  }

  // ── 输入转发 ───────────────────────────────────────────────────────

  /**
   * 屏幕坐标 → 页面 viewport 坐标。
   *
   * `object-fit: contain` 会在容器里留黑边，所以先按容器与帧的宽高比
   * 求出真正画出来的矩形，再换算；落在黑边上的点夹到视口边缘，
   * 避免发出负数坐标（CDP 会直接忽略）。
   */
  function toViewportPoint(clientX: number, clientY: number): ViewportPoint | null {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const frame = frameSizeRef.current;
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const left = rect.left + (rect.width - frame.width * scale) / 2;
    const top = rect.top + (rect.height - frame.height * scale) / 2;
    return {
      x: Math.min(frame.width - 1, Math.max(0, Math.round((clientX - left) / scale))),
      y: Math.min(frame.height - 1, Math.max(0, Math.round((clientY - top) / scale))),
    };
  }

  /** 画面实际绘制缩放比（页码 CSS px → 屏幕 px）；用于坐标与滚轮换算。 */
  function drawnScale(): number {
    const canvas = canvasRef.current;
    if (canvas === null) return 0;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 0;
    const frame = frameSizeRef.current;
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
    return Number.isFinite(scale) && scale > 0 ? scale : 0;
  }

  /**
   * 发送滚轮增量。
   *
   * ★ 必须带上真实 delta：服务端以前写死 +120，向上滚也会把页面往下滚。
   */
  function sendWheel(deltaX: number, deltaY: number): void {
    const point = wheelPointRef.current;
    if (point === null) return;
    const mapped = toViewportPoint(point.x, point.y);
    if (mapped === null) return;
    sendInput({ type: 'mouse', action: 'wheel', x: mapped.x, y: mapped.y, deltaX, deltaY });
  }

  /**
   * 发送一条输入事件：优先走长连接；环境不支持时退回单发 HTTP。
   *
   * ★ 不 await、不弹错：输入是高频动作，出错由画面流/状态轮询兜底，
   *   每个事件都弹一次只会刷屏。
   */
  /**
   * 优先走网关 RPC，失败再退回 Next 路由。
   *
   * ★ 画面/输入/导航/标签都在网关里，只有 start/close 这种生命周期动作留在 Next。
   */
  async function callBrowser<T>(
    op: string,
    args: Record<string, unknown>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    const gateway = gatewayRef.current;
    if (gateway !== null) {
      try {
        return await gatewayRpc<T>(gateway, op, args);
      } catch {
        // 网关临时不可用：退回原接口，保证功能不中断
      }
    }
    return fallback();
  }

  function sendInput(payload: Record<string, unknown>): void {
    const gateway = gatewayRef.current;
    if (gateway !== null) {
      void sendGatewayInput(gateway, payload);
      return;
    }
    void postJson<OkResponse>('/api/browser/input', payload).catch(() => undefined);
  }

  function postMouse(action: MouseAction, point: ViewportPoint, button?: MouseButton): void {
    sendInput({
      type: 'mouse',
      action,
      x: point.x,
      y: point.y,
      ...(button !== undefined ? { button } : {}),
    });
  }

  function sendPointer(action: MouseAction, clientX: number, clientY: number, button?: MouseButton): void {
    const point = toViewportPoint(clientX, clientY);
    if (point === null) return;
    lastPointRef.current = point;
    if (action === 'move') {
      // 不按住时的悬停 move 也要转发（远端页面的下拉菜单靠它触发），
      // 但指针每像素抖动都会发事件，按取整后的坐标去重后再发。
      const last = lastMoveRef.current;
      if (last !== null && last.x === point.x && last.y === point.y) return;
      const now = Date.now();
      if (now - lastMoveAtRef.current < 30) return;
      lastMoveAtRef.current = now;
      lastMoveRef.current = point;
    }
    postMouse(action, point, button);
    if (action === 'up') {
      /**
       * ★ 点击链接会在远端触发导航，但服务端没有导航事件推给前端；
       *   只靠 1 秒轮询会有明显"点了没反应"的错觉。
       *   这里在点击后补两次刷新，命中大多数页面加载完成的时机。
       */
      for (const delay of [350, 900]) {
        window.setTimeout(() => {
          if (!aliveRef.current || bootStatusRef.current !== 'ready') return;
          void refreshState();
          void refreshTabs();
        }, delay);
      }
    }
  }

  function sendText(text: string): void {
    if (text.length === 0) return;
    sendInput({ type: 'text', text });
  }

  function sendKey(key: string): void {
    sendInput({ type: 'key', key });
  }

  /**
   * 把焦点交给隐藏输入框。
   *
   * ★ 为什么非得聚焦它：Chromium 只给可编辑元素派发 composition 事件。
   *   焦点不在它身上，输入法就根本不启动，中文只能被打成拼音字母。
   *   按键转发本身不挑焦点（keydown 会冒泡到舞台），所以这次聚焦只服务输入法。
   */
  function focusIme(): void {
    const el = imeRef.current;
    // 已经聚焦就别再 focus：重复聚焦会把输入法刚组好的字打断。
    if (el !== null && document.activeElement !== el) el.focus({ preventScroll: true });
  }

  /**
   * 把隐藏输入框挪到点击处。
   *
   * ★ 输入法的候选词窗跟着 caret rect 走。把 1px 的输入框钉在左上角，
   *   候选词就会永远飘在画面角落；跟着点击点走，才像在"页面上打字"。
   *   坐标夹在舞台内部：绝对定位的子元素一旦越界，容器就可能多出可滚动区域，
   *   而这块画面是用坐标换算点给远端页面的，滚一下全错位。
   */
  function placeImeCaret(clientX: number, clientY: number): void {
    const el = imeRef.current;
    const stage = stageRef.current;
    if (el === null || stage === null) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.min(Math.max(0, Math.round(clientX - rect.left)), Math.floor(rect.width) - 1);
    const y = Math.min(Math.max(0, Math.round(clientY - rect.top)), Math.floor(rect.height) - 1);
    el.style.left = `${Math.max(0, x)}px`;
    el.style.top = `${Math.max(0, y)}px`;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const button = buttonOf(event.button);
    if (button === null) return;
    // 键盘输入依赖隐藏输入框的焦点：点画面就应该等于点浏览器窗口。
    // 先挪 caret 再聚焦，输入法候选窗才会出现在点击位置附近。
    placeImeCaret(event.clientX, event.clientY);
    focusIme();
    // ★ 阻止原生行为：不阻止的话浏览器会开始拖拽这张图片（拖出半透明缩略图），
    //   而且拖拽期间指针事件不再按预期派发，松手也收不到 up，远端页面会一直以为按着。
    event.preventDefault();
    dragRef.current = { active: true, button };
    lastMoveRef.current = null;
    try {
      // 捕获指针：拖出画面后 move / up 仍然回到这里，拖动才连贯。
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件、或指针已经被系统回收时会抛错；捕获失败最多丢几个 move，不影响点击。
    }
    sendPointer('down', event.clientX, event.clientY, button);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    sendPointer('move', event.clientX, event.clientY);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!dragRef.current.active) return;
    const button = dragRef.current.button;
    dragRef.current = { active: false, button: 'left' };
    sendPointer('up', event.clientX, event.clientY, button);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handlePointerCancel(): void {
    if (!dragRef.current.active) return;
    const button = dragRef.current.button;
    dragRef.current = { active: false, button: 'left' };
    // 系统把指针收走了（窗口失焦、触摸被打断）：补一个 up 的坐标，
    // 否则远端页面会停在「鼠标一直按着」的状态，整页都点不动。
    const point = lastPointRef.current;
    if (point !== null) postMouse('up', point, button);
  }

  /**
   * 画面获得 / 失去焦点。
   *
   * 这两个事件来自焦点在舞台内部的冒泡（focusin / focusout），所以隐藏输入框
   * 自己拿到焦点时也会走到这里 —— 高亮边框才不会因为焦点"搬了一格"就闪一下。
   */
  function handleStageFocus(event: ReactFocusEvent<HTMLDivElement>): void {
    setStageFocused(true);
    // 用 Tab 进来时焦点落在舞台本身（隐藏输入框是 tabIndex=-1，不是停靠点）。
    // 转给它，只用键盘的用户才打得出中文；点击进来时它本来就已经拿到焦点了。
    if (event.target === event.currentTarget) focusIme();
  }

  function handleStageBlur(event: ReactFocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget;
    // 焦点在舞台内部搬动（舞台 → 隐藏输入框）不算离开。
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setStageFocused(false);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    /**
     * ★ 舞台内部的本地控件（目前只有退出提示里的「重新启动」）不能吞按键：
     *   下面会 preventDefault，而 <button> 的 Enter / Space 激活正是默认行为，
     *   拦下来键盘用户就再也点不到那个重启入口。控件自己的键盘行为交给浏览器。
     */
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    // ★ Ctrl / Cmd / Alt 组合一律不转发：它们在本地是应用快捷键（保存、切换面板…），
    //   发到远端页面会同时触发页面里的同名快捷键，用户还不知道是哪边动的。
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // 输入法组字中的按键不发：字符由 compositionend 一次性提交，逐键发只会送出拼音。
    // 除了 isComposing 还看 composingRef：有的内核在"确认上屏"的那个 keydown 上
    // 已经把 isComposing 置回 false，只靠它会让拼音的尾字母漏出去。
    if (event.nativeEvent.isComposing || composingRef.current) return;
    const key = event.key;
    // ★ 上屏那一拍再吞一次：Chrome 会在 compositionend 之后替确认键补一个 keydown，
    //   那是输入法在选候选词。不吞的话，中文输完按回车，远端页面会被同时提交一次。
    const commitAt = commitAtRef.current;
    const sinceCommit = Date.now() - commitAt;
    if (
      commitAt !== 0 &&
      sinceCommit >= 0 &&
      sinceCommit <= IME_COMMIT_GUARD_MS &&
      (key === 'Enter' || key === ' ' || key === 'Escape')
    ) {
      event.preventDefault();
      return;
    }
    /**
     * ★ 沉浸模式下的 Esc 先用来退出，而不是当成远端按键转发：
     *   否则远端页面里的弹窗会先被关掉，本地却还停在沉浸模式里。
     * ★ 有弹层时让弹层先关（它们的 Esc 监听挂在 window 上）：这里不抢那一下，
     *   同一次按键就不会既关弹层又退沉浸。
     */
    if (key === 'Escape' && immersive && read.status === 'idle' && !downloadsOpen) {
      event.preventDefault();
      exitImmersive(false);
      return;
    }
    if (SPECIAL_KEYS.has(key)) {
      event.preventDefault();
      sendKey(key);
      return;
    }
    // 可打印单字符（含空格）走 insertText；同时按下的 Shift 已经体现在 key 里。
    if (key.length === 1) {
      event.preventDefault();
      sendText(key);
    }
  }

  /**
   * 输入法开始组字 / 还在组字。
   *
   * ★ 这两个回调本身不转发任何东西：组字过程中的文本是拼音中间态，发出去只会打出字母。
   *   compositionupdate 只用来把 composingRef 再置一次 —— 个别内核在焦点刚搬进
   *   输入框时会直接发 update 而不发 start，漏掉就会把拼音逐键发给页面。
   */
  function handleCompositionStart(): void {
    composingRef.current = true;
  }

  function handleCompositionUpdate(): void {
    composingRef.current = true;
  }

  /**
   * 组字结束：`event.data` 是输入法最终上屏的文字，只有这里发才不会重复。
   *
   * value 必须立刻清空：它是承接器不是输入框，留着内容下一次组字会把旧文本一起上屏。
   */
  function handleCompositionEnd(event: ReactCompositionEvent<HTMLTextAreaElement>): void {
    composingRef.current = false;
    commitAtRef.current = Date.now();
    event.currentTarget.value = '';
    sendText(event.data);
  }

  /**
   * 隐藏输入框里的 Ctrl+V。
   *
   * ★ 它是可编辑元素，Ctrl+V 会直接粘进这个看不见的框里 —— 用户只会看到
   *   "什么都没发生"，框里还留下一堆文本。这里截下来转成 text 输入发给页面：
   *   剪贴板读取被浏览器拒绝时，面板提示的"请用 Ctrl+V"指的正是这条路。
   */
  function handleImePaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    event.currentTarget.value = '';
    sendText(text);
  }

  // ── 「让 AI 看」 ───────────────────────────────────────────────────

  async function openReadPanel(): Promise<void> {
    // 模态弹层要独占视线：顺手收起下载弹层，免得两个浮层叠在一起。
    setDownloadsOpen(false);
    setRead({ status: 'loading' });
    try {
      const res = await callBrowser<BrowserReadResponse>('read', {}, () => postJson<BrowserReadResponse>('/api/browser/read', {}));
      if (!aliveRef.current) return;
      setRead({ status: 'ready', page: res });
    } catch (err) {
      if (!aliveRef.current) return;
      setRead({ status: 'error', message: errorMessage(err) });
    }
  }

  /**
   * 把页面整理成一段问题交给父组件。
   *
   * ★ 只填进输入框、不自动发送：页面正文是不可信输入，发不发、怎么问，得由用户看一眼再决定。
   */
  function sendPageToButler(page: BrowserReadResponse): void {
    const text = [
      '请看看这个浏览器页面，然后回答我的问题：',
      `URL: ${page.url}`,
      `标题: ${page.title}`,
      '',
      '页面正文（节选）：',
      page.text.slice(0, READ_SEND_CHARS),
    ].join('\n');
    onSendToButler(text);
    setRead({ status: 'idle' });
  }

  // ── 粘贴 / 下载 ────────────────────────────────────────────────────

  /**
   * 「粘贴」：把本地剪贴板里的文本送进远端页面。
   *
   * ★ readText 必须留在点击的手势里同步调用：先 await 别的东西再读，
   *   用户激活状态就过期了，浏览器会直接拒绝。
   * ★ 失败绝不能静默：点了按钮却什么都没发生，用户只会以为功能坏了。
   *   兜底路径是画面聚焦后按 Ctrl+V（见 handleImePaste）。
   */
  async function pasteFromClipboard(): Promise<void> {
    setHint(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!aliveRef.current) return;
      if (text.length === 0) {
        // 读成功了、只是里面没有文本：这时说"读不到"是假话，所以分开提示。
        // 两种提示都给出 Ctrl+V，用户不需要判断自己遇到的是哪一种。
        setHint('剪贴板里没有文本；浏览器不允许读取剪贴板时请用 Ctrl+V');
        return;
      }
      sendText(text);
      // 粘完把焦点还给画面：接着就能用键盘，不用再点一下。
      focusIme();
    } catch {
      if (!aliveRef.current) return;
      setHint('浏览器不允许读取剪贴板，请用 Ctrl+V');
    }
  }

  /**
   * 「复制」：把远端页面里选中的文字写进系统剪贴板。
   *
   * ★ 选区由后端读（页面在别的进程里），写剪贴板必须在前端、且在点击手势内。
   *   没有选中时明确提示，而不是"复制成功"却什么都没进剪贴板。
   */
  async function copySelection(): Promise<void> {
    setHint(null);
    try {
      const res = await callBrowser<{ text?: unknown }>('selection', {}, () => fetchJson<{ text?: unknown }>('/api/browser/selection'));
      if (!aliveRef.current) return;
      const text = typeof res.text === 'string' ? res.text : '';
      if (text.length === 0) {
        setHint('页面里没有选中的文字：先在画面上拖选一段');
        return;
      }
      await navigator.clipboard.writeText(text);
      if (!aliveRef.current) return;
      setHint('已复制选中的文字');
    } catch {
      if (!aliveRef.current) return;
      setHint('复制失败：浏览器不允许写入剪贴板');
    }
  }

  /**
   * 拉一次下载列表。
   *
   * ★ 只在弹层打开时拉、不轮询：下载是低频动作，定时刷新不会让列表更快，
   *   只会让服务端隔几秒就去读一次磁盘。
   */
  async function loadDownloads(): Promise<void> {
    setDownloads({ status: 'loading' });
    try {
      const res = await callBrowser<DownloadsResponse>('downloads', {}, () => fetchJson<DownloadsResponse>('/api/browser/downloads'));
      if (!aliveRef.current) return;
      setDownloads({ status: 'ready', items: parseDownloads(res.items) });
    } catch (err) {
      if (!aliveRef.current) return;
      setDownloads({ status: 'error', message: errorMessage(err) });
    }
  }

  /** 点「下载」：开着就收起；要打开就先刷新一次，用户看到的永远是最新目录。 */
  function toggleDownloads(): void {
    if (downloadsOpen) {
      setDownloadsOpen(false);
      return;
    }
    setDownloadsOpen(true);
    void loadDownloads();
  }

  // ── 沉浸全屏 ───────────────────────────────────────────────────────

  /**
   * 进入沉浸模式。
   *
   * ★ 顺手收起下载弹层：进入后工具栏（含触发它的按钮）会被隐藏，
   *   弹层却还浮在画面上，用户会找不到关闭入口。
   */
  function enterImmersive(): void {
    setDownloadsOpen(false);
    setImmersive(true);
    // ★ 全屏 = 面板占满主区域（原「展开」）+ 隐藏面板内部工具栏：只做后者会留下黑边
    onMaximizedChange(true);
  }

  /**
   * 退出沉浸模式。
   *
   * ★ restoreFocus：退出这一刻工具栏还是 display:none，按钮要等这次渲染提交后
   *   才重新可见；立刻 focus() 会落在 body 上，键盘用户就失去了落点。
   *   等一帧再聚焦，焦点正好回到触发它的「全屏」按钮。
   */
  function exitImmersive(restoreFocus: boolean): void {
    setImmersive(false);
    onMaximizedChange(false);
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => {
      immersiveToggleRef.current?.focus();
    });
  }

  /** 工具栏按钮的开关；沉浸模式下按钮随工具栏隐藏，退出走浮钮或 Esc。 */
  function toggleImmersive(): void {
    if (immersive) {
      exitImmersive(true);
      return;
    }
    enterImmersive();
  }

  // ── 生命周期 ───────────────────────────────────────────────────────

  /**
   * 挂载 = 「浏览器」页签第一次被选中（ChatView 只在选中时渲染本组件）。
   * 所以这里就是需求里的「第一次可见才启动」，整页加载时不会误启动。
   */
  useEffect(() => {
    aliveRef.current = true;
    // 先拿网关地址（一次 Next 请求），之后的输入/画面都直连网关
    void (async () => {
      const gateway = await loadGatewayInfo();
      if (!aliveRef.current) return;
      if (gateway !== null) gatewayRef.current = gateway;
      void bootBrowser();
    })();
    return () => {
      aliveRef.current = false;
      closeFrameStream();
    };
    // 只在挂载时启动一次；bootBrowser 只依赖 ref 与 setState，不需要进依赖表。
  }, []);

  /** 每 2 秒同步一次页面状态；组件卸载（切走页签）时定时器随 effect 清理停掉。 */
  useEffect(() => {
    const timer = window.setInterval(() => {
      // 整个应用窗口切到后台时不必再轮询，回来后的下一拍自然补上。
      if (document.hidden) return;
      void refreshState();
    }, STATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * 标签条：浏览器启动成功后立刻拉一次，之后每 2.5 秒同步一次（标题会变）。
   *
   * ★ 为什么轮询：页面标题是页面自己改的（点进链接、单页应用换路由），
   *   服务端没有把 title 变化推给前端的通道；不轮询的话，标签会一直停在旧标题。
   * ★ 为什么依赖 boot.status：没启动成功（starting / failed）时这个 effect 根本不存在，
   *   连一次标签请求都不会发；重连成功（回到 ready）会自动重新拉起轮询。
   * ★ 定时器在依赖变化与卸载时都会清掉，不会留下第二个轮询在跑。
   */
  useEffect(() => {
    if (boot.status !== 'ready') return;
    void refreshTabs();
    const timer = window.setInterval(() => {
      // 窗口在后台时标题变化没人看，跳过这一拍；回到前台后的下一拍自然补上。
      if (document.hidden) return;
      void refreshTabs();
    }, TABS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [boot.status]);

  /**
   * 把活动标签滚进可视区。
   *
   * ★ 标签多到要横向滚动时，新建出来的标签在最右边、切到的标签也可能在可视区外，
   *   不滚过去界面看起来就是"点了没反应"。nearest 只滚最小距离，不会把用户
   *   自己滚到的位置一把拉回去。
   * ★ 只依赖活动标签 id：如果依赖整个列表，2.5 秒一次的轮询会反复触发，
   *   用户滚动标签条看到一半就被拽回当前页。
   */
  useEffect(() => {
    const box = tabsScrollRef.current;
    if (box === null) return;
    const active = box.querySelector<HTMLElement>('.browser-tab.is-active');
    if (active !== null) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  /**
   * 标签条：竖直滚轮 → 横向滚动。
   *
   * ★ 为什么需要它：横向滚动条在 Chromium 里是覆盖式的，静止时看不见；
   *   只有竖向滚轮的鼠标用户，标签一多就再也点不到左边那几个。
   * ★ 为什么用原生非 passive 监听：React 的 onWheel 在根节点是 passive 的，
   *   里面 preventDefault 不生效，滚标签条会把外面的页面一起滚走。
   * ★ 触控板本来就给横向增量：取绝对值大的那个轴，横向手势才不会被丢掉。
   */
  useEffect(() => {
    const box = tabsScrollRef.current;
    if (box === null) return;
    const onWheel = (event: WheelEvent): void => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      // 标签没多到要滚动时不接管：那时滚轮该归外面的页面。
      if (delta === 0 || box.scrollWidth <= box.clientWidth) return;
      event.preventDefault();
      box.scrollLeft += delta;
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, []);

  /**
   * 滚轮用原生监听。
   *
   * ★ React 的 onWheel 在根节点以 passive 注册，里面 preventDefault 不生效；
   *   这里挂非 passive 监听，让滚轮只发给远端页面，不带着本地面板一起滚。
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;

    /**
     * ★ 把屏幕上的滚动量换算成页面 CSS 像素：画面被缩小显示时，
     *   屏幕上滚 100px 等于页面里滚 100/scale px，否则触控板会显得"滚不动"。
     * ★ 按 rAF 合并：一帧内只发一次，触控板几十个事件不会变成几十个 POST。
     */
    const flush = (): void => {
      const pending = wheelDeltaRef.current;
      pending.timer = 0;
      const dx = pending.x;
      const dy = pending.y;
      pending.x = 0;
      pending.y = 0;
      if (dx === 0 && dy === 0) return;
      sendWheel(dx, dy);
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      wheelPointRef.current = { x: event.clientX, y: event.clientY };
      const scale = drawnScale();
      if (scale <= 0) return;
      wheelDeltaRef.current.x += event.deltaX / scale;
      wheelDeltaRef.current.y += event.deltaY / scale;
      if (wheelDeltaRef.current.timer === 0) {
        wheelDeltaRef.current.timer = window.setTimeout(flush, 30);
      }
    };

    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stage.removeEventListener('wheel', onWheel);
      if (wheelDeltaRef.current.timer !== 0) {
        window.clearTimeout(wheelDeltaRef.current.timer);
        wheelDeltaRef.current.timer = 0;
      }
    };
    // boot 从失败/启动中变成 ready 时画面容器会重新挂载，需要重新绑定。
  }, [boot.status]);

  /** AI 面板打开时挂一个 Esc 关闭；关闭后立刻摘掉监听。 */
  useEffect(() => {
    if (read.status === 'idle') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setRead({ status: 'idle' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [read.status]);

  /**
   * 下载弹层的「点外面关掉 / Esc 关掉」。
   *
   * ★ 不铺遮罩：它不该挡住画面，用户很可能是一边看页面一边开下载列表。
   *   所以只在打开期间挂两个 window 监听，关掉立刻摘掉，不留常驻监听。
   */
  useEffect(() => {
    if (!downloadsOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const wrap = downloadsWrapRef.current;
      // 点在按钮或弹层里不关：那是在和弹层本身交互（按钮自己还会 toggle）。
      if (wrap !== null && event.target instanceof Node && wrap.contains(event.target)) return;
      setDownloadsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDownloadsOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [downloadsOpen]);

  /**
   * 切换浏览器标签时自动退出沉浸。
   *
   * ★ 沉浸模式里标签条是隐藏的：不退出的话，用户看不到新标签、也点不到下一个，
   *   画面内容已经换页却没有任何可见的上下文。
   * ★ 只认「非空 id → 另一个非空 id」：启动后标签列表第一次加载出活动标签不是切换，
   *   不能把用户刚点开的沉浸模式顺手关掉。
   */
  useEffect(() => {
    if (activeTabId.length === 0 || lastActiveTabRef.current === activeTabId) return;
    const isSwitch = lastActiveTabRef.current.length > 0;
    lastActiveTabRef.current = activeTabId;
    if (isSwitch) setImmersive(false);
  }, [activeTabId]);

  /**
   * 进入沉浸后把焦点交给画面。
   *
   * ★ 触发全屏的按钮马上会被 CSS 隐藏，焦点随之落回 body：不主动搬进舞台，
   *   接下来的按键就不再转发给远端页面，画面看起来「点不动」。
   * ★ 卸载时组件里的沉浸状态随组件一起消失，不需要额外的全局清理。
   */
  useEffect(() => {
    if (!immersive) return;
    stageRef.current?.focus({ preventScroll: true });
  }, [immersive]);

  /**
   * 外部把面板还原（切到文件/审查页签、关闭面板）时，内部沉浸也要退出：
   * 否则工具栏还藏着，用户找不到任何按钮，只剩 Esc。
   */
  useEffect(() => {
    if (!maximized) setImmersive(false);
  }, [maximized]);

  /**
   * 沉浸模式的全局 Esc。
   *
   * ★ 焦点不一定在舞台里（刚点完按钮、或停在浮钮上），只在舞台的 onKeyDown 里
   *   处理会漏掉这些情况，所以再挂一个 window 监听。
   * ★ 弹层优先：阅读弹层 / 下载弹层各自也有 Esc 监听；它们那一下没关完之前
   *   不能顺手退出沉浸，否则按一次 Esc 会同时关两层。
   * ★ 舞台自己处理过的那一次已被 preventDefault，这里跳过（defaultPrevented），
   *   避免重复触发，也避免把焦点从画面挪回工具栏。
   */
  useEffect(() => {
    if (!immersive) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (read.status !== 'idle' || downloadsOpen) return;
      event.preventDefault();
      exitImmersive(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [immersive, read.status, downloadsOpen]);

  /**
   * 面板尺寸变化 → 同步远端视口。
   *
   * ★ 为什么必须做：远端如果固定 1280×800，缩到 600 宽的面板里就只能
   *   contain 缩放，文字变小、上下/左右留黑边；把视口改成面板尺寸后，
   *   页面会像真实浏览器窗口一样重排，画面也能铺满。
   * ★ 防抖 180ms + 4px 阈值：拖拽分栏时每秒几十次尺寸变化，不合并会把
   *   串流反复重启。
   */
  useEffect(() => {
    if (boot.status !== 'ready') return;
    const stage = stageRef.current;
    if (stage === null) return;

    const push = (): void => {
      const rect = stage.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 200 || height < 150) return;
      const last = lastResizeRef.current;
      if (last !== null && Math.abs(last.width - width) < 4 && Math.abs(last.height - height) < 4) return;
      lastResizeRef.current = { width, height };
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        void callBrowser<OkResponse>('resize', { width, height }, () =>
          postJson<OkResponse>('/api/browser/resize', { width, height }),
        ).catch(() => {
          // 尺寸同步失败不影响其它功能；下一轮 ResizeObserver 会再试
        });
      }, 180);
    };

    const observer = new ResizeObserver(push);
    observer.observe(stage);
    push();
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
  }, [boot.status]);

  /**
   * 页面切到后台时断开画面流。
   *
   * ★ 后台没人看画面，但 SSE 不断开的话服务端会继续保持 screencast，
   *   Edge 会持续截图编码；回来时再重连并补帧即可。
   */
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) {
        closeFrameStream();
      } else if (
        bootStatusRef.current === 'ready' &&
        streamRef.current === null &&
        gatewayAbortRef.current === null
      ) {
        openStream();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  /**
   * 切会话时收起 AI 面板。
   *
   * ★ 面板里的正文属于上一个会话的上下文，继续留着，用户点「发给管家」
   *   就会把 A 会话看的页面悄悄塞进 B 会话；收起比带过去安全。
   */
  useEffect(() => {
    setRead({ status: 'idle' });
  }, [sessionId]);

  // ── 渲染 ───────────────────────────────────────────────────────────

  const ready = boot.status === 'ready';
  const canBack = ready && pageInfo !== null && pageInfo.canBack;
  const canForward = ready && pageInfo !== null && pageInfo.canForward;
  /**
   * 标签条是否禁用。
   * 浏览器还没启动成功时，任何标签操作都会被服务端以 409 拒绝；
   * 有一个标签操作在途时再点，会并发改动服务端的"当前页"，画面可能对不上。
   */
  const tabsLocked = !ready || tabBusy;
  const dotClass =
    boot.status === 'failed' || boot.status === 'exited' || streamError !== null
      ? 'is-error'
      : boot.status === 'starting' || !hasFrame
        ? 'is-busy'
        : 'is-live';
  const statusTitle =
    boot.status === 'starting'
      ? '启动中…'
      : boot.status === 'exited'
        ? '浏览器已退出'
        : boot.status === 'failed'
          ? '浏览器未启动'
          : pageInfo === null
            ? '正在连接…'
            : pageInfo.title.length > 0
              ? pageInfo.title
              : pageInfo.running
                ? '无标题页面'
                : '浏览器未运行';
  const stageNote =
    boot.status === 'exited'
      ? {
          title: '浏览器已退出',
          hint: '进程可能被其它程序关掉了。重新启动会拉起一个新的浏览器进程，之前打开的页面不会自动恢复。',
        }
      : streamError !== null
        ? { title: '画面已断开', hint: '点上方「重新连接」重试' }
        : boot.status === 'starting'
          ? { title: '启动中…', hint: '首次启动 Chromium 需要几秒' }
          : { title: '等待画面…', hint: '页面还没有产生新帧' };

  /**
   * 下载弹层的内容区。
   *
   * ★ 空态、错误态都写死在弹层里而不是"什么都不显示"：
   *   一个空的白色弹层会让人以为列表没加载完。
   */
  function renderDownloadsBody(): JSX.Element {
    if (downloads.status === 'loading') {
      return (
        <div className="browser-downloads-body" aria-busy="true">
          <span className="review-spinner" aria-hidden="true" />
          <p>正在读取下载列表…</p>
        </div>
      );
    }
    if (downloads.status === 'error') {
      return (
        <div className="browser-downloads-body is-error" role="alert">
          <Icon name="alert" size={15} />
          <p>{downloads.message}</p>
        </div>
      );
    }
    if (downloads.status === 'ready' && downloads.items.length > 0) {
      return (
        <ul className="browser-downloads-list">
          {downloads.items.map((item) => {
            const time = formatMtime(item.mtimeMs);
            return (
              <li key={`${item.name}:${item.mtimeMs}`} className="browser-downloads-item">
                <span className="browser-downloads-name" title={item.name}>
                  {item.name}
                </span>
                <span className="browser-downloads-meta">
                  {formatBytes(item.size)}
                  {time.length > 0 ? ` · ${time}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      );
    }
    return (
      <div className="browser-downloads-body">
        <Icon name="download" size={15} />
        <p>还没有下载</p>
      </div>
    );
  }

  function renderReadPanel(): JSX.Element | null {
    if (read.status === 'idle') return null;
    return (
      <div
        className="browser-read-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          // 只认遮罩本身上的按下：在弹层里拖选文字时不该被关掉。
          if (event.button === 0 && event.target === event.currentTarget) {
            setRead({ status: 'idle' });
          }
        }}
      >
        <section className="browser-read" role="dialog" aria-modal="true" aria-label="让 AI 看当前页面">
          <header className="browser-read-head">
            <h3>让 AI 看这个页面</h3>
            <button
              type="button"
              className="browser-icon-btn"
              // 弹层一打开就把焦点收进来：画面容器会把 Tab 转给远端页面，
              // 键盘用户如果还停在外面，Tab 会被画面吞掉，进不了这个对话框。
              autoFocus
              onClick={() => setRead({ status: 'idle' })}
              aria-label="关闭"
            >
              <Icon name="close" size={13} />
            </button>
          </header>

          {read.status === 'loading' ? (
            <div className="browser-read-body is-busy" aria-busy="true">
              <span className="review-spinner" aria-hidden="true" />
              <p>正在读取页面正文与截图…</p>
            </div>
          ) : read.status === 'error' ? (
            <div className="browser-read-body is-error" role="alert">
              <Icon name="alert" size={20} />
              <p>{read.message}</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openReadPanel()}>
                重试
              </button>
            </div>
          ) : (
            <>
              <div className="browser-read-body">
                <p className="browser-read-title" title={read.page.title}>
                  {read.page.title.length > 0 ? read.page.title : '（无标题）'}
                </p>
                <p className="browser-read-url" title={read.page.url}>
                  {read.page.url}
                </p>
                {read.page.screenshot.length > 0 ? (
                  <img
                    className="browser-read-shot"
                    // 服务端的 read 返回 PNG（画面流才是 jpeg），这里分开写，别混用前缀。
                    src={`data:image/png;base64,${read.page.screenshot}`}
                    alt="页面截图缩略图"
                    draggable={false}
                  />
                ) : null}
                <pre className="browser-read-text">
                  {read.page.text.slice(0, READ_PREVIEW_CHARS).trim() || '（页面没有可读正文）'}
                </pre>
              </div>
              <footer className="browser-read-foot">
                <span>只读预览 · 点「发给管家」只填进输入框，不会自动发送</span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => sendPageToButler(read.page)}
                >
                  发给管家
                </button>
              </footer>
            </>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className={`browser-panel${immersive ? ' is-immersive' : ''}`}>
      <div className="browser-toolbar">
        {/*
          标签条：工具栏最上面一行。
          ★ 为什么单独占一行：标签会越开越多，和地址栏挤在同一行，最后被压到
            看不见的只能是地址栏和右侧按钮；单独一行 + 横向滚动，标签再多也只是
            滚动，不会撑破面板，也不会把「让 AI 看」挤没。
          ★ 只有一个标签时也显示：宽度一致，用户每次看到的工具栏结构都一样，
            不会因为"标签只剩一个"就突然跳一下高度。
        */}
        <div className="browser-tabs" role="group" aria-label="浏览器标签页">
          {/* 只有这一层滚动：+ 按钮放在滚动区外，标签再多也点得到「新建」。 */}
          <div className="browser-tabs-scroll" ref={tabsScrollRef}>
            {tabs.map((tab) => {
              const label = tabLabel(tab);
              // title 给完整名字：标签宽度有限，省略号之外还得能看到全文。
              // 没有真标题时退回正在显示的文字，避免悬停出现 about:blank。
              const fullTitle = tabTitleOf(tab) || label;
              return (
                <div key={tab.id} className={`browser-tab${tab.active ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className="browser-tab-main"
                    // 用 aria-pressed 而不是 tablist/tab：这里只有一个共用画面，
                    // 没有"每个标签各自一个面板"的结构，硬做成 tab 反而得编造 aria-controls。
                    aria-pressed={tab.active}
                    title={fullTitle}
                    disabled={tabsLocked}
                    onClick={() => void runTabAction('activate', tab.id)}
                  >
                    <span className="browser-tab-title">{label}</span>
                  </button>
                  <button
                    type="button"
                    className="browser-tab-close"
                    title="关闭标签页"
                    aria-label={`关闭标签页：${label}`}
                    disabled={tabsLocked}
                    onClick={() => void runTabAction('close', tab.id)}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="browser-icon-btn browser-tab-new"
            onClick={() => void runTabAction('new')}
            disabled={tabsLocked}
            title="新建标签页"
            aria-label="新建标签页"
          >
            <Icon name="plus" size={13} />
          </button>
        </div>

        <div className="browser-toolbar-row">
          <div className="browser-nav" role="group" aria-label="浏览器导航">
            <button
              type="button"
              className="browser-icon-btn"
              onClick={() => void runAction('back')}
              disabled={!canBack || busy}
              title="后退"
              aria-label="后退"
            >
              <Icon name="arrowLeft" size={14} />
            </button>
            <button
              type="button"
              className="browser-icon-btn"
              onClick={() => void runAction('forward')}
              disabled={!canForward || busy}
              title="前进"
              aria-label="前进"
            >
              {/* 图标集里只有左箭头，翻转一下就是右箭头，线宽和端点与其余图标一致。 */}
              <Icon name="arrowLeft" size={14} className="browser-flip" />
            </button>
            <button
              type="button"
              className="browser-icon-btn"
              onClick={() => void runAction('reload')}
              disabled={!ready || busy}
              title="刷新"
              aria-label="刷新"
            >
              <Icon name="refresh" size={14} />
            </button>
          </div>

          <form
            className="browser-address"
            onSubmit={(event) => {
              event.preventDefault();
              void navigateTo();
            }}
          >
            <Icon name="search" size={12} />
            <input
              ref={addressRef}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                // 显式处理 Enter：不依赖表单的隐式提交（不同内核细节不一致），
                // 同时避开输入法用 Enter 上屏的那一次（isComposing）。
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void navigateTo();
                }
              }}
              placeholder="输入网址或搜索词"
              aria-label="地址栏"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              disabled={!ready}
            />
          </form>

          {/*
            输入与下载工具。
            用「图标 + 两个字」而不是纯图标：图标集里没有剪贴板，单看一个双矩形
            没人知道是粘贴；两个按钮加起来一百来像素，地址栏在最小分栏下仍够用。
          */}
          <div className="browser-tools" role="group" aria-label="页面输入与下载">
            <button
              type="button"
              className="btn btn-ghost btn-sm browser-tool-icon"
              onClick={() => void copySelection()}
              disabled={!ready}
              aria-label="复制页面里选中的文字"
              title="复制页面里选中的文字"
            >
              <Icon name="copy" size={13} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm browser-tool-btn"
              onClick={() => void pasteFromClipboard()}
              // 页面没起来时贴进去也没人收，和「让 AI 看」保持一致直接禁用。
              disabled={!ready}
              title="把本地剪贴板里的文本输入到页面"
              aria-label="粘贴"
            >
              {/* 图标集里没有剪贴板，复制用的双矩形是这套线稿里最接近的一个。
                  文字包一层 span：窄栏（@container）只藏文字、保留图标。 */}
              <Icon name="copy" size={13} />
              <span className="browser-tool-label">粘贴</span>
            </button>

            {/* 外壳只为判断"点在弹层外面"；弹层自身相对 .browser-panel 定位，
                面板再窄也不会被裁掉左边。 */}
            <div className="browser-downloads-wrap" ref={downloadsWrapRef}>
              <button
                type="button"
                className={`btn btn-ghost btn-sm browser-tool-btn${downloadsOpen ? ' is-active' : ''}`}
                onClick={toggleDownloads}
                // 读目录不依赖浏览器进程，所以不跟 ready 联动：
                // 进程挂了也应该能看见之前下载过什么。
                title="查看浏览器下载的文件"
                aria-label="下载"
                aria-haspopup="dialog"
                aria-expanded={downloadsOpen}
              >
                <Icon name="download" size={13} />
                <span className="browser-tool-label">下载</span>
              </button>

              {downloadsOpen ? (
                <section className="browser-downloads" role="dialog" aria-label="已下载的文件">
                  <header className="browser-downloads-head">
                    <h3>下载的文件</h3>
                    <button
                      type="button"
                      className="browser-icon-btn"
                      onClick={() => setDownloadsOpen(false)}
                      aria-label="关闭下载列表"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </header>
                  {renderDownloadsBody()}
                  <p className="browser-downloads-foot">
                    下载保存在本机数据目录的 browser-downloads 里
                  </p>
                </section>
              ) : null}
            </div>
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-sm browser-read-btn"
            onClick={() => void openReadPanel()}
            disabled={!ready || read.status === 'loading'}
            title="读取当前页面正文与截图，交给管家参考"
            aria-label="让 AI 看"
          >
            <Icon name="eye" size={13} />
            <span className="browser-tool-label">让 AI 看</span>
          </button>

          {/*
            全屏（面板内沉浸）：放在工具栏最右侧，和「让 AI 看」保持一个点击距离。
            图标集里没有 expand，external 的「四向展开」是这套线性图标里最接近的。
          */}
          <button
            ref={immersiveToggleRef}
            type="button"
            className="browser-icon-btn browser-immersive-toggle"
            onClick={toggleImmersive}
            aria-pressed={immersive || maximized}
            title={immersive || maximized ? '退出全屏' : '全屏'}
            aria-label={immersive || maximized ? '退出全屏' : '全屏'}
          >
            <Icon name="external" size={14} />
          </button>
        </div>
      </div>

      {/*
        剪贴板读不到时的提示：不是错误（页面没问题），但也必须说出来，
        否则用户点「粘贴」看到零反应，只会以为按钮坏了。
      */}
      {hint !== null ? (
        <div className="browser-alert" role="status">
          <Icon name="info" size={13} />
          <span>{hint}</span>
          <button
            type="button"
            className="browser-alert-close"
            onClick={() => setHint(null)}
            aria-label="关闭这条提示"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ) : null}

      {actionError !== null ? (
        <div className="browser-alert is-error" role="alert">
          <Icon name="alert" size={13} />
          <span>{actionError}</span>
          <button
            type="button"
            className="browser-alert-close"
            onClick={() => setActionError(null)}
            aria-label="忽略这条错误"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ) : null}

      {streamError !== null ? (
        <div className="browser-alert" role="alert">
          <Icon name="alert" size={13} />
          <span>{streamError}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void bootBrowser()}>
            重新连接
          </button>
        </div>
      ) : null}

      <div className="browser-body">
        {boot.status === 'failed' ? (
          <div className="browser-error" role="alert">
            <Icon name="alert" size={22} />
            <h3>{boot.noBrowser ? '没有找到可用的浏览器' : '浏览器启动失败'}</h3>
            <p>{boot.message}</p>
            {boot.noBrowser ? (
              <p className="browser-error-hint">
                安装 Chrome / Edge，或设置环境变量 BUTLER_BROWSER_PATH 指向 Chromium 内核浏览器，然后点重试。
              </p>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void bootBrowser()}>
              重试
            </button>
          </div>
        ) : (
          <div
            ref={stageRef}
            // is-focused 是"键盘被画面接管"的信号：真正的焦点在隐藏输入框上，
            // 舞台自己永远不匹配 :focus-visible，所以只能靠这个类画高亮。
            className={`browser-stage${stageFocused ? ' is-focused' : ''}`}
            tabIndex={0}
            role="group"
            aria-label="浏览器画面：点击后可用键盘操作"
            onKeyDown={handleKeyDown}
            onFocus={handleStageFocus}
            onBlur={handleStageBlur}
          >
            <canvas
              ref={canvasRef}
              className={`browser-frame${hasFrame ? ' is-live' : ''}`}
              aria-label="浏览器画面"
              draggable={false}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              // 本地不弹右键菜单：页面自己的（自定义）右键菜单才会出现在画面里，
              // 本地弹出「另存为图片」只会让人误以为操作的是本地文件。
              onContextMenu={(event) => event.preventDefault()}
            />
            {/*
              输入法宿主：Chromium 只给可编辑元素派发 composition 事件，
              没有它中文输入法根本不启动（原因见文件头）。
              它只有 1px、透明、pointer-events:none：不占布局、不挡点击，
              唯一的"出口"是被 focus 和被 composition 事件找到。
            */}
            <textarea
              ref={imeRef}
              className="browser-ime"
              // tabIndex=-1：Tab 要转发给远端页面，本地绝不把它算作一个停靠点；
              // 需要时由点击或舞台的 onFocus 主动把焦点搬进来。
              tabIndex={-1}
              rows={1}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="页面键盘输入（输入法）"
              onInput={(event) => {
                // 非组字状态下的 input 是内核把字符插进了这个 textarea。
                // 立刻清空：它只负责承接，任何文本都不该留在里面。
                // 组字中清空会打断候选词，那种情况由 compositionend 统一清。
                if (!composingRef.current) event.currentTarget.value = '';
              }}
              onCompositionStart={handleCompositionStart}
              onCompositionUpdate={handleCompositionUpdate}
              onCompositionEnd={handleCompositionEnd}
              onPaste={handleImePaste}
            />
            {stageFocused && hasFrame ? (
              // 焦点高亮只有一圈边框，说人话补一句：现在打字是打到页面上。
              // 纯装饰，读屏不重复播报（舞台的 aria-label 已经说过一次）。
              <span className="browser-stage-focus" aria-hidden="true">
                键盘已接管
              </span>
            ) : null}
            {hasFrame ? null : (
              <div
                className={`browser-stage-note${boot.status === 'exited' ? ' is-exited' : ''}`}
                // 进程退出是一次需要被听见的状态变化；等待画面只是过程，用 polite 就够。
                role={boot.status === 'exited' ? 'status' : undefined}
                aria-live="polite"
              >
                {boot.status === 'exited' ? (
                  <Icon name="alert" size={22} />
                ) : (
                  <span className="review-spinner" aria-hidden="true" />
                )}
                <p>{stageNote.title}</p>
                <small>{stageNote.hint}</small>
                {boot.status === 'exited' ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void bootBrowser()}
                  >
                    重新启动
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}

        {/*
          沉浸模式的退出浮钮：放在 .browser-body 里而不是 .browser-stage 里，
          这样画面还没起来（启动失败 / 已退出）时它也在，用户不会只剩 Esc 一条路。
          ★ 半透明压在帧上，位置就是画面右上角；只在沉浸时渲染。
        */}
        {immersive ? (
          <button
            type="button"
            className="browser-immersive-exit"
            // ★ 画面区域会把指针事件换算成远端页面坐标；按钮虽然不在 <img> 里，
            //   仍显式停掉冒泡，避免以后把浮钮挪进舞台时点击穿透到远端页面。
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => exitImmersive(true)}
            title="退出全屏（Esc）"
            aria-label="退出全屏"
          >
            <Icon name="close" size={12} />
            <span>退出全屏</span>
            <kbd>Esc</kbd>
          </button>
        ) : null}
      </div>

      <footer className="browser-status">
        <span className={`browser-status-dot ${dotClass}`} aria-hidden="true" />
        <span className="browser-status-title" title={statusTitle}>
          {statusTitle}
        </span>
        <span className="browser-status-url" title={pageInfo?.url ?? ''}>
          {pageInfo?.url ?? 'about:blank'}
        </span>
      </footer>

      {renderReadPanel()}
    </div>
  );
}
