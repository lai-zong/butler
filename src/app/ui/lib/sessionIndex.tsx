'use client';

/**
 * 会话索引 —— 侧栏与对话页共用的一份状态
 *
 * ★ 为什么必须提出来：会话列表原来长在 ChatView 里，侧栏拿不到，
 *   于是只能再请求一次、再维护一份；两份列表一定会漂移。
 *   现在列表、当前会话、置顶、生成标题只有这一处真相。
 *
 * ★ 数据源只用 GET /api/sessions：
 *   overview.sessions 不含 session-display sidecar（titleGenerated / pinnedAt /
 *   pinnedWorkspace 全是 null），拿它渲染侧栏会把图钉和生成标题全部丢掉。
 *
 * ★ “打开会话 / 打开会话设置”是向 ChatView 注册的句柄：
 *   切会话要清空消息、载入详情、重置审查状态，这些只有 ChatView 知道；
 *   侧栏只负责发请求，不复制那套逻辑。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { errorMessage, fetchJson, postJson } from './api.js';
import type { SessionListMode } from './sessionSort.js';
import type {
  PetSessionResponse,
  SessionPinResponse,
  SessionSummary,
  SessionsResponse,
  ToastMessage,
} from './types.js';

type Notify = (text: string, tone?: ToastMessage['tone']) => void;

/** ChatView 注册进来的两个动作。 */
export interface SessionOpenHandlers {
  readonly openSession: (id: string) => void;
  readonly openSettings: (id: string) => void;
}

export interface SessionIndexValue {
  /** 全量会话（含空草稿；侧栏自己筛掉没有消息的）。 */
  readonly sessions: readonly SessionSummary[];
  /** 当前打开的会话 id；null = 还没有会话。 */
  readonly currentId: string | null;
  /** 桌宠固定会话 id；用于工作区模式单独分区。 */
  readonly petSessionId: string | null;
  /** 排列方式：时间 / 工作区，互斥。 */
  readonly mode: SessionListMode;
  readonly setMode: (mode: SessionListMode) => void;
  readonly setCurrentId: (id: string | null) => void;
  /** 重新读取列表；失败返回 null（不弹错，交给调用方决定）。 */
  readonly refresh: () => Promise<readonly SessionSummary[] | null>;
  /** 用一份会话投影替换/插入列表（新建、设置保存、置顶、检索回写共用）。 */
  readonly applySummary: (summary: SessionSummary) => void;
  /** 标题生成成功：只补丁这一行，不再整表刷新。 */
  readonly patchTitle: (id: string, title: string) => void;
  /** 置顶 / 取消置顶：真实调用接口，写回返回的 pinnedAt / pinnedWorkspace。 */
  readonly togglePin: (id: string) => Promise<void>;
  /** 侧栏点行：切到该会话（同时让对话页载入详情）。 */
  readonly openSession: (id: string) => void;
  /** 侧栏行菜单「对话设置」。 */
  readonly openSettings: (id: string) => void;
  /** ChatView 挂载时注册；卸载时传 null。 */
  readonly registerHandlers: (handlers: SessionOpenHandlers | null) => void;
}

const SessionIndexContext = createContext<SessionIndexValue | null>(null);

const MODE_STORAGE_KEY = 'butler.sidebar.sessions.mode';

function readStoredMode(): SessionListMode {
  if (typeof window === 'undefined') return 'time';
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === 'workspace' ? 'workspace' : 'time';
  } catch {
    return 'time';
  }
}

