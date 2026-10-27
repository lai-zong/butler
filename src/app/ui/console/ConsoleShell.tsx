'use client';

/**
 * 控制台 —— 第二界面
 *
 * 主界面是暖纸色的工作台；控制台是同一套产品语言的“治理终端”：
 * 深色底、更细的网格、单色等宽读数与少量磷光色。它不另起一套交互，
 * 而是把原来的记忆 / 审计 / 演化三个视图接进一个更紧凑的机架里。
 *
 * ★ 结构上它是一层 fixed 覆盖层，而不是替换主界面：
 *   主界面的对话仍然挂载，所以进入控制台不会打断正在进行的流式任务。
 */

import { useEffect, useRef, useState } from 'react';

import { Icon, type IconName } from '../components/Icon';
import { useNow } from '../lib/hooks.js';
import { formatNumber } from '../lib/format.js';
import { MemoryView } from '../memory/MemoryView';
import { AuditView } from '../audit/AuditView';
import { GrowthView } from '../growth/GrowthView';
import type {
  ConsoleSection,
  MemoryPreset,
  MemoryTarget,
  Overview,
  ToastMessage,
  ViewId,
} from '../lib/types.js';

interface SectionDef {
  readonly id: ConsoleSection;
  readonly code: string;
  readonly label: string;
  readonly icon: IconName;
}

const SECTIONS: readonly SectionDef[] = [
  { id: 'memory', code: '01', label: '记忆', icon: 'memory' },
  { id: 'audit', code: '02', label: '审计', icon: 'audit' },
  { id: 'growth', code: '03', label: '演化', icon: 'growth' },
];

interface ConsoleShellProps {
  readonly section: ConsoleSection;
  readonly leaving: boolean;
  readonly overview: Overview | null;
  readonly auditRange: { readonly fromSeq: number; readonly toSeq: number } | null;
  readonly memoryPreset: MemoryPreset;
  readonly onSection: (section: ConsoleSection) => void;
  readonly onExit: () => void;
  readonly onNavigate: (view: ViewId) => void;
  readonly onOpenMemory: (target?: MemoryTarget) => void;
  readonly onClearRange: () => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onRefreshOverview: () => void;
  /** Shell 首次挂载（动态模块已加载）时调用一次。 */
  readonly onShellMounted?: () => void;
  /** 当前分区首次取数结束时调用；用于控制台的真实进度。 */
  readonly onViewReady?: () => void;
}

