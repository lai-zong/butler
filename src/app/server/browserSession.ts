/**
 * 内嵌浏览器（CDP）
 *
 * ★ 为什么不用 Playwright：
 *   只需要三件事——启动一个 Chromium、收画面帧、转发输入。
 *   这些用 CDP 直连就够了，而 Playwright 会拉进一整棵依赖树。
 *
 * ★ 为什么优先 Edge：
 *   本机没装 Chrome，Windows 自带 Chromium 内核的 Edge。
 *   两者 CDP 协议一致，所以"内核"仍是 Chromium，只是壳不同。
 *   可以用 `BUTLER_BROWSER_PATH` 指定别的 Chromium。
 *
 * ★ 为什么 headless=new：
 *   不弹窗、不被系统判定为遮挡而暂停渲染；
 *   代价是少数站点会检测无头环境。真需要可见窗口时把 HEADLESS 改成 false 即可。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const VIEWPORT = { width: 1280, height: 800 } as const;
const HEADLESS = true;
const SCREENCAST = { format: 'jpeg', quality: 65, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 } as const;

export class BrowserError extends Error {
  override readonly name = 'BrowserError';
  constructor(
    message: string,
    readonly code: 'no_browser' | 'launch_failed' | 'timeout' | 'not_started' | 'cdp_error',
  ) {
    super(message);
  }
}

/**
 * 跨 bundle 的 BrowserError 判断。
 *
 * ★ `next dev` 会为每个 API 路由单独打包，同一个模块出现多份实例，
 *   `err instanceof BrowserError` 在路由 bundle 里会失效（类不是同一个），
 *   错误于是被当成未知异常返回 500。按 name + code 判断才稳定。
 */
export function isBrowserError(err: unknown): err is BrowserError {
  if (err instanceof BrowserError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  return e.name === 'BrowserError' && typeof e.code === 'string' && typeof e.message === 'string';
}

/** 找一个可用的 Chromium：环境变量 → Chrome → Edge。 */
export function findBrowserExecutable(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const explicit = env['BUTLER_BROWSER_PATH'];
  if (explicit !== undefined && explicit.trim().length > 0 && existsSync(explicit.trim())) {
    return explicit.trim();
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) {
    if (c.length > 0 && existsSync(c)) return c;
  }
  return null;
}

/** 输入框里是网址还是搜索词。 */
export function normalizeAddress(input: string): { kind: 'url' | 'search'; url: string } {
  const raw = input.trim();
  if (raw.length === 0) throw new BrowserError('地址不能为空', 'cdp_error');

  if (/^(https?|file|about|data):/i.test(raw)) return { kind: 'url', url: raw };
  // 看起来像域名（有点、无空格、无中文）→ 当网址补 https
  if (!/\s/.test(raw) && /^[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(raw)) {
    return { kind: 'url', url: `https://${raw}` };
  }
  const engine = process.env['BUTLER_SEARCH_ENGINE'] === 'baidu'
    ? 'https://www.baidu.com/s?wd='
    : 'https://www.bing.com/search?q=';
  return { kind: 'search', url: `${engine}${encodeURIComponent(raw)}` };
}

// ═══════════════════════════════════════════════════════════
// 极简 CDP 客户端
// ═══════════════════════════════════════════════════════════

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

class CdpConnection {
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>();
  private seq = 0;
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '') as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (p === undefined) return;
        this.pending.delete(msg.id);
        if (msg.error !== undefined) p.reject(new BrowserError(msg.error.message ?? 'CDP 调用失败', 'cdp_error'));
        else p.resolve(msg.result);
        return;
      }
      if (typeof msg.method === 'string') {
        for (const cb of this.handlers.get(msg.method) ?? []) {
          try {
            cb(msg.params ?? {}, msg.sessionId);
          } catch {
            // 事件回调出错不影响连接
          }
        }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new BrowserError('浏览器连接已断开', 'cdp_error'));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BrowserError('连接浏览器超时', 'timeout')), 10_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new BrowserError('无法连接浏览器调试端口', 'cdp_error'));
      });
    });
    return new CdpConnection(ws);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserError('浏览器连接已断开', 'cdp_error'));
    this.seq += 1;
    const id = this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId !== undefined ? { sessionId } : {}) }));
    });
  }

  on(method: string, cb: (params: Record<string, unknown>, sessionId?: string) => void): () => void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(cb);
    this.handlers.set(method, set);
    return () => set.delete(cb);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // 已关闭
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 浏览器会话
// ═══════════════════════════════════════════════════════════

