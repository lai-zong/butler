'use client';

/**
 * 应用外壳 —— 两个界面、一套状态
 *
 *   主界面：暖纸色工作台，只保留「对话」与「设置」。
 *   控制台：深色治理终端，只承接「记忆」与「演化」。
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
import { ToastStack } from './components/Toast';
import { BootScreen } from './components/BootScreen';
import { ChatView } from './chat/ChatView';
import { SettingsView } from './settings/SettingsView';
import { TasksView } from './tasks/TasksView';
import { DueReminderBanner } from './tasks/DueReminderBanner';
import { ConsoleTransition } from './console/ConsoleTransition';
import { computeConsoleBootStatus, type ConsoleBootMode } from './console/consoleBoot.js';
import { WebPet } from './pet/WebPet';
import { UsageReporter } from './usage/UsageReporter';
import { errorMessage, fetchJson } from './lib/api.js';
import { computeBootStatus, type ChatBootState } from './lib/boot.js';
import { SessionIndexProvider } from './lib/sessionIndex.js';
import type {
  ConsoleSection,
  MainView,
  MemoryPreset,
  MemoryTarget,
  Overview,
  ToastMessage,
  UsagePageId,
  ViewId,
} from './lib/types.js';

/** 控制台是第二界面：动态加载，首屏不解析它的模块与两个治理视图。 */
const ConsoleShell = dynamic(() => import('./console/ConsoleShell').then((m) => m.ConsoleShell), {
  ssr: false,
});

type Surface = 'main' | 'console';

const MAIN_TITLES: Record<MainView, string> = {
  chat: '对话',
  tasks: '定时任务',
  settings: '设置',
};

const SECTION_TITLES: Record<ConsoleSection, string> = {
  memory: '记忆',
  growth: '演化',
  usage: '使用节奏',
};

const CONSOLE_SECTIONS: readonly ConsoleSection[] = ['memory', 'growth', 'usage'];

interface Route {
  readonly surface: Surface;
  readonly view: MainView;
  readonly section: ConsoleSection;
}

