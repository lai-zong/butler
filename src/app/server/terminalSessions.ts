/**
 * 常驻 PowerShell 终端会话（ConPTY）。
 *
 * ★★ 为什么用 node-pty 而不是 stdin 管道：
 *   `pwsh -Command -` 是非交互批处理模式，没有 PSReadLine，因此没有提示符、
 *   Tab 补全、命令历史、语法高亮，也没有真正的 Ctrl+C；界面只能靠本地回显装样子。
 *   ConPTY 会创建一个真正的伪控制台，PowerShell 以交互模式运行，
 *   xterm 收到的就是它原本要画到终端上的字节流。
 *
 * ★ 代价：node-pty 是原生模块，需要构建/预编译产物；已经在本机验证可加载。
 * ★ 安全边界：终端就是用户主动执行命令，不做命令白名单；只有本机会话能拿到 id。
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import * as pty from 'node-pty';

export class TerminalError extends Error {
  override readonly name = 'TerminalError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'forbidden' | 'spawn_failed' | 'closed',
  ) {
    super(message);
  }
}

export interface TerminalInfo {
  readonly id: string;
  readonly shell: string;
  readonly cwd: string;
  readonly sessionId: string;
}

export interface TerminalEvent {
  readonly type: 'data' | 'ready' | 'exit' | 'error' | 'notice';
  readonly data?: string;
  readonly message?: string;
}

interface TerminalSession {
  readonly id: string;
  readonly sessionId: string;
  readonly shell: string;
  cwd: string;
  term: pty.IPty;
  readonly listeners: Set<(event: TerminalEvent) => void>;
  buffer: string;
  closed: boolean;
  readonly keepAlive: NodeJS.Timeout;
}

/**
 * 放到 globalThis：Next dev 热更新会重新求值路由模块，
 * 只放模块级 Map 会让已经开着的终端"凭空消失"（面板里就是"终端会话不存在"）。
 */
const TERMINAL_STORE = Symbol.for('butler.terminalSessions.v2');
const globalStore = globalThis as typeof globalThis & {
  [TERMINAL_STORE]?: Map<string, TerminalSession>;
};
const sessions: Map<string, TerminalSession> =
  globalStore[TERMINAL_STORE] ?? new Map<string, TerminalSession>();
globalStore[TERMINAL_STORE] = sessions;

const MAX_BUFFER = 200 * 1024;

/**
 * 默认用 cmd.exe。
 *
 * ★ 为什么不是 pwsh：终端面板的用途是跑普通命令/脚本，cmd 启动快、内存低，
 *   没有 PowerShell 的模块加载与策略初始化；ConPTY 下提示符、cd、Ctrl+C 都正常。
 * ★ 需要 PowerShell 时用 BUTLER_TERMINAL_SHELL=pwsh.exe 覆盖，不用改代码。
 */
function detectShell(): string {
  const override = process.env.BUTLER_TERMINAL_SHELL?.trim();
  if (override !== undefined && override !== '') return override;
  if (process.platform !== 'win32') return process.env.SHELL ?? 'bash';
  return 'cmd.exe';
}

/** cmd 的启动参数：/D 跳过 AutoRun，chcp 65001 统一 UTF-8。 */
function shellArgs(shell: string): string[] {
  if (process.platform !== 'win32') return ['-l'];
  if (shell.toLowerCase().endsWith('cmd.exe') || shell.toLowerCase() === 'cmd') {
    return ['/D', '/K', 'chcp 65001 >nul'];
  }
  return ['-NoLogo', '-NoProfile'];
}

function emit(session: TerminalSession, event: TerminalEvent): void {
  if (event.type === 'data' && event.data !== undefined) {
    session.buffer += event.data;
    if (session.buffer.length > MAX_BUFFER) {
      session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER);
    }
  }
  for (const listener of session.listeners) {
    try {
      listener(event);
    } catch {
      // 单个订阅者断开不应影响其它订阅者
    }
  }
}