export interface BrowserFrame {
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly at: number;
}

interface BrowserSessionState {
  readonly executable: string;
  readonly child: ChildProcess | null;
  readonly cdp: CdpConnection;
  /** 当前正在串流的页面会话；弹窗打开时会切到新页面 */
  pageSessionId: string;
  targetId: string;
  readonly downloadDir: string;
  readonly dataDir: string;
  /** 打开过的页面（targetId → CDP 页面会话）；顺序即标签顺序 */
  readonly pages: Map<string, { targetId: string; sessionId: string }>;
  readonly pageOrder: string[];
  frame: BrowserFrame | null;
  readonly frameSubscribers: Set<(frame: BrowserFrame) => void>;
  lastUsedAt: number;
}

/**
 * ★ 会话状态挂在 globalThis 上，而不是模块变量。
 *
 *   原因：`next dev` 里每个 API 路由是**各自打包**的，同一个模块在
 *   start / state 两个路由里可能是两份实例；模块级变量在 A 里赋值，
 *   B 里读到的还是 null —— 表现就是"浏览器启动成功，界面立刻显示未运行"。
 *   挂到进程级的 globalThis 后，所有路由看到同一份；HMR 重载也不会丢。
 */
const BROWSER_GLOBAL = Symbol.for('butler.browser.session');
type BrowserGlobal = typeof globalThis & {
  [BROWSER_GLOBAL]?: BrowserSessionState | null;
};

function getSession(): BrowserSessionState | null {
  return (globalThis as BrowserGlobal)[BROWSER_GLOBAL] ?? null;
}

function setSession(next: BrowserSessionState | null): void {
  (globalThis as BrowserGlobal)[BROWSER_GLOBAL] = next;
}

/**
 * 等浏览器写出调试端点，并确认它**真的能连上**。
 *
 * ★ 必须验证：进程被杀后会留下上一次的 DevToolsActivePort，
 *   直接读会连到死端口（表现为启动失败 fetch failed）。
 */
async function waitForBrowserEndpoint(profileDir: string, timeoutMs = 20_000): Promise<string> {
  const file = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, 'utf8');
      const port = Number(text.split('\n')[0]);
      if (Number.isInteger(port) && port > 0) {
        try {
          const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
            `http://127.0.0.1:${port}/json/version`,
          );
          if (typeof version.webSocketDebuggerUrl === 'string' && version.webSocketDebuggerUrl.length > 0) {
            return version.webSocketDebuggerUrl;
          }
        } catch {
          // 端口还没起来（或残留端口已死），继续等
        }
      }
    } catch {
      // 文件还没写出来
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new BrowserError('浏览器启动超时（调试端点不可用）', 'timeout');
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new BrowserError(`调试端口返回 ${res.status}`, 'cdp_error');
  return (await res.json()) as T;
}

interface PersistedBrowser {
  readonly pid: number;
  readonly wsUrl: string;
  readonly executable: string;
}

const browserStateFile = (dataDir: string): string => join(dataDir, 'browser-session.json');

/**
 * 浏览器 profile 放系统本地目录，不放项目数据目录。
 *
 * ★ 两个原因：
 *   1) profile 里有被浏览器锁住的 SQLite（Cookies 等），放在仓库里会让
 *      `next build` 的文件追踪直接 EBUSY；
 *   2) 它是机器级缓存（含登录态），不是该随数据目录导出/同步的用户数据。
 *   用数据目录哈希隔离，多个数据目录各自一份。
 */