/**
 * 解析 hash。
 *
 * 兼容旧深链：`#/memory` / `#/growth` 仍会落到控制台对应分区。
 * 旧的 `#/audit` 入口已删除，落到记忆页，避免收藏的地址变成空白。
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

  if (raw === 'memory' || raw === 'growth' || raw === 'usage') {
    return { surface: 'console', view: 'chat', section: raw };
  }
  // 审计页已删除；旧书签回到记忆，而不是落到主界面。
  if (raw === 'audit') {
    return { surface: 'console', view: 'chat', section: 'memory' };
  }

  if (raw === 'settings') return { surface: 'main', view: 'settings', section: 'memory' };
  if (raw === 'tasks') return { surface: 'main', view: 'tasks', section: 'memory' };
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
  const [sessionsOpen, setSessionsOpen] = useState(true);
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

  const [memoryPreset, setMemoryPreset] = useState<MemoryPreset>({ nonce: 0 });
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
      setSessionsOpen(window.localStorage.getItem('butler.sidebar.sessionsOpen') !== '0');
    } catch {
      // 隐私模式/禁用 storage 时忽略，保持默认
    }
  }, []);

  const applyCollapsed = useCallback((next: boolean): void => {
    setSidebarCollapsed(next);
    try {
      window.localStorage.setItem('butler.sidebar.collapsed', next ? '1' : '0');
    } catch {
      // 忽略写入失败
    }
  }, []);

  const toggleSidebar = useCallback((): void => {
    applyCollapsed(!sidebarCollapsed);
  }, [applyCollapsed, sidebarCollapsed]);

  const applySessionsOpen = useCallback((next: boolean): void => {
    setSessionsOpen(next);
    try {
      window.localStorage.setItem('butler.sidebar.sessionsOpen', next ? '1' : '0');
    } catch {
      // 忽略写入失败
    }
  }, []);

  const sidebarBeforeReviewRef = useRef<boolean | null>(null);
  const handleReviewModeChange = useCallback((open: boolean): void => {
    if (open) {
      setSidebarCollapsed((prev) => {
        if (sidebarBeforeReviewRef.current === null) sidebarBeforeReviewRef.current = prev;
        return true;
      });
      return;
    }
    const restore = sidebarBeforeReviewRef.current;
    if (restore !== null) {
      sidebarBeforeReviewRef.current = null;
      setSidebarCollapsed(restore);
    }
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
      const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
      // 审计页已删除：旧深链落到记忆，并把地址也改成新入口，避免刷新后继续停在旧地址。
      if (raw === 'audit' || raw === 'console/audit') {
        window.history.replaceState({ hash: '#/console/memory' }, '', '#/console/memory');
      }
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

  /**
   * 使用节奏只统计可映射到接口的页面。
   * 控制台里的「使用节奏」页本身不可上报 —— 停在这一页时暂停心跳，
   * 而不是把它冒充成记忆或演化。
   */
  const usagePage: UsagePageId | null =
    surface === 'console'
      ? consoleSection === 'usage'
        ? null
        : consoleSection
      : view;

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
      if (next === 'memory' || next === 'growth') {
        openConsole(next);
        return;
      }
      closeConsole(next);
    },
    [openConsole, closeConsole],
  );

  /** 从侧栏会话区进对话：只切视图，不额外开新会话。 */
  const ensureChatView = useCallback((): void => {
    if (view !== 'chat') closeConsole('chat');
  }, [closeConsole, view]);

  /**
   * “对话”导航的点击语义：
   *   · 不在对话页 → 先过去，并保证列表展开、侧栏不处于收起态；
   *   · 已在对话页 → 收起/展开列表；若侧栏收起着，先展开（否则列表没空间）。
   */
  const handleChatClick = useCallback((): void => {
    if (view !== 'chat') {
      closeConsole('chat');
      if (!sessionsOpen) applySessionsOpen(true);
      if (sidebarCollapsed) applyCollapsed(false);
      return;
    }
    if (sidebarCollapsed) {
      applyCollapsed(false);
      if (!sessionsOpen) applySessionsOpen(true);
      return;
    }
    applySessionsOpen(!sessionsOpen);
  }, [
    applyCollapsed,
    applySessionsOpen,
    closeConsole,
    sessionsOpen,
    sidebarCollapsed,
    view,
  ]);

  const openMemory = useCallback(
    (target?: MemoryTarget): void => {
      setMemoryPreset((prev) => ({ ...target, nonce: prev.nonce + 1 }));
      openConsole('memory');
    },
    [openConsole],
  );

  const openSettings = useCallback((): void => {
    closeConsole('settings');
  }, [closeConsole]);

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
    <SessionIndexProvider notify={notify}>
      <div className={`app-shell${hydrated ? '' : ' is-boot-pending'}${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`} ref={appShellRef}>
        <Sidebar
          view={view}
          collapsed={sidebarCollapsed}
          sessionsOpen={sessionsOpen}
          onNavigate={navigate}
          onOpenConsole={() => openMemory()}
          onToggleCollapse={toggleSidebar}
          onChatClick={handleChatClick}
          onCloseSessions={() => applySessionsOpen(false)}
          onNavigateToChat={ensureChatView}
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

          {/* 全局到期提醒：细条放在主区域顶部、聊天头部下方，不压输入框；控制台里不渲染。 */}
          <DueReminderBanner
            active={surface === 'main' && !booting && view !== 'tasks'}
            notify={notify}
            onOpenTasks={() => navigate('tasks')}
          />

          <div className="view-frame view-frame--chat" hidden={surface !== 'main' || view !== 'chat'}>
            <ChatView
              active={surface === 'main' && view === 'chat'}
              focusEnabled={!booting && surface === 'main' && view === 'chat'}
              overview={overview}
              dataResetNonce={dataResetNonce}
              onOpenMemory={openMemory}
              onOpenSettings={openSettings}
              notify={notify}
              onRefreshOverview={() => void refreshOverview()}
              onBootState={handleChatBoot}
              onReviewModeChange={handleReviewModeChange}
            />
          </div>

          {view === 'settings' && (
            <div className="view-frame view-frame--page view-enter" key="settings">
              <SettingsView
                notify={notify}
                onRefreshOverview={() => void refreshOverview()}
                onDataReset={onDataReset}
              />
            </div>
          )}

          {view === 'tasks' && (
            <div className="view-frame view-frame--page view-enter" key="tasks">
              <TasksView notify={notify} />
            </div>
          )}
        </main>

        {consoleMounted && (
          <div className="console-host" hidden={surface !== 'console'}>
            <ConsoleShell
              section={consoleSection}
              leaving={consoleLeaving}
              overview={overview}
              memoryPreset={memoryPreset}
              onSection={openConsole}
              onExit={() => closeConsole()}
              onNavigate={navigate}
              onOpenMemory={openMemory}
              notify={notify}
              onRefreshOverview={() => void refreshOverview()}
              onShellMounted={handleConsoleShellMounted}
              onViewReady={handleConsoleViewReady}
            />
          </div>
        )}

        {/*
         * Web 悬浮桌宠：挂在主界面层，所有主界面（对话/设置/任务）都在，
         * 进入控制台时传 active=false 隐藏；它自己读 pet-config 决定显示与否。
         * 启动动画期间不挂载，避免桌宠从启动页背后露出来。
         */}
        {!booting && <WebPet active={surface === 'main'} />}

        {/* 使用节奏心跳：只在页面可见、窗口聚焦、应用就绪时打点。 */}
        <UsageReporter page={usagePage} active={!booting} />

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
    </SessionIndexProvider>
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
