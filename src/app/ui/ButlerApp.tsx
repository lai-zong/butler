'use client';

/**
 * 应用外壳 —— 两个界面、一套状态
 *
 *   主界面：暖纸色工作台，只保留「对话」与「设置」。
 *   控制台：深色治理终端，承接原来的记忆 / 审计 / 演化。
 *
 * ★ 一个刻意的结构决定：**对话层与主界面始终挂载**。
 *   控制台是一层 fixed 覆盖层，进入/退出不会卸载对话 ——
 *   正在进行的流式任务不会因为去治理面板看一眼而被打断。
 *
 * ★ 进入控制台有一段独立的转场（ConsoleTransition）：
 *   控制台在动画播放前就已挂载并开始取数，动画结束时它已经可操作，
 *   而不是“动画结束才开始加载”。
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Sidebar } from './components/Sidebar';
import { CommandPalette } from './components/CommandPalette';
import { ToastStack } from './components/Toast';
import { BootScreen } from './components/BootScreen';
import { ChatView } from './chat/ChatView';
import { SettingsView } from './settings/SettingsView';
import { ConsoleTransition } from './console/ConsoleTransition';
import { computeConsoleBootStatus, type ConsoleBootMode } from './console/consoleBoot.js';
import { errorMessage, fetchJson } from './lib/api.js';
import { computeBootStatus, type ChatBootState } from './lib/boot.js';
import type {
  ConsoleSection,
  MainView,
  MemoryPreset,
  MemoryTarget,
  Overview,
  ToastMessage,
  ViewId,
} from './lib/types.js';

/** 控制台是第二界面：动态加载，首屏不解析它的模块与三个治理视图。 */
const ConsoleShell = dynamic(() => import('./console/ConsoleShell').then((m) => m.ConsoleShell), {
  ssr: false,
});

type Surface = 'main' | 'console';

const MAIN_TITLES: Record<MainView, string> = {
  chat: '对话',
  settings: '设置',
};

const SECTION_TITLES: Record<ConsoleSection, string> = {
  memory: '记忆',
  audit: '审计',
  growth: '演化',
};

const CONSOLE_SECTIONS: readonly ConsoleSection[] = ['memory', 'audit', 'growth'];

interface Route {
  readonly surface: Surface;
  readonly view: MainView;
  readonly section: ConsoleSection;
}

/**
 * 解析 hash。
 *
 * 兼容旧深链：`#/memory` / `#/audit` / `#/growth` 仍会落到控制台对应分区，
 * 这样之前收藏的地址不会失效。
 */
function parseHash(): Route {
  if (typeof window === 'undefined') return { surface: 'main', view: 'chat', section: 'memory' };
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';

  if (raw.startsWith('console/')) {
    const section = raw.slice('console/'.length);
    if ((CONSOLE_SECTIONS as readonly string[]).includes(section)) {
      return { surface: 'console', view: 'chat', section: section as ConsoleSection };
    }
    return { surface: 'console', view: 'chat', section: 'memory' };
  }

  if (raw === 'memory' || raw === 'audit' || raw === 'growth') {
    return { surface: 'console', view: 'chat', section: raw };
  }

  if (raw === 'settings') return { surface: 'main', view: 'settings', section: 'memory' };
  return { surface: 'main', view: 'chat', section: 'memory' };
}

function hashOfMain(view: MainView): string {
  return `#/${view}`;
}

function hashOfConsole(section: ConsoleSection): string {
  return `#/console/${section}`;
}

