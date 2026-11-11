'use client';

/**
 * 内嵌浏览器面板 —— 右栏「浏览器」页签
 *
 * 三块能力：
 *   · 画面：订阅 `/api/browser/stream` 的 SSE 帧，等比缩放到面板里；
 *   · 操作：地址栏、前进后退刷新、鼠标/滚轮/键盘都转发给服务端的 CDP 浏览器；
 *   · 给 AI：读当前页正文与截图，整理成问题交给父组件**填进输入框**（不自动发送）。
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
  CompositionEvent as ReactCompositionEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

import { Icon } from '../components/Icon';
import { ApiError, errorMessage, fetchJson, postJson } from '../lib/api.js';

interface BrowserPanelProps {
  /** 只用于「切换会话时收起 AI 阅读面板」；浏览器进程本身是全局的单实例。 */
  readonly sessionId: string | null;
  /** 把整理好的问题填进对话输入框；实现方只填空、不发送。 */
  readonly onSendToButler: (text: string) => void;
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
  | { readonly status: 'failed'; readonly message: string; readonly noBrowser: boolean };

type ReadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly page: BrowserReadResponse }
  | { readonly status: 'error'; readonly message: string };

type BrowserAction = 'back' | 'forward' | 'reload';
type MouseAction = 'down' | 'up' | 'move' | 'wheel';
type MouseButton = 'left' | 'middle' | 'right';

/** 服务端的页面 viewport；帧里带真实宽高，这里只是第一帧到达前的兜底。 */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
/** 状态轮询间隔：页签可见时每 2 秒同步一次标题 / URL / 前进后退可用性。 */
const STATE_POLL_MS = 2_000;
/**
 * 滚轮节流：触控板一次滑动会发几十个 wheel 事件，而服务端每个事件固定滚 120px，
 * 不节流会把页面直接滚飞；60ms 对鼠标滚轮（约 10~20 次/秒）几乎没有延迟感。
 */