export function SessionIndexProvider({
  notify,
  children,
}: {
  readonly notify: Notify;
  readonly children: ReactNode;
}): JSX.Element {
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [currentId, setCurrentIdState] = useState<string | null>(null);
  const [petSessionId, setPetSessionId] = useState<string | null>(null);
  const [mode, setModeState] = useState<SessionListMode>('time');

  const sessionsRef = useRef<readonly SessionSummary[]>(sessions);
  const handlersRef = useRef<SessionOpenHandlers | null>(null);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // 排列方式与侧栏折叠一样是界面偏好：首帧保持默认，挂载后再读本地值。
  useEffect(() => {
    setModeState(readStoredMode());
  }, []);

  // 桌宠固定会话：工作区模式用它单独分区（不能靠标题猜）。
  useEffect(() => {
    let cancelled = false;
    void fetchJson<PetSessionResponse>('/api/pet/session')
      .then((res) => {
        if (cancelled) return;
        if (typeof res.sessionId === 'string' && res.sessionId.length > 0) {
          setPetSessionId(res.sessionId);
        }
      })
      .catch(() => {
        // 旧构建没有这个端点：不分桌宠区，也不影响其它功能。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: SessionListMode): void => {
    setModeState(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // 隐私模式下写不进去就只在本次会话生效。
    }
  }, []);

  const setCurrentId = useCallback((id: string | null): void => {
    setCurrentIdState(id);
  }, []);

  const refresh = useCallback(async (): Promise<readonly SessionSummary[] | null> => {
    try {
      const res = await fetchJson<SessionsResponse>('/api/sessions');
      setSessions(res.sessions);
      sessionsRef.current = res.sessions;
      return res.sessions;
    } catch {
      return null;
    }
  }, []);

  const applySummary = useCallback((summary: SessionSummary): void => {
    setSessions((prev) =>
      prev.some((s) => s.id === summary.id)
        ? prev.map((s) => (s.id === summary.id ? summary : s))
        : [summary, ...prev],
    );
  }, []);

  const patchTitle = useCallback((id: string, title: string): void => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title, titleGenerated: true } : s)),
    );
  }, []);

  const patchPinned = useCallback((id: string, res: SessionPinResponse): void => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, pinnedAt: res.pinnedAt, pinnedWorkspace: res.pinnedWorkspace } : s,
      ),
    );
  }, []);

  const togglePin = useCallback(
    async (id: string): Promise<void> => {
      const current = sessionsRef.current.find((s) => s.id === id);
      if (current === undefined) return;
      const pinned = current.pinnedAt === null;
      try {
        const res = await postJson<SessionPinResponse>(
          `/api/sessions/${encodeURIComponent(id)}/pin`,
          { pinned },
        );
        patchPinned(id, res);
        notify(pinned ? '已置顶' : '已取消置顶', 'success');
      } catch (err) {
        notify(errorMessage(err), 'danger');
      }
    },
    [notify, patchPinned],
  );

  const registerHandlers = useCallback((handlers: SessionOpenHandlers | null): void => {
    handlersRef.current = handlers;
  }, []);

  const openSession = useCallback(
    (id: string): void => {
      // 先落选中态：侧栏高亮立刻跟手，详情由 ChatView 异步载入。
      setCurrentIdState(id);
      handlersRef.current?.openSession(id);
    },
    [],
  );

  const openSettings = useCallback((id: string): void => {
    handlersRef.current?.openSettings(id);
  }, []);

  const value = useMemo<SessionIndexValue>(
    () => ({
      sessions,
      currentId,
      petSessionId,
      mode,
      setMode,
      setCurrentId,
      refresh,
      applySummary,
      patchTitle,
      togglePin,
      openSession,
      openSettings,
      registerHandlers,
    }),
    [
      sessions,
      currentId,
      petSessionId,
      mode,
      setMode,
      setCurrentId,
      refresh,
      applySummary,
      patchTitle,
      togglePin,
      openSession,
      openSettings,
      registerHandlers,
    ],
  );

  return <SessionIndexContext.Provider value={value}>{children}</SessionIndexContext.Provider>;
}

export function useSessionIndex(): SessionIndexValue {
  const value = useContext(SessionIndexContext);
  if (value === null) {
    throw new Error('useSessionIndex 必须在 SessionIndexProvider 内使用');
  }
  return value;
}

/** 侧栏列表要显示的行：有消息的会话（空草稿不占历史）。 */
export function listableSessions(sessions: readonly SessionSummary[]): readonly SessionSummary[] {
  return sessions.filter((s) => s.messageCount > 0);
}