function browserProfileDir(dataDir: string): string {
  const override = process.env.BUTLER_BROWSER_PROFILE_DIR;
  if (typeof override === 'string' && override.length > 0) return override;
  const hash = createHash('sha1').update(dataDir).digest('hex').slice(0, 12);
  /**
   * ★ 不要用 process.env.LOCALAPPDATA 拼路径：
   *   Next 构建的文件追踪（@vercel/nft）会把环境变量的值当成目录根去 glob，
   *   以 LOCALAPPDATA 为根做全目录扫描时会撞上 Windows 的 Application Data 联接并 EPERM，
   *   整个 `next build` 直接失败。用 homedir 推导等价路径，或显式覆盖。
   */
  const base =
    process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Local', 'butler', 'browser-profile')
      : join(homedir(), '.cache', 'butler', 'browser-profile');
  return join(base, hash);
}

async function readPersisted(dataDir: string): Promise<PersistedBrowser | null> {
  try {
    const raw = JSON.parse(await readFile(browserStateFile(dataDir), 'utf8')) as Partial<PersistedBrowser>;
    if (typeof raw.pid === 'number' && typeof raw.wsUrl === 'string' && typeof raw.executable === 'string') {
      return { pid: raw.pid, wsUrl: raw.wsUrl, executable: raw.executable };
    }
    return null;
  } catch {
    return null;
  }
}

async function writePersisted(dataDir: string, value: PersistedBrowser): Promise<void> {
  await writeFile(browserStateFile(dataDir), JSON.stringify(value), 'utf8').catch(() => undefined);
}

async function clearPersisted(dataDir: string): Promise<void> {
  await rm(browserStateFile(dataDir), { force: true }).catch(() => undefined);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** taskkill /T 才会带走渲染进程；只用 child.kill() 会留下孤儿。 */
async function killProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    setTimeout(resolve, 1500);
  });
}