const WHEEL_INTERVAL_MS = 60;
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
    return {
      data,
      width: typeof width === 'number' && width > 0 ? width : DEFAULT_VIEWPORT.width,
      height: typeof height === 'number' && height > 0 ? height : DEFAULT_VIEWPORT.height,
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

export function BrowserPanel({ sessionId, onSendToButler }: BrowserPanelProps): JSX.Element {
  // ── 启动 / 画面连接 ────────────────────────────────────────────────
  const [boot, setBoot] = useState<BootState>({ status: 'starting' });
  const [streamError, setStreamError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);

  // ── 页面状态 / 地址栏 ──────────────────────────────────────────────
  const [pageInfo, setPageInfo] = useState<PageState | null>(null);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── 「让 AI 看」面板 ───────────────────────────────────────────────
  const [read, setRead] = useState<ReadState>({ status: 'idle' });

  /**
   * 组件是否还活着。
   * 请求都是异步的，卸载后回来再 setState 虽然 React 18 不再报警，
   * 但会白跑一遍 EventSource 重连逻辑，用一个 ref 直接剪掉。
   */
  const aliveRef = useRef(true);
  const streamRef = useRef<EventSource | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  /** 最近一帧的 viewport 尺寸；坐标换算按它算，不用写死 1280。 */
  const frameSizeRef = useRef<{ width: number; height: number }>({
    width: DEFAULT_VIEWPORT.width,
    height: DEFAULT_VIEWPORT.height,
  });
  /** 状态请求序号：轮询与手动刷新可能并发，只认最后一次的响应。 */
  const stateSeqRef = useRef(0);
  const dragRef = useRef<{ active: boolean; button: MouseButton }>({
    active: false,
    button: 'left',
  });
  const lastPointRef = useRef<ViewportPoint | null>(null);
  const lastMoveRef = useRef<ViewportPoint | null>(null);
  const wheelAtRef = useRef(0);

  // ── 启动 ───────────────────────────────────────────────────────────

  /**
   * 启动浏览器并接上画面流。
   *
   * ★ 重试 / 重新连接也走这里：`/api/browser/start` 是幂等的（已启动会返回 reused），
   *   浏览器进程意外退出时它还能重新拉起一个新的，比只重连 SSE 更彻底。
   */
  async function bootBrowser(): Promise<void> {
    streamRef.current?.close();
    streamRef.current = null;
    setBoot({ status: 'starting' });
    setStreamError(null);
    setHasFrame(false);
    try {
      await postJson<OkResponse>('/api/browser/start', {});
      if (!aliveRef.current) return;
      setBoot({ status: 'ready' });
      openStream();
      void refreshState();
    } catch (err) {
      if (!aliveRef.current) return;
      setBoot({
        status: 'failed',
        message: errorMessage(err),
        noBrowser: apiErrorCode(err) === 'no_browser',
      });
    }
  }

  /** 建一条 SSE 连接；重复调用会先关掉旧的，保证同一时刻只有一条流。 */
  function openStream(): void {
    streamRef.current?.close();
    const source = new EventSource('/api/browser/stream');
    streamRef.current = source;

    source.onmessage = (event: MessageEvent<string>) => {
      if (!aliveRef.current || streamRef.current !== source) return;
      const frame = parseFrame(event.data);
      if (frame === null) return;
      frameSizeRef.current = { width: frame.width, height: frame.height };
      // 直接改 DOM 的 src：见文件头「为什么不把帧放进 state」。
      const img = imgRef.current;
      if (img !== null) img.src = `data:image/jpeg;base64,${frame.data}`;
      setHasFrame(true);
    };

    source.addEventListener('error', (event: Event) => {
      if (!aliveRef.current || streamRef.current !== source) return;
      // 服务端的 `event: error` 与 EventSource 自身的断线都会走这个监听：
      // 前者是 MessageEvent（带 data），后者是普通 Event。
      const message = event instanceof MessageEvent ? serverErrorOf(event.data) : null;
      // ★ 主动关掉：浏览器没启动时服务端发完错误就 close，EventSource 会自动重连，
      //   不关掉就会变成一个打服务端的死循环，让用户点「重新连接」才重来。
      source.close();
      streamRef.current = null;
      setStreamError(message ?? '画面连接中断');
    });
  }

  /** 刷新标题 / URL / 前进后退可用性。 */
  async function refreshState(): Promise<void> {
    const seq = stateSeqRef.current + 1;
    stateSeqRef.current = seq;
    try {
      const res = await fetchJson<BrowserStateResponse>('/api/browser/state');
      if (!aliveRef.current || seq !== stateSeqRef.current) return;
      const url = typeof res.url === 'string' ? res.url : '';
      setPageInfo({
        running: res.running === true,
        url,
        title: typeof res.title === 'string' ? res.title : '',
        canBack: res.canBack === true,
        canForward: res.canForward === true,
      });
      // 地址栏只在用户没在编辑时跟随页面：否则输到一半的网址会被 2 秒轮询冲掉。
      if (url.length > 0 && document.activeElement !== addressRef.current) setAddress(url);
    } catch {
      // 轮询失败保留上一份状态：真断线由画面流提示，这里再报一次只会来回闪。
    }
  }

  // ── 操作 ───────────────────────────────────────────────────────────

  async function navigateTo(): Promise<void> {
    const input = address.trim();
    if (input.length === 0 || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await postJson<NavigateResponse>('/api/browser/navigate', { input });
      if (!aliveRef.current) return;
      setAddress(res.url);
      void refreshState();
    } catch (err) {
      if (aliveRef.current) setActionError(errorMessage(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function runAction(action: BrowserAction): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await postJson<OkResponse>('/api/browser/action', { action });
      if (aliveRef.current) void refreshState();
    } catch (err) {
      if (aliveRef.current) setActionError(errorMessage(err));
    } finally {
      if (aliveRef.current) setBusy(false);
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
    const img = imgRef.current;
    if (img === null) return null;
    const rect = img.getBoundingClientRect();
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

  function postMouse(action: MouseAction, point: ViewportPoint, button?: MouseButton): void {
    void postJson<OkResponse>('/api/browser/input', {
      type: 'mouse',
      action,
      x: point.x,
      y: point.y,
      ...(button !== undefined ? { button } : {}),
    }).catch(() => {
      // 输入失败不弹错：真断线时画面流会给提示，这里每帧再报一次只会刷屏。
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
      lastMoveRef.current = point;
    }
    postMouse(action, point, button);
  }

  function sendText(text: string): void {
    if (text.length === 0) return;
    void postJson<OkResponse>('/api/browser/input', { type: 'text', text }).catch(() => undefined);
  }

  function sendKey(key: string): void {
    void postJson<OkResponse>('/api/browser/input', { type: 'key', key }).catch(() => undefined);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLImageElement>): void {
    const button = buttonOf(event.button);
    if (button === null) return;
    // 键盘输入依赖容器焦点：点画面就应该等于点浏览器窗口。
    stageRef.current?.focus({ preventScroll: true });
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

  function handlePointerMove(event: ReactPointerEvent<HTMLImageElement>): void {
    sendPointer('move', event.clientX, event.clientY);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLImageElement>): void {
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

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    // ★ Ctrl / Cmd / Alt 组合一律不转发：它们在本地是应用快捷键（保存、切换面板…），
    //   发到远端页面会同时触发页面里的同名快捷键，用户还不知道是哪边动的。
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // 输入法组字中的按键不发：字符由 compositionend 一次性提交，逐键发只会送出拼音。
    if (event.nativeEvent.isComposing) return;
    const key = event.key;
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

  function handleCompositionEnd(event: ReactCompositionEvent<HTMLDivElement>): void {
    // 中文输入法一次提交整段文字，只有这里拿到的才是最终结果。
    sendText(event.data);
  }

  // ── 「让 AI 看」 ───────────────────────────────────────────────────

  async function openReadPanel(): Promise<void> {
    setRead({ status: 'loading' });
    try {
      const res = await postJson<BrowserReadResponse>('/api/browser/read', {});
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

  // ── 生命周期 ───────────────────────────────────────────────────────

  /**
   * 挂载 = 「浏览器」页签第一次被选中（ChatView 只在选中时渲染本组件）。
   * 所以这里就是需求里的「第一次可见才启动」，整页加载时不会误启动。
   */
  useEffect(() => {
    aliveRef.current = true;
    void bootBrowser();
    return () => {
      // 卸载时断开 SSE：否则切走页签后服务端还在往一条没人看的流里推帧。
      aliveRef.current = false;
      streamRef.current?.close();
      streamRef.current = null;
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
   * 滚轮用原生监听。
   *
   * ★ React 的 onWheel 在根节点以 passive 注册，里面 preventDefault 不生效；
   *   这里挂非 passive 监听，让滚轮只发给远端页面，不带着本地面板一起滚。
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const now = Date.now();
      if (now - wheelAtRef.current < WHEEL_INTERVAL_MS) return;
      wheelAtRef.current = now;
      // 服务端滚轮是固定滚动量（不用传 delta），所以这里只给坐标。
      sendPointer('wheel', event.clientX, event.clientY);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
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
  const dotClass =
    boot.status === 'failed' || streamError !== null
      ? 'is-error'
      : boot.status === 'starting' || !hasFrame
        ? 'is-busy'
        : 'is-live';
  const statusTitle =
    boot.status === 'starting'
      ? '启动中…'
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
    streamError !== null
      ? { title: '画面已断开', hint: '点上方「重新连接」重试' }
      : boot.status === 'starting'
        ? { title: '启动中…', hint: '首次启动 Chromium 需要几秒' }
        : { title: '等待画面…', hint: '页面还没有产生新帧' };

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
    <div className="browser-panel">
      <div className="browser-toolbar">
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

        <button
          type="button"
          className="btn btn-ghost btn-sm browser-read-btn"
          onClick={() => void openReadPanel()}
          disabled={!ready || read.status === 'loading'}
          title="读取当前页面正文与截图，交给管家参考"
        >
          <Icon name="eye" size={13} /> 让 AI 看
        </button>
      </div>

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
            className="browser-stage"
            tabIndex={0}
            role="group"
            aria-label="浏览器画面：点击后可用键盘操作"
            onKeyDown={handleKeyDown}
            onCompositionEnd={handleCompositionEnd}
          >
            <img
              ref={imgRef}
              className={`browser-frame${hasFrame ? ' is-live' : ''}`}
              alt="浏览器画面"
              draggable={false}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              // 本地不弹右键菜单：页面自己的（自定义）右键菜单才会出现在画面里，
              // 本地弹出「另存为图片」只会让人误以为操作的是本地文件。
              onContextMenu={(event) => event.preventDefault()}
            />
            {hasFrame ? null : (
              <div className="browser-stage-note" aria-live="polite">
                <span className="review-spinner" aria-hidden="true" />
                <p>{stageNote.title}</p>
                <small>{stageNote.hint}</small>
              </div>
            )}
          </div>
        )}
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