export function ConsoleShell({
  section,
  leaving,
  overview,
  auditRange,
  memoryPreset,
  onSection,
  onExit,
  onNavigate,
  onOpenMemory,
  onClearRange,
  notify,
  onRefreshOverview,
  onShellMounted,
  onViewReady,
}: ConsoleShellProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shellMountedRef = useRef(onShellMounted);
  shellMountedRef.current = onShellMounted;

  const [visited, setVisited] = useState<readonly ConsoleSection[]>([section]);

  useEffect(() => {
    shellMountedRef.current?.();
  }, []);

  useEffect(() => {
    setVisited((prev) => (prev.includes(section) ? prev : [...prev, section]));
  }, [section]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [section]);

  const model = overview?.model?.model ?? 'NO MODEL';
  const total = overview?.memory.total ?? 0;
  const pending = overview?.memory.pending ?? 0;
  const events = overview?.totals.events ?? 0;

  return (
    <section
      className={`console-layer ${leaving ? 'is-leaving' : ''}`}
      aria-label="控制台"
    >
      <span className="console-frame console-frame--tl" aria-hidden="true" />
      <span className="console-frame console-frame--tr" aria-hidden="true" />
      <span className="console-frame console-frame--bl" aria-hidden="true" />
      <span className="console-frame console-frame--br" aria-hidden="true" />

      <aside className="console-rail" aria-label="控制台分区">
        <div className="console-rail-brand">
          <span className="cr-mark">
            <Icon name="console" size={17} />
          </span>
          <span className="cr-brand">CTRL</span>
        </div>

        <nav className="console-rail-nav">
          {SECTIONS.map((s) => {
            const active = s.id === section;
            return (
              <button
                key={s.id}
                type="button"
                className={`cr-item ${active ? 'is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => onSection(s.id)}
              >
                <span className="cr-code mono">{s.code}</span>
                <span className="cr-icon">
                  <Icon name={s.icon} size={18} />
                </span>
                <span className="cr-label">{s.label}</span>
                <span className="cr-active-line" aria-hidden="true" />
              </button>
            );
          })}
        </nav>

        <div className="console-rail-foot">
          <button type="button" className="cr-exit" onClick={onExit} aria-label="返回主界面">
            <Icon name="arrowLeft" size={15} />
            <span>主界面</span>
          </button>
          <span className="cr-local">
            <i aria-hidden="true" />
            LOCAL
          </span>
        </div>
      </aside>

      <div className="console-main">
        <header className="console-topbar">
          <div className="console-ident">
            <span className="console-sigil" aria-hidden="true">
              <Icon name="console" size={14} />
            </span>
            <span className="console-ident-title mono">CONTROL CONSOLE</span>
            <span className="console-ident-tag mono">LOCAL / GOVERNANCE</span>
          </div>

          <div className="console-hud">
            <span className="console-metric">
              <i>MEM</i>
              <b className="mono">{formatNumber(total)}</b>
            </span>
            <span className="console-metric">
              <i>TRIAL</i>
              <b className="mono">{formatNumber(pending)}</b>
            </span>
            <span className="console-metric">
              <i>EVT</i>
              <b className="mono">{formatNumber(events)}</b>
            </span>
            <span className="console-clock mono">
              <ConsoleClock />
            </span>
            <button type="button" className="console-exit-top" onClick={onExit}>
              <Icon name="arrowLeft" size={13} />
              退出
            </button>
          </div>
        </header>

        <div className="console-content" ref={scrollRef}>
          {visited.map((id) => (
            <div key={id} className="console-surface" hidden={id !== section}>
              {id === 'memory' && (
                <MemoryView
                  overview={overview}
                  preset={memoryPreset}
                  onNavigate={onNavigate}
                  notify={notify}
                  onRefreshOverview={onRefreshOverview}
                  {...(id === section && onViewReady !== undefined ? { onFirstReady: onViewReady } : {})}
                />
              )}
              {id === 'audit' && (
                <AuditView
                  range={auditRange}
                  onClearRange={onClearRange}
                  onOpenMemory={onOpenMemory}
                  notify={notify}
                  {...(id === section && onViewReady !== undefined ? { onFirstReady: onViewReady } : {})}
                />
              )}
              {id === 'growth' && (
                <GrowthView
                  overview={overview}
                  onNavigate={onNavigate}
                  onOpenMemory={onOpenMemory}
                  onRefreshOverview={onRefreshOverview}
                  {...(id === section && onViewReady !== undefined ? { onFirstReady: onViewReady } : {})}
                />
              )}
            </div>
          ))}
        </div>

        <footer className="console-footer">
          <span className="cf-item">
            <i aria-hidden="true" />
            SYS / LOCAL ONLY
          </span>
          <span className="cf-item mono">
            MEM {formatNumber(total)} · TRIAL {formatNumber(pending)} · EVT {formatNumber(events)}
          </span>
          <span className="cf-item mono">MODEL {model}</span>
          <span className="cf-end mono">BUTLER · TERMINAL 02</span>
        </footer>
      </div>
    </section>
  );
}

/** 单独隔离时钟，避免每秒重渲染整块控制台内容。 */
function ConsoleClock(): JSX.Element {
  const now = useNow(1000);
  return <>{new Date(now).toLocaleTimeString('zh-CN', { hour12: false })}</>;
}