/** 连一下；连不上（端口已死 / 已退出）返回 null，不抛错。 */
async function connectIfAlive(wsUrl: string): Promise<CdpConnection | null> {
  try {
    const cdp = await Promise.race([
      CdpConnection.connect(wsUrl),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return cdp;
  } catch {
    return null;
  }
}

async function endpointFromPortFile(profileDir: string): Promise<string | null> {
  try {
    const text = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8');
    const port = Number(text.split('\n')[0]);
    if (!Number.isInteger(port) || port <= 0) return null;
    const version = await Promise.race([
      fetchJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (version !== null && typeof version.webSocketDebuggerUrl === 'string' && version.webSocketDebuggerUrl.length > 0) {
      return version.webSocketDebuggerUrl;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 找"已经在跑"的浏览器。
 *
 * ★ 为什么需要：`next dev` 热重载 / 服务重启会丢掉模块里的 session，
 *   但上一次拉起的 Edge 还活着。再 spawn 一个会撞同一个 profile，
 *   Edge 直接以 code=21（profile in use）退出，表现为"浏览器无法启动"。
 *   先接管旧进程，既不冲突，也保住登录状态和已打开的页面。
 */
async function findAdoptable(dataDir: string, profileDir: string): Promise<CdpConnection | null> {
  const persisted = await readPersisted(dataDir);
  if (persisted !== null && isProcessAlive(persisted.pid)) {
    const cdp = await connectIfAlive(persisted.wsUrl);
    if (cdp !== null) return cdp;
  }
  const wsUrl = await endpointFromPortFile(profileDir);
  if (wsUrl !== null) return connectIfAlive(wsUrl);
  return null;
}

/** 把连接装成会话：建页、附着、串流、下载、事件监听。 */
async function finishSession(
  cdp: CdpConnection,
  executable: string,
  child: ChildProcess | null,
  dataDir: string,
  downloadDir: string,
  reused: boolean,
): Promise<{ executable: string; reused: boolean }> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  await setupPageSession(cdp, sessionId);

  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });

  const state: BrowserSessionState = {
    executable,
    child,
    cdp,
    pageSessionId: sessionId,
    targetId,
    downloadDir,
    dataDir,
    pages: new Map([[targetId, { targetId, sessionId }]]),
    pageOrder: [targetId],
    frame: null,
    frameSubscribers: new Set(),
    lastUsedAt: Date.now(),
  };

  // 画面帧：必须逐帧 ack，否则 Chrome 会暂停串流
  cdp.on('Page.screencastFrame', (params, eventSessionId) => {
    const meta = params['metadata'] as { deviceWidth?: number; deviceHeight?: number } | undefined;
    const frame: BrowserFrame = {
      data: String(params['data'] ?? ''),
      width: meta?.deviceWidth ?? VIEWPORT.width,
      height: meta?.deviceHeight ?? VIEWPORT.height,
      at: Date.now(),
    };
    state.frame = frame;
    const frameSessionId = eventSessionId ?? sessionId;
    const ackId = params['sessionId'];
    if (typeof ackId === 'number') {
      void cdp.send('Page.screencastFrameAck', { sessionId: ackId }, frameSessionId).catch(() => undefined);
    }
    for (const cb of state.frameSubscribers) {
      try {
        cb(frame);
      } catch {
        // 订阅者出错不影响其它订阅者
      }
    }
  });

  /**
   * ★ 弹窗/OAuth：登录页常在新页面打开。
   *   不处理的话用户点了"用 Google 登录"就什么都不发生。
   *   这里监听新页面，自动把串流切过去（原标签仍开着，后退可回）。
   */
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  cdp.on('Target.targetCreated', (params) => {
    const info = params['targetInfo'] as
      | { type?: string; targetId?: string; openerId?: string }
      | undefined;
    if (
      info?.type === 'page' &&
      typeof info.targetId === 'string' &&
      info.openerId === state.targetId &&
      info.targetId !== state.targetId
    ) {
      void switchToTarget(state, info.targetId);
    }
  });

  // 页面自己关掉（window.close / 崩溃）时把标签表同步掉
  cdp.on('Target.targetDestroyed', (params) => {
    const id = params['targetId'];
    if (typeof id !== 'string' || !state.pages.has(id)) return;
    state.pages.delete(id);
    const index = state.pageOrder.indexOf(id);
    if (index >= 0) state.pageOrder.splice(index, 1);
    if (state.targetId === id) {
      const next = state.pageOrder[0];
      if (next !== undefined) void switchToTarget(state, next);
    }
  });

  child?.once('exit', () => {
    if (getSession() === state) setSession(null);
    void clearPersisted(dataDir);
  });
  setSession(state);
  return { executable, reused };
}

/**
 * 启动（或复用）浏览器。
 *
 * ★ 懒启动：第一次打开浏览器页签才启动，不用就不占内存。
 */
export async function ensureBrowser(dataDir: string): Promise<{ executable: string; reused: boolean }> {
  const current = getSession();
  if (current !== null) {
    current.lastUsedAt = Date.now();
    return { executable: current.executable, reused: true };
  }

  const executable = findBrowserExecutable();
  if (executable === null) {
    throw new BrowserError(
      '没有找到可用的 Chromium 浏览器（Chrome / Edge）。安装其一，或用 BUTLER_BROWSER_PATH 指定路径。',
      'no_browser',
    );
  }

  const profileDir = browserProfileDir(dataDir);
  await mkdir(profileDir, { recursive: true });
  const downloadDir = join(dataDir, 'browser-downloads');
  await mkdir(downloadDir, { recursive: true });

  // 1) 先接管：服务重启后旧浏览器还活着时，别再 spawn 一个撞 profile
  const adopted = await findAdoptable(dataDir, profileDir);
  if (adopted !== null) {
    const persisted = await readPersisted(dataDir);
    try {
      return await finishSession(adopted, persisted?.executable ?? executable, null, dataDir, downloadDir, true);
    } catch {
      // 接管后半途失败：关掉这条连接，走全新启动
      adopted.close();
    }
  }

  // 2) 记录里的进程还活着但连不上（僵死）→ 连子进程一起清掉
  const stale = await readPersisted(dataDir);
  if (stale !== null) {
    if (isProcessAlive(stale.pid)) await killProcessTree(stale.pid);
    await clearPersisted(dataDir);
  }

  // 只清锁；DevToolsActivePort 留着也能被"验证可连"过滤掉，删了反而丢掉接管线索
  for (const lock of ['SingletonLock', 'SingletonCookie', 'lockfile']) {
    await rm(join(profileDir, lock), { force: true }).catch(() => undefined);
  }

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ...(HEADLESS ? ['--headless=new', '--hide-scrollbars'] : []),
    'about:blank',
  ];

  /**
   * 拉一次浏览器并连上。
   *
   * ★ 单独抽出来是为了"code=21 重试一次"：刚关掉浏览器或上一个实例
   *   还在收尾时，新实例会短暂报 profile in use；等 1.2 秒再拉通常就好了。
   */
  const launchOnce = async (): Promise<{ executable: string; reused: boolean }> => {
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
    const exited = new Promise<never>((_, reject) => {
      child.once('exit', (code) =>
        reject(new BrowserError(`浏览器进程退出（code=${String(code)}）`, 'launch_failed')),
      );
    });
    try {
      const wsUrl = await Promise.race([waitForBrowserEndpoint(profileDir), exited]);
      const cdp = await CdpConnection.connect(wsUrl);
      await writePersisted(dataDir, { pid: child.pid ?? 0, wsUrl, executable });
      return await finishSession(cdp, executable, child, dataDir, downloadDir, false);
    } catch (err) {
      try {
        child.kill();
      } catch {
        // 忽略
      }
      throw err;
    }
  };

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await launchOnce();
    } catch (err) {
      lastError = err;
      // 撞上别的实例：先试着接管
      const again = await findAdoptable(dataDir, profileDir);
      if (again !== null) {
        try {
          return await finishSession(again, executable, null, dataDir, downloadDir, true);
        } catch {
          again.close();
        }
      }
      const inUse = err instanceof BrowserError && err.message.includes('code=21');
      if (inUse && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      break;
    }
  }

  if (lastError instanceof BrowserError && lastError.message.includes('code=21')) {
    throw new BrowserError(
      '浏览器的用户数据目录被另一个 Edge/Chrome 进程占用（通常是上次残留）。稍等几秒重试，或重启本应用后再开。',
      'launch_failed',
    );
  }
  if (lastError instanceof BrowserError) throw lastError;
  throw new BrowserError(
    `浏览器启动失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    'launch_failed',
  );
}

function requireSession(): BrowserSessionState {
  const current = getSession();
  if (current === null) throw new BrowserError('浏览器还没启动', 'not_started');
  current.lastUsedAt = Date.now();
  return current;
}

export function browserStatus(): { running: boolean; executable: string | null } {
  const current = getSession();
  return { running: current !== null, executable: current?.executable ?? null };
}

export async function navigate(input: string): Promise<{ url: string; kind: 'url' | 'search' }> {
  const state = requireSession();
  const target = normalizeAddress(input);
  await state.cdp.send('Page.navigate', { url: target.url }, state.pageSessionId);
  await grantClipboard(state.cdp, target.url);
  return { url: target.url, kind: target.kind };
}

export async function goBack(): Promise<void> {
  const state = requireSession();
  const history = await state.cdp.send<{
    currentIndex: number;
    entries: { id: number; url: string }[];
  }>('Page.getNavigationHistory', {}, state.pageSessionId);
  const entry = history.entries[history.currentIndex - 1];
  if (entry === undefined) return;
  await state.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, state.pageSessionId);
}

export async function goForward(): Promise<void> {
  const state = requireSession();
  const history = await state.cdp.send<{
    currentIndex: number;
    entries: { id: number; url: string }[];
  }>('Page.getNavigationHistory', {}, state.pageSessionId);
  const entry = history.entries[history.currentIndex + 1];
  if (entry === undefined) return;
  await state.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, state.pageSessionId);
}

export async function reload(): Promise<void> {
  const state = requireSession();
  await state.cdp.send('Page.reload', {}, state.pageSessionId);
}

export async function stopLoading(): Promise<void> {
  const state = requireSession();
  await state.cdp.send('Page.stopLoading', {}, state.pageSessionId);
}

export interface PageInfo {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canBack: boolean;
  readonly canForward: boolean;
}

export async function pageInfo(): Promise<PageInfo> {
  const state = requireSession();
  const history = await state.cdp.send<{ currentIndex: number; entries: unknown[] }>(
    'Page.getNavigationHistory',
    {},
    state.pageSessionId,
  );
  const evalResult = await state.cdp.send<{ result: { value?: unknown } }>(
    'Runtime.evaluate',
    {
      expression: '({ url: location.href, title: document.title })',
      returnByValue: true,
    },
    state.pageSessionId,
  );
  const value = (evalResult.result.value ?? {}) as { url?: string; title?: string };
  return {
    url: value.url ?? 'about:blank',
    title: value.title ?? '',
    loading: false,
    canBack: history.currentIndex > 0,
    canForward: history.currentIndex < history.entries.length - 1,
  };
}

/** 读当前页面（给 AI 用）：标题、正文、以及一张截图。 */
export async function readPage(): Promise<{ url: string; title: string; text: string; screenshot: string }> {
  const state = requireSession();
  const info = await pageInfo();
  const evalResult = await state.cdp.send<{ result: { value?: unknown } }>(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const body = document.body;
        if (!body) return '';
        const text = (body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
        return text.slice(0, 20000);
      })()`,
      returnByValue: true,
    },
    state.pageSessionId,
  );
  const shot = await state.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, state.pageSessionId);
  return {
    url: info.url,
    title: info.title,
    text: String(evalResult.result.value ?? ''),
    screenshot: shot.data,
  };
}