export function ButlerApp(): JSX.Element {
  const [surface, setSurface] = useState<Surface>('main');
  const [view, setView] = useState<MainView>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [consoleSection, setConsoleSection] = useState<ConsoleSection>('memory');
  const [consoleMounted, setConsoleMounted] = useState(false);
  const [consoleMode, setConsoleMode] = useState<ConsoleBootMode>('first');
  const [consoleShellMounted, setConsoleShellMounted] = useState(false);
  const [consoleDataReady, setConsoleDataReady] = useState(false);
  const [consoleTimedOut, setConsoleTimedOut] = useState(false);
  const [consoleTransition, setConsoleTransition] = useState(false);
  const [consoleTransitionLeaving, setConsoleTransitionLeaving] = useState(false);
  const [consoleLeaving, setConsoleLeaving] = useState(false);
  const consoleStartedAt = useRef(0);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [booting, setBooting] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [chatBoot, setChatBoot] = useState<ChatBootState>({ state: 'loading', phase: 'sessions' });
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const appShellRef = useRef<HTMLDivElement | null>(null);

  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);
  const [commandOpen, setCommandOpen] = useState(false);

  const [auditRange, setAuditRange] = useState<{
    readonly fromSeq: number;
    readonly toSeq: number;
  } | null>(null);
  const [memoryPreset, setMemoryPreset] = useState<MemoryPreset>({ nonce: 0 });
  const [newChatNonce, setNewChatNonce] = useState(0);
  const [dataResetNonce, setDataResetNonce] = useState(0);

  const toastSeq = useRef(0);
  const timers = useRef<Set<number>>(new Set());
  const leaveTimer = useRef<number | null>(null);

  const notify = useCallback((text: string, tone: ToastMessage['tone'] = 'default'): void => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, text, tone }]);
    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timers.current.delete(timer);
    }, tone === 'danger' ? 5200 : 3200);
    timers.current.add(timer);
  }, []);

  const dismissToast = useCallback((id: number): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const refreshOverview = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchJson<Overview>('/api/overview');
      setOverview(res);
      setOverviewError(null);
    } catch (err) {
      setOverviewError(errorMessage(err));
    }
  }, []);

  // 首屏与周期刷新
  useEffect(() => {
    void refreshOverview();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshOverview();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshOverview]);

  const handleChatBoot = useCallback((state: ChatBootState): void => {
    setChatBoot(state);
  }, []);

  const finishBoot = useCallback((): void => {
    setBooting(false);
  }, []);

  const retryBoot = useCallback((): void => {
    window.location.reload();
  }, []);

  useEffect(() => {
    setHydrated(true);
  }, []);

  // 侧栏收起是界面偏好，存在本地；首帧保持展开，避免 SSR 不一致。
  useEffect(() => {
    try {
      setSidebarCollapsed(window.localStorage.getItem('butler.sidebar.collapsed') === '1');
    } catch {
      // 隐私模式/禁用 storage 时忽略，保持展开
    }
  }, []);

  const toggleSidebar = useCallback((): void => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('butler.sidebar.collapsed', next ? '1' : '0');
      } catch {
        // 忽略写入失败
      }
      return next;
    });
  }, []);

  const bootStatus = computeBootStatus({
    hydrated,
    overview: overview !== null ? 'ready' : overviewError !== null ? 'error' : 'loading',
    overviewError,
    chat: chatBoot,
    timedOut: bootTimedOut,
  });

  // 启动期间隔离背后的应用：不能 Tab 进去、不能输入、读屏也不应读到。
  useEffect(() => {
    const shell = appShellRef.current;
    if (shell === null) return;
    if (booting) {
      shell.setAttribute('inert', '');
      shell.setAttribute('aria-hidden', 'true');
    } else {
      shell.removeAttribute('inert');
      shell.removeAttribute('aria-hidden');
    }
    return () => {
      shell.removeAttribute('inert');
      shell.removeAttribute('aria-hidden');
    };
  }, [booting]);

  // 真实加载迟迟不完成时给一个可恢复的错误，而不是无限等待。
  useEffect(() => {
    if (!booting || bootStatus.ready || bootStatus.error !== null) return;
    const timer = window.setTimeout(() => setBootTimedOut(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [booting, bootStatus.ready, bootStatus.error]);

  // 清理 toast / 退场定时器
  useEffect(() => {
    const current = timers.current;
    return () => {
      for (const t of current) window.clearTimeout(t);
      current.clear();
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    };
  }, []);

  // Hash 路由：可前进后退、可深链。浏览器回退不播完整转场，直接落位。
  useEffect(() => {
    const apply = (): void => {
      const route = parseHash();
      if (leaveTimer.current !== null) {
        window.clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
      setConsoleTransition(false);
      setConsoleTransitionLeaving(false);
      setConsoleLeaving(false);
      if (route.surface === 'console') {
        // 深链直接落位：不播转场，但控制台需要挂载并开始取数。
        setConsoleMounted(true);
        setConsoleMode('quick');
        setSurface('console');
        setConsoleSection(route.section);
      } else {
        setSurface('main');
        setView(route.view);
      }
    };

    if (window.location.hash.length === 0) {
      window.history.replaceState({ hash: '#/chat' }, '', '#/chat');
    } else {
      apply();
    }
    window.addEventListener('hashchange', apply);
    window.addEventListener('popstate', apply);
    return () => {
      window.removeEventListener('hashchange', apply);
      window.removeEventListener('popstate', apply);
    };
  }, []);

  useEffect(() => {
    document.title =
      surface === 'console'
        ? `butler · 控制台 · ${SECTION_TITLES[consoleSection]}`
        : `butler · ${MAIN_TITLES[view]}`;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', surface === 'console' ? '#0a0f0c' : '#f5f3ee');
  }, [surface, view, consoleSection]);

  // 控制台打开时给 portal 出来的 Modal / 命令面板一套深色变量。
  // 退场一开始就撤掉：控制台自己有独立变量，主界面则在淡出期间先回到暖色。
  useEffect(() => {
    document.body.classList.toggle('console-mode', surface === 'console' && !consoleLeaving);
    return () => document.body.classList.remove('console-mode');
  }, [surface, consoleLeaving]);

  // 控制台是覆盖层：主界面仍在挂载，但不该被 Tab 键或读屏摸到。
  useEffect(() => {
    const targets = [document.querySelector('.sidebar'), document.getElementById('view-scroll')];
    for (const el of targets) {
      if (!(el instanceof HTMLElement)) continue;
      if (surface === 'console') el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }
  }, [surface]);

  // ⌘K / Ctrl+K（启动期间不响应，避免在 inert 启动层后面打开命令面板）
  useEffect(() => {
    if (booting) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [booting]);

  const pushHash = useCallback((hash: string): void => {
    if (window.location.hash !== hash) {
      window.history.pushState({ hash }, '', hash);
    }
  }, []);

  const handleConsoleShellMounted = useCallback((): void => {
    setConsoleShellMounted(true);
  }, []);

  const handleConsoleViewReady = useCallback((): void => {
    setConsoleDataReady(true);
  }, []);

  const consoleBoot = computeConsoleBootStatus({
    mode: consoleMode,
    mounted: consoleMounted,
    shellMounted: consoleShellMounted,
    dataReady: consoleDataReady,
    timedOut: consoleTimedOut,
  });

  // 就绪后至少展示完整动画（首次 1.2s / 二次约 0.5s），再淡出。
  // ★ 不能把 consoleTransitionLeaving 放进依赖：它一变成 true 会触发 cleanup，
  //   把负责卸载 overlay 的 finish 定时器清掉，overlay 就永远留在 DOM 里。
  useEffect(() => {
    if (!consoleTransition || !consoleBoot.ready) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const minMs = reduce
      ? consoleMode === 'first'
        ? 120
        : 80
      : consoleMode === 'first'
        ? 1200
        : 480;
    const fadeMs = reduce ? 0 : consoleMode === 'first' ? 260 : 160;
    const elapsed = Date.now() - consoleStartedAt.current;
    const wait = Math.max(0, minMs - elapsed);
    const enter = window.setTimeout(() => setConsoleTransitionLeaving(true), wait);
    const finish = window.setTimeout(() => {
      setConsoleTransition(false);
      setConsoleTransitionLeaving(false);
    }, wait + fadeMs);
    return () => {
      window.clearTimeout(enter);
      window.clearTimeout(finish);
    };
  }, [consoleTransition, consoleBoot.ready, consoleMode]);

  // 首次打开迟迟未就绪时放行，避免用户永远停在动画上。
  useEffect(() => {
    if (!consoleTransition || consoleMode !== 'first' || consoleBoot.ready) return;
    const timer = window.setTimeout(() => setConsoleTimedOut(true), 8000);
    return () => window.clearTimeout(timer);
  }, [consoleTransition, consoleMode, consoleBoot.ready]);

  const openConsole = useCallback(
    (section: ConsoleSection): void => {
      if (leaveTimer.current !== null) {
        window.clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
      setConsoleLeaving(false);
      setConsoleSection(section);
      pushHash(hashOfConsole(section));

      if (surface === 'console') {
        setConsoleTransition(false);
        return;
      }

      const first = !consoleMounted;
      consoleStartedAt.current = Date.now();
      setConsoleMode(first ? 'first' : 'quick');
      setConsoleMounted(true);
      setConsoleTransitionLeaving(false);
      setConsoleTransition(true);
      setSurface('console');

      if (first) {
        setConsoleShellMounted(false);
        setConsoleDataReady(false);
        setConsoleTimedOut(false);
      } else {
        setConsoleShellMounted(true);
        setConsoleDataReady(true);
      }
    },
    [surface, pushHash, consoleMounted],
  );

  const closeConsole = useCallback(
    (target?: MainView): void => {
      const nextView = target ?? view;
      if (surface !== 'console') {
        setView(nextView);
        pushHash(hashOfMain(nextView));
        return;
      }
      setConsoleLeaving(true);
      setConsoleTransition(false);
      setConsoleTransitionLeaving(false);
      setAuditRange(null);
      pushHash(hashOfMain(nextView));
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
      leaveTimer.current = window.setTimeout(() => {
        setSurface('main');
        setView(nextView);
        setConsoleLeaving(false);
        leaveTimer.current = null;
      }, 280);
    },
    [surface, view, pushHash],
  );

  const navigate = useCallback(
    (next: ViewId): void => {
      if (next === 'memory' || next === 'audit' || next === 'growth') {
        if (next === 'audit' && surface === 'main') setAuditRange(null);
        openConsole(next);
        return;
      }
      closeConsole(next);
    },
    [openConsole, closeConsole, surface],
  );

  const openMemory = useCallback(
    (target?: MemoryTarget): void => {
      setMemoryPreset((prev) => ({ ...target, nonce: prev.nonce + 1 }));
      openConsole('memory');
    },
    [openConsole],
  );

  const openAudit = useCallback(
    (range: { readonly fromSeq: number; readonly toSeq: number } | null): void => {
      setAuditRange(range);
      openConsole('audit');
    },
    [openConsole],
  );

  const openSettings = useCallback((): void => {
    closeConsole('settings');
  }, [closeConsole]);

  const newChat = useCallback((): void => {
    closeConsole('chat');
    setNewChatNonce((n) => n + 1);
  }, [closeConsole]);

  const exportData = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/transfer/export');
      const text = await res.text();
      if (!res.ok) {
        let msg = `导出失败（HTTP ${res.status}）`;
        try {
          const data = JSON.parse(text) as { error?: string };
          if (typeof data.error === 'string') msg = data.error;
        } catch {
          // 保持默认
        }
        throw new Error(msg);
      }
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `butler-export-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      notify(`已导出 ${(text.length / 1024).toFixed(1)} KB`, 'success');
    } catch (err) {
      notify(errorMessage(err), 'danger');
    }
  }, [notify]);

  const onDataReset = useCallback((): void => {
    setDataResetNonce((n) => n + 1);
    void refreshOverview();
  }, [refreshOverview]);

  /**
   * React 18 的 DOM 类型还没有 `inert` 属性；浏览器支持它，但服务端和客户端
   * 首帧都无法可靠输出这个属性。所以用 CSS 在 hydration 前隐藏工作台：
   * 隐藏的子树不可聚焦，也不进读屏。挂载后再由 effect 设置 inert/aria-hidden。
   * 无 JS 时由 layout 的 <noscript> 覆盖这条规则，让工作台保持可见。
   */
  return (
    <>
      <div className={`app-shell${hydrated ? '' : ' is-boot-pending'}${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`} ref={appShellRef}>
        <Sidebar
          view={view}
          overview={overview}
          collapsed={sidebarCollapsed}
          onNavigate={navigate}
          onOpenConsole={() => openMemory()}
          onOpenPending={() => openMemory({ pending: true })}
          onOpenCommand={() => setCommandOpen(true)}
          onToggleCollapse={toggleSidebar}
        />

        <main className="app-main" id="view-scroll">
          {overviewError !== null && (
            <div className="global-banner" role="alert">
              <span className="global-banner-icon">
                <IconAlert />
              </span>
              <span>无法读取运行概览：{overviewError}</span>
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  void refreshOverview();
                }}
              >
                重试
              </button>
            </div>
          )}

          <div className="view-frame view-frame--chat" hidden={surface !== 'main' || view !== 'chat'}>
            <ChatView
              active={surface === 'main' && view === 'chat'}
              focusEnabled={!booting && surface === 'main' && view === 'chat'}
              overview={overview}
              newChatNonce={newChatNonce}
              dataResetNonce={dataResetNonce}
              onOpenAudit={openAudit}
              onOpenMemory={openMemory}
              onOpenSettings={openSettings}
              notify={notify}
              onRefreshOverview={() => void refreshOverview()}
              onBootState={handleChatBoot}
            />
          </div>

          {view === 'settings' && (
            <div className="view-frame view-frame--page view-enter" key="settings">
              <SettingsView
                overview={overview}
                notify={notify}
                onRefreshOverview={() => void refreshOverview()}
                onDataReset={onDataReset}
              />
            </div>
          )}
        </main>

        {consoleMounted && (
          <div className="console-host" hidden={surface !== 'console'}>
            <ConsoleShell
              section={consoleSection}
              leaving={consoleLeaving}
              overview={overview}
              auditRange={auditRange}
              memoryPreset={memoryPreset}
              onSection={openConsole}
              onExit={() => closeConsole()}
              onNavigate={navigate}
              onOpenMemory={openMemory}
              onClearRange={() => setAuditRange(null)}
              notify={notify}
              onRefreshOverview={() => void refreshOverview()}
              onShellMounted={handleConsoleShellMounted}
              onViewReady={handleConsoleViewReady}
            />
          </div>
        )}

        <CommandPalette
          open={commandOpen}
          onClose={() => setCommandOpen(false)}
          onNavigate={navigate}
          onNewChat={newChat}
          onExport={() => void exportData()}
          onRefresh={() => {
            void refreshOverview();
            notify('运行概览已刷新');
          }}
        />

        <ToastStack toasts={toasts} onDismiss={dismissToast} />

        {consoleTransition && (
          <ConsoleTransition
            mode={consoleMode}
            progress={consoleBoot.progress}
            stage={consoleBoot.stage}
            leaving={consoleTransitionLeaving}
          />
        )}
      </div>

      {booting && (
        <BootScreen
          progress={bootStatus.progress}
          stage={bootStatus.stage}
          ready={bootStatus.ready}
          error={bootStatus.error}
          onRetry={retryBoot}
          onDone={finishBoot}
        />
      )}
    </>
  );
}

/** 极小的内联图标，避免为一条横幅引入整套图标。 */
function IconAlert(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M12 4.5 21 19.5H3L12 4.5Z" />
      <path d="M12 10v4.2M12 17.2v.2" />
    </svg>
  );
}
