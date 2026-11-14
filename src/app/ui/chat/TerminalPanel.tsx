'use client';

/**
 * 终端面板 —— 右栏「终端」实例的内容
 *
 * 服务端是真正的 ConPTY（node-pty + cmd）：提示符、颜色、Ctrl+C 都由系统 shell
 * 自己处理。所以这里**不做本地回显**，
 * 只负责把 xterm 的按键原样送到 PTY、把 PTY 的输出原样写回 xterm。
 *
 * ★ 为什么用 xterm 而不是一个 <pre>：ANSI 颜色、光标、滚动、选择复制都由 xterm 处理；
 *   自己解析终端控制序列只会得到一套永远追不平的实现。
 * ★ 为什么输入要合并后发送：每敲一个字符一个 HTTP 请求会让输入明显发涩，
 *   30ms 的窗口对人眼不可见，却能把连续输入压成一次请求。
 */

import { useEffect, useRef, useState } from 'react';

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { Icon } from '../components/Icon';
import { errorMessage, postJson } from '../lib/api.js';

/** 服务端 POST /api/terminal 返回的终端信息。 */
export interface TerminalSessionInfo {
  readonly id: string;
  readonly shell: string;
  readonly cwd: string;
  readonly sessionId: string;
}

interface TerminalPanelProps {
  readonly sessionId: string;
  readonly terminal: TerminalSessionInfo;
  /** 有关闭入口时由父层传入；没有也不影响面板工作（列表里也能关）。 */
  readonly onClose?: () => void;
}

/** 服务端 SSE 推送的事件：`data` 是终端输出，notice 只是心跳。 */
type TerminalEvent =
  | { readonly type: 'data'; readonly data?: string }
  | { readonly type: 'exit'; readonly message?: string }
  | { readonly type: 'error'; readonly message?: string }
  | { readonly type: 'ready' | 'notice' };

/** 输入合并窗口：比一帧长一点，足够把连续按键并进一个请求，又不会让用户等。 */
const INPUT_FLUSH_MS = 30;

/** 尺寸变化合并窗口：拖拽右栏时 ResizeObserver 会连续触发。 */
const RESIZE_DEBOUNCE_MS = 120;

/** cmd 经典配色：黑底、浅灰字，和真实 Windows 命令提示符一致。 */
const TERMINAL_THEME = {
  background: '#0c0c0c',
  foreground: '#cccccc',
  cursor: '#ffffff',
  cursorAccent: '#0c0c0c',
  selectionBackground: 'rgba(255, 255, 255, 0.26)',
  black: '#0c0c0c',
  red: '#e74856',
  green: '#16c60c',
  yellow: '#f9f1a5',
  blue: '#3b78ff',
  magenta: '#b4009e',
  cyan: '#61d6d6',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#ff6b6b',
  brightGreen: '#3ff23f',
  brightYellow: '#fff37a',
  brightBlue: '#6b9cff',
  brightMagenta: '#e86bff',
  brightCyan: '#9ff3f3',
  brightWhite: '#ffffff',
};

function parseTerminalEvent(raw: string): TerminalEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const type = (parsed as Record<string, unknown>)['type'];
  if (type !== 'data' && type !== 'exit' && type !== 'error' && type !== 'ready' && type !== 'notice') {
    return null;
  }
  return parsed as TerminalEvent;
}