export async function closeBrowser(): Promise<void> {
  const current = getSession();
  if (current === null) return;
  const state = current;
  setSession(null);

  /**
   * ★ 先让浏览器退出，再关 CDP 连接。
   *   顺序反了的话 `Browser.close` 会在已关闭的 WebSocket 上发，
   *   接管来的浏览器就永远关不掉（下次启动又把它接管回来）。
   */
  if (state.child !== null) {
    await killProcessTree(state.child.pid ?? 0);
  } else {
    await state.cdp.send('Browser.close').catch(() => undefined);
  }
  try {
    state.cdp.close();
  } catch {
    // 忽略
  }
  await clearPersisted(state.dataDir);
}

// ═══════════════════════════════════════════════════════════
// 输入转发
// ═══════════════════════════════════════════════════════════

const BUTTON_MASK = { left: 1, middle: 4, right: 2 } as const;

export async function mouseInput(event: {
  readonly type: 'down' | 'up' | 'move' | 'wheel';
  readonly x: number;
  readonly y: number;
  readonly button?: 'left' | 'middle' | 'right';
}): Promise<void> {
  const state = requireSession();
  const button = event.button ?? 'left';
  if (event.type === 'wheel') {
    await state.cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: event.x, y: event.y, deltaX: 0, deltaY: 120 },
      state.pageSessionId,
    );
    return;
  }
  const type = event.type === 'down' ? 'mousePressed' : event.type === 'up' ? 'mouseReleased' : 'mouseMoved';
  await state.cdp.send(
    'Input.dispatchMouseEvent',
    {
      type,
      x: event.x,
      y: event.y,
      button: event.type === 'move' ? 'none' : button,
      buttons: event.type === 'move' ? 0 : BUTTON_MASK[button],
      clickCount: event.type === 'move' ? 0 : 1,
    },
    state.pageSessionId,
  );
}

