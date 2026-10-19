'use client';

/**
 * 应用外壳 —— 空间切换、全局状态与快捷入口
 *
 * ★ 一个刻意的结构决定：**对话层始终挂载**。
 *   切去看记忆或审计时，正在进行的流式任务不会被打断；
 *   回来时草稿、滚动位置与过程都还在原处。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Sidebar } from './components/Sidebar';
import { CommandPalette } from './components/CommandPalette';
import { ToastStack } from './components/Toast';
import { ChatView } from './chat/ChatView';
import { MemoryView } from './memory/MemoryView';
import { AuditView } from './audit/AuditView';
import { GrowthView } from './growth/GrowthView';
import { SettingsView } from './settings/SettingsView';
import { errorMessage, fetchJson } from './lib/api.js';
import type { MemoryPreset, MemoryTarget, Overview, ToastMessage, ViewId } from './lib/types.js';

const VIEWS: readonly ViewId[] = ['chat', 'memory', 'audit', 'growth', 'settings'];

const TITLES: Record<ViewId, string> = {
  chat: '对话',
  memory: '记忆',
  audit: '审计',
  growth: '演化',
  settings: '设置',
};

function parseView(): ViewId {
  if (typeof window === 'undefined') return 'chat';
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  return (VIEWS as readonly string[]).includes(raw) ? (raw as ViewId) : 'chat';
}

export function ButlerApp(): JSX.Element {
  const [view, setView] = useState<ViewId>('chat');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);
  const [commandOpen, setCommandOpen] = useState(false);

  const [auditRange, setAuditRange] = useState<{ readonly fromSeq: number; readonly toSeq: number } | null>(null);
  const [memoryPreset, setMemoryPreset] = useState<MemoryPreset>({ nonce: 0 });
  const [newChatNonce, setNewChatNonce] = useState(0);
  const [dataResetNonce, setDataResetNonce] = useState(0);

  const toastSeq = useRef(0);
  const timers = useRef<Set<number>>(new Set());

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

  // 清理 toast 定时器
  useEffect(() => {
    const current = timers.current;
    return () => {
      for (const t of current) window.clearTimeout(t);
      current.clear();
    };
  }, []);

  // Hash 路由：可前进后退、可深链
  useEffect(() => {
    const sync = (): void => setView(parseView());
    if (window.location.hash.length === 0) {
      window.history.replaceState({ view: 'chat' }, '', '#/chat');
    } else {
      setView(parseView());
    }
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  useEffect(() => {
    document.title = `${TITLES[view]} · 管家`;
  }, [view]);

  // ⌘K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const navigate = useCallback((next: ViewId): void => {
    if (next === 'audit') setAuditRange(null);
    setView(next);
    const hash = `#/${next}`;
    if (window.location.hash !== hash) {
      window.history.pushState({ view: next }, '', hash);
    }
    document.getElementById('view-scroll')?.scrollTo({ top: 0 });
  }, []);

  const openMemory = useCallback(
    (target?: MemoryTarget): void => {
      setMemoryPreset((prev) => ({ ...target, nonce: prev.nonce + 1 }));
      navigate('memory');
    },
    [navigate],
  );

  const openAudit = useCallback(
    (range: { readonly fromSeq: number; readonly toSeq: number } | null): void => {
      navigate('audit');
      setAuditRange(range);
    },
    [navigate],
  );

  const openSettings = useCallback((): void => navigate('settings'), [navigate]);

  const newChat = useCallback((): void => {
    navigate('chat');
    setNewChatNonce((n) => n + 1);
  }, [navigate]);

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

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        overview={overview}
        onNavigate={navigate}
        onOpenPending={() => openMemory({ pending: true })}
        onOpenCommand={() => setCommandOpen(true)}
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

        <div className="view-frame view-frame--chat" hidden={view !== 'chat'}>
          <ChatView
            active={view === 'chat'}
            overview={overview}
            newChatNonce={newChatNonce}
            dataResetNonce={dataResetNonce}
            onOpenAudit={openAudit}
            onOpenMemory={openMemory}
            onOpenSettings={openSettings}
            notify={notify}
            onRefreshOverview={() => void refreshOverview()}
          />
        </div>

        {view === 'memory' && (
          <div className="view-frame view-frame--page view-enter" key="memory">
            <MemoryView
              overview={overview}
              preset={memoryPreset}
              onNavigate={navigate}
              notify={notify}
              onRefreshOverview={() => void refreshOverview()}
            />
          </div>
        )}

        {view === 'audit' && (
          <div className="view-frame view-frame--page view-enter" key="audit">
            <AuditView
              range={auditRange}
              onClearRange={() => setAuditRange(null)}
              onOpenMemory={openMemory}
              notify={notify}
            />
          </div>
        )}

        {view === 'growth' && (
          <div className="view-frame view-frame--page view-enter" key="growth">
            <GrowthView
              overview={overview}
              onNavigate={navigate}
              onOpenMemory={openMemory}
              onRefreshOverview={() => void refreshOverview()}
            />
          </div>
        )}

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
    </div>
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