export function TerminalPanel({
  sessionId,
  terminal,
  onClose,
}: TerminalPanelProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pendingRef = useRef('');
  const flushTimerRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [restarting, setRestarting] = useState(false);

  /**
   * 会话 id 会变：服务端重启 / dev 热更新会让旧 id 失效。
   * 保留在 state 里，auto-restart 与手动「重启」都换一个新 id 重新接流。
   */
  const [terminalId, setTerminalId] = useState(terminal.id);
  const restartGuardRef = useRef<string | null>(null);
  const restartingRef = useRef(false);

  /**
   * 创建 xterm、适配尺寸、接键盘。
   * ★ 只依赖 terminalId/sessionId：面板重渲染（例如输出更新）不能重建终端，
   *   否则滚动位置、buffer 和用户正在输入的一行都会丢。
   */
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const term = new Terminal({
      // ConPTY 自己发 \r\n，这里再 convertEol 会变成两个换行。
      convertEol: false,
      fontFamily:
        '"Cascadia Code", "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    /** fit 在 0 尺寸（收起/隐藏、布局过渡）时会抛异常；失败就等下一次尺寸变化。 */
    const fitSafely = (): { cols: number; rows: number } | null => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return null;
      try {
        fit.fit();
        return { cols: term.cols, rows: term.rows };
      } catch {
        return null;
      }
    };
    const initial = fitSafely();
    if (initial !== null) {
      void postJson('/api/terminal/resize', {
        id: terminalId,
        sessionId,
        cols: initial.cols,
        rows: initial.rows,
      }).catch(() => {
        // 会话可能已退出；下一次 ResizeObserver 会再试
      });
    }

    const observer = new ResizeObserver(() => {
      const size = fitSafely();
      if (size === null) return;
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        void postJson('/api/terminal/resize', {
          id: terminalId,
          sessionId,
          cols: size.cols,
          rows: size.rows,
        }).catch(() => {
          // 终端关闭时忽略
        });
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);

    const queueInput = (data: string): void => {
      pendingRef.current += data;
      if (flushTimerRef.current !== null) return;
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        const chunk = pendingRef.current;
        pendingRef.current = '';
        if (chunk.length === 0) return;
        void postJson('/api/terminal/input', { id: terminalId, sessionId, data: chunk }).catch(
          (err: unknown) => {
            setActionError(errorMessage(err));
          },
        );
      }, INPUT_FLUSH_MS);
    };

    // PTY 会自己回显按键，这里只转发，不再本地写一遍。
    const inputSubscription = term.onData((data) => {
      queueInput(data);
    });

    term.focus();

    return () => {
      inputSubscription.dispose();
      observer.disconnect();
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      pendingRef.current = '';
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, terminalId]);

  /** 终端输出流。SSE 断开由 EventSource 自动重连，这里只提示一次，避免刷屏。 */
  useEffect(() => {
    const query = new URLSearchParams({ id: terminalId, sessionId });
    const source = new EventSource(`/api/terminal/stream?${query.toString()}`);
    let disconnectNoted = false;
    source.onmessage = (event: MessageEvent<string>) => {
      const parsed = parseTerminalEvent(event.data);
      if (parsed === null) return;
      const term = termRef.current;
      if (parsed.type === 'data') {
        term?.write(parsed.data ?? '');
        return;
      }
      if (parsed.type === 'ready') {
        disconnectNoted = false;
        setStreamError(null);
        return;
      }
      if (parsed.type === 'exit') {
        setExited(true);
        term?.write(`\r\n\x1b[38;5;215m[进程已退出] ${parsed.message ?? ''}\x1b[0m\r\n`);
        return;
      }
      if (parsed.type === 'error') {
        const message = parsed.message ?? '终端连接失败';
        setStreamError(message);
        term?.write(`\r\n\x1b[38;5;209m[终端错误] ${message}\x1b[0m\r\n`);
        /**
         * 服务重启/热更新后旧会话 id 一定失效：自动换一个新会话，
         * 而不是让 EventSource 无限重连、每轮都往画面里打同一条错误。
         */
        if (message.includes('不存在') && restartGuardRef.current !== terminalId) {
          restartGuardRef.current = terminalId;
          source.close();
          void restartSession(true);
        }
        return;
      }
      // notice 只是心跳，忽略。
    };
    source.onerror = () => {
      if (disconnectNoted) return;
      disconnectNoted = true;
      if (restartingRef.current) return;
      setStreamError('与终端的连接中断，正在重连…');
    };
    return () => {
      source.close();
    };
  }, [sessionId, terminalId]);

  /**
   * 卸载时关闭终端会话（服务端会杀进程）。
   * ★ 延迟一拍：StrictMode 的挂载→卸载→挂载会把会话误杀；
   *   真正关闭实例时不会再挂载，定时器照常执行。
   */
  useEffect(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    return () => {
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        void postJson('/api/terminal/close', { id: terminalId, sessionId }).catch(() => {
          // 句柄已失效/页面正在卸载：关闭失败没有补救动作。
        });
      }, 0);
    };
  }, [sessionId, terminalId]);

  /**
   * 换一个新的终端会话。
   * ★ 旧 id 已经失效时 close 没有意义；新 id 会触发 xterm/SSE effect 重建，
   *   画面被清空是预期行为（旧进程的输出无法恢复）。
   */
  async function restartSession(auto: boolean): Promise<void> {
    if (restartingRef.current) return;
    restartingRef.current = true;
    setRestarting(true);
    setActionError(null);
    try {
      const res = await postJson<{ ok: boolean; terminal: { id: string } }>('/api/terminal', {
        sessionId,
      });
      setExited(false);
      setStreamError(null);
      setTerminalId(res.terminal.id);
    } catch (err) {
      setActionError(
        `${auto ? '终端会话已失效，自动重启失败：' : '重启失败：'}${errorMessage(err)}`,
      );
    } finally {
      restartingRef.current = false;
      setRestarting(false);
    }
  }

  async function interrupt(): Promise<void> {
    setActionError(null);
    try {
      await postJson('/api/terminal/interrupt', { id: terminalId, sessionId });
    } catch (err) {
      setActionError(errorMessage(err));
    }
    termRef.current?.focus();
  }

  /** 只清本地画面，不重启会话：滚动历史也不该因为一次清屏就丢。 */
  function clearScreen(): void {
    termRef.current?.clear();
    termRef.current?.focus();
  }

  return (
    <section className="terminal-panel" aria-label={`终端 ${terminal.shell}`}>
      <header className="terminal-head">
        <span className="terminal-title">
          <Icon name="console" size={13} />
          <span>终端</span>
        </span>
        <span className="terminal-shell" title={terminal.shell}>
          {terminal.shell}
        </span>
        <span className="terminal-cwd" title={terminal.cwd}>
          {terminal.cwd}
        </span>
        <span className={`terminal-status${exited ? ' is-exited' : ''}`}>
          {exited ? '已退出' : streamError !== null ? '重连中' : '运行中'}
        </span>
        <div className="terminal-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void restartSession(false)}
            disabled={restarting}
            title="重新启动一个 PowerShell 会话"
          >
            {restarting ? '重启中…' : '重启'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={clearScreen}
            title="清空本地画面，不重启会话"
          >
            清屏
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void interrupt()}
            title="发送 Ctrl+C"
          >
            Ctrl+C
          </button>
          {onClose !== undefined ? (
            <button
              type="button"
              className="terminal-close"
              aria-label="关闭终端面板"
              title="关闭终端面板"
              onClick={onClose}
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
      </header>
      {actionError !== null ? (
        <div className="terminal-banner is-danger" role="alert">
          <Icon name="alert" size={13} />
          <span>{actionError}</span>
          <button
            type="button"
            className="terminal-banner-close"
            aria-label="关闭错误提示"
            onClick={() => setActionError(null)}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ) : null}
      {streamError !== null ? (
        <div className="terminal-banner is-warn" role="status">
          <Icon name="info" size={13} />
          <span>{streamError}</span>
        </div>
      ) : null}
      <div className="terminal-body" ref={hostRef} />
    </section>
  );
}