/**
 * 键盘输入。
 *
 * ★ 普通字符走 `Input.insertText`：它会触发页面里的 input 事件，
 *   比逐个 keyCode 稳（中文/emoji 也能进），但不触发 keydown 的某些监听。
 *   特殊键（回车/退格/箭头/Tab）单独发 keyDown/keyUp。
 */
export async function keyInput(event: {
  readonly type: 'text' | 'key';
  readonly text?: string;
  readonly key?: string;
}): Promise<void> {
  const state = requireSession();
  if (event.type === 'text') {
    const text = event.text ?? '';
    if (text.length > 0) await state.cdp.send('Input.insertText', { text }, state.pageSessionId);
    return;
  }
  const key = event.key ?? '';
  const map: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  };
  const info = map[key];
  if (info === undefined) return;
  await state.cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.windowsVirtualKeyCode,
      nativeVirtualKeyCode: info.windowsVirtualKeyCode,
      ...(info.text !== undefined ? { text: info.text } : {}),
    },
    state.pageSessionId,
  );
  await state.cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: info.key, code: info.code, windowsVirtualKeyCode: info.windowsVirtualKeyCode },
    state.pageSessionId,
  );
}

/**
 * 读取当前页面里用户选中的文字（给"复制"用）。
 *
 * ★ 为什么由后端读：页面在另一个进程里，前端拿不到 selection；
 *   读回来之后由前端写系统剪贴板（那一步必须在用户点击手势内）。
 */