export async function startTerminal(
  sessionId: string,
  cwd: string,
  cols = 80,
  rows = 24,
): Promise<TerminalInfo> {
  const shell = detectShell();
  const absCwd = resolve(cwd);
  const id = randomBytes(12).toString('hex');
  const keepAlive = setInterval(() => {
    // SSE 空闲时也写一行注释，避免代理把连接当死连接掐掉。
    const session = sessions.get(id);
    session?.listeners.forEach((listener) => {
      try {
        listener({ type: 'notice' });
      } catch {
        // ignore
      }
    });
  }, 15_000);
  keepAlive.unref?.();

  const session: TerminalSession = {
    id,
    sessionId,
    shell,
    cwd: absCwd,
    term: null as unknown as pty.IPty,
    listeners: new Set(),
    buffer: '',
    closed: false,
    keepAlive,
  };
  sessions.set(id, session);
  try {
    const term = pty.spawn(shell, shellArgs(shell), {
      name: 'xterm-256color',
      cols: Math.max(20, cols),
      rows: Math.max(5, rows),
      cwd: absCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        PYTHONIOENCODING: 'utf-8',
      } as Record<string, string>,
    });
    session.term = term;
    term.onData((data) => {
      emit(session, { type: 'data', data });
    });
    term.onExit(({ exitCode }) => {
      if (session.closed) return;
      session.closed = true;
      sessions.delete(id);
      clearInterval(keepAlive);
      emit(session, {
        type: 'exit',
        message: `会话已退出（code=${String(exitCode)}）`,
      });
    });
  } catch (err) {
    sessions.delete(id);
    clearInterval(keepAlive);
    throw new TerminalError(
      `无法启动 ${shell}：${err instanceof Error ? err.message : String(err)}`,
      'spawn_failed',
    );
  }
  return { id, shell, cwd: absCwd, sessionId };
}

function requireSession(id: string, sessionId: string): TerminalSession {
  const session = sessions.get(id);
  if (session === undefined) throw new TerminalError('终端会话不存在', 'not_found');
  if (session.sessionId !== sessionId) throw new TerminalError('终端不属于当前会话', 'forbidden');
  return session;
}

export function writeTerminal(id: string, sessionId: string, data: string): void {
  const session = requireSession(id, sessionId);
  if (session.closed) throw new TerminalError('终端已关闭', 'closed');
  session.term.write(data);
}

export function resizeTerminal(id: string, sessionId: string, cols: number, rows: number): void {
  const session = requireSession(id, sessionId);
  if (session.closed) return;
  session.term.resize(Math.max(20, Math.round(cols)), Math.max(5, Math.round(rows)));
}

/** 真终端里的 Ctrl+C：直接把 \x03 写进 PTY，由 PowerShell 自己处理。 */
export function interruptTerminal(id: string, sessionId: string): void {
  const session = requireSession(id, sessionId);
  if (session.closed) return;
  session.term.write('\x03');
}

export function closeTerminal(id: string, sessionId: string): void {
  const session = requireSession(id, sessionId);
  session.closed = true;
  killPty(session.term);
  clearInterval(session.keepAlive);
  sessions.delete(id);
  emit(session, { type: 'exit', message: '终端已关闭' });
}

export function subscribeTerminal(
  id: string,
  sessionId: string,
  listener: (event: TerminalEvent) => void,
): () => void {
  const session = requireSession(id, sessionId);
  listener({ type: 'ready' });
  if (session.buffer !== '') listener({ type: 'data', data: session.buffer });
  session.listeners.add(listener);
  return () => {
    session.listeners.delete(listener);
  };
}

export function terminalInfo(id: string, sessionId: string): TerminalInfo {
  const session = requireSession(id, sessionId);
  return { id: session.id, shell: session.shell, cwd: session.cwd, sessionId: session.sessionId };
}

/** 进程退出/热重载时统一收尾；不直接挂到进程钩子上，避免测试环境误杀。 */
export function closeAllTerminals(): void {
  for (const session of [...sessions.values()]) {
    session.closed = true;
    killPty(session.term);
    clearInterval(session.keepAlive);
  }
  sessions.clear();
}

/**
 * 结束 PTY 进程。
 *
 * ★ Windows 不用 term.kill()：node-pty 1.1 的 ConPTY kill 会拉起
 *   conpty_console_list_agent，AttachConsole 失败时会在 Node 里抛未捕获异常
 *   （实测能把整个进程打挂），而且有时进程并不会真的退出。
 *   直接 taskkill 整个进程树，既干净又不会触发那个 agent。
 */
function killPty(term: pty.IPty): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill.exe', ['/PID', String(term.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // 进程可能已退出
    }
    return;
  }
  try {
    term.kill();
  } catch {
    // ignore
  }
}