export async function readSelection(): Promise<string> {
  const state = requireSession();
  try {
    const result = await state.cdp.send<{ result: { value?: unknown } }>(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const el = document.activeElement;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
            const start = el.selectionStart ?? 0;
            const end = el.selectionEnd ?? 0;
            if (end > start) return String(el.value).slice(start, end);
          }
          return String(document.getSelection()?.toString() ?? '');
        })()`,
        returnByValue: true,
      },
      state.pageSessionId,
    );
    return String(result.result.value ?? '').slice(0, 20_000);
  } catch (err) {
    throw new BrowserError(`读取选区失败：${err instanceof Error ? err.message : String(err)}`, 'cdp_error');
  }
}

/** 订阅画面帧；返回取消函数。 */
export function subscribeFrames(cb: (frame: BrowserFrame) => void): () => void {
  const state = requireSession();
  state.frameSubscribers.add(cb);
  if (state.frame !== null) cb(state.frame);
  return () => state.frameSubscribers.delete(cb);
}

export function latestFrame(): BrowserFrame | null {
  return getSession()?.frame ?? null;
}

/** 测试用：把模块状态清掉（不杀进程）。 */
export function __resetBrowserForTest(): void {
  setSession(null);
}

export { VIEWPORT };

/**
 * 给一个页面会话装好：启用 Page/Runtime、固定视口、开始串流。
 *
 * ★ 抽出来是因为弹窗（OAuth 登录等）打开时要复用同一套初始化。
 */
async function setupPageSession(cdp: CdpConnection, sessionId: string): Promise<void> {
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await cdp.send('Page.startScreencast', SCREENCAST, sessionId);
}

/** 把串流切到某个标签页；不存在就先附着（弹窗场景会先注册）。 */
async function switchToTarget(state: BrowserSessionState, targetId: string): Promise<void> {
  try {
    let entry = state.pages.get(targetId);
    if (entry === undefined) {
      const { sessionId } = await state.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      await setupPageSession(state.cdp, sessionId);
      entry = { targetId, sessionId };
      state.pages.set(targetId, entry);
      if (!state.pageOrder.includes(targetId)) state.pageOrder.push(targetId);
    }

    const previousSession = state.pageSessionId;
    // 先停掉旧页面的串流，避免两个页面同时推帧（弹窗里播视频时尤其明显）
    await state.cdp.send('Page.stopScreencast', {}, previousSession).catch(() => undefined);

    try {
      await setupPageSession(state.cdp, entry.sessionId);
    } catch {
      /**
       * 会话失效（比如页面被挂起后旧 session 不再接受命令）：
       * 重新附着一个会话再初始化，而不是直接放弃切换。
       */
      const { sessionId } = await state.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: entry.targetId,
        flatten: true,
      });
      entry = { targetId: entry.targetId, sessionId };
      state.pages.set(targetId, entry);
      await setupPageSession(state.cdp, sessionId);
    }

    state.pageSessionId = entry.sessionId;
    state.targetId = targetId;
    state.frame = null;
  } catch {
    // 目标已经关掉：保持当前页面不动
  }
}

/** 标签页列表（标题/URL 实时取，失败的给空串）。 */
export interface BrowserTab {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
}

export async function listTabs(): Promise<readonly BrowserTab[]> {
  const state = requireSession();
  const tabs: BrowserTab[] = [];
  for (const targetId of state.pageOrder) {
    if (!state.pages.has(targetId)) continue;
    let title = '';
    let url = '';
    try {
      const info = await state.cdp.send<{
        targetInfo?: { title?: string; url?: string };
      }>('Target.getTargetInfo', { targetId });
      title = info.targetInfo?.title ?? '';
      url = info.targetInfo?.url ?? '';
    } catch {
      // 目标已经关掉
    }
    tabs.push({ id: targetId, title, url, active: targetId === state.targetId });
  }

  return tabs;
}

/** 新建标签页并切过去。 */
export async function newTab(): Promise<{ id: string }> {
  const state = requireSession();
  const { targetId } = await state.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await state.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await setupPageSession(state.cdp, sessionId);
  state.pages.set(targetId, { targetId, sessionId });
  state.pageOrder.push(targetId);
  await switchToTarget(state, targetId);
  return { id: targetId };
}

/** 切到某个标签页。 */
export async function activateTab(id: string): Promise<boolean> {
  const state = requireSession();
  if (!state.pages.has(id)) return false;
  if (id === state.targetId) return true;
  await switchToTarget(state, id);
  return true;
}

/** 关闭标签页；关的是当前页就切到相邻页（都关完了就新开一个）。 */
export async function closeTab(id: string): Promise<void> {
  const state = requireSession();
  const entry = state.pages.get(id);
  if (entry === undefined) return;
  await state.cdp.send('Target.closeTarget', { targetId: entry.targetId }).catch(() => undefined);
  state.pages.delete(id);
  const index = state.pageOrder.indexOf(id);
  if (index >= 0) state.pageOrder.splice(index, 1);

  if (state.targetId !== id) return;
  const next = state.pageOrder[Math.min(index, state.pageOrder.length - 1)];
  if (next !== undefined) {
    await switchToTarget(state, next);
  } else {
    await newTab();
  }
}

/**
 * 给当前站点授权剪贴板。
 *
 * ★ 无头浏览器默认拒绝剪贴板权限，不授权的话 Ctrl+V / 复制按钮都会静默失败。
 *   只对 http(s) 站点授权；data:/about: 没有 origin。
 */
async function grantClipboard(cdp: CdpConnection, url: string): Promise<void> {
  let origin: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    origin = parsed.origin;
  } catch {
    return;
  }
  await cdp
    .send('Browser.grantPermissions', {
      origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    })
    .catch(() => undefined);
}

/** 数据目录里的下载文件。 */
export async function listDownloads(): Promise<readonly { name: string; size: number; mtimeMs: number }[]> {
  const state = requireSession();
  const { readdir } = await import('node:fs/promises');
  try {
    const names = await readdir(state.downloadDir);
    const out: { name: string; size: number; mtimeMs: number }[] = [];
    for (const name of names) {
      const { stat } = await import('node:fs/promises');
      const info = await stat(join(state.downloadDir, name)).catch(() => null);
      if (info !== null && info.isFile()) out.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 50);
  } catch {
    return [];
  }
}
