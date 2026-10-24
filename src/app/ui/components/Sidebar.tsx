'use client';

/**
 * 侧栏 —— 空间导航 + 一眼可见的状态
 *
 * ★ 侧栏只放「去哪」和「现在怎么样」，不放操作。
 *   操作属于各自空间（这样每个界面只有一处主操作，结构不打架）。
 *
 * ★ v10.2：记忆 / 审计 / 演化 合并成一个「控制台」入口，
 *   主界面只保留对话与设置。
 */

import { Icon, type IconName } from './Icon';
import type { Overview, ViewId } from '../lib/types.js';
import { formatNumber } from '../lib/format.js';

interface NavItem {
  readonly id: ViewId;
  readonly label: string;
  readonly hint: string;
  readonly icon: IconName;
}

const NAV_TOP: readonly NavItem[] = [
  { id: 'chat', label: '对话', hint: '与管家工作', icon: 'chat' },
];

const NAV_BOTTOM: readonly NavItem[] = [
  { id: 'settings', label: '设置', hint: '运行与数据', icon: 'settings' },
];

interface SidebarProps {
  readonly view: ViewId;
  readonly overview: Overview | null;
  readonly collapsed: boolean;
  readonly onNavigate: (view: ViewId) => void;
  readonly onOpenConsole: () => void;
  readonly onOpenPending: () => void;
  readonly onOpenCommand: () => void;
  readonly onToggleCollapse: () => void;
}

export function Sidebar({
  view,
  overview,
  collapsed,
  onNavigate,
  onOpenConsole,
  onOpenPending,
  onOpenCommand,
  onToggleCollapse,
}: SidebarProps): JSX.Element {
  const pending = overview?.memory.pending ?? 0;

  function renderNavItem(item: NavItem): JSX.Element {
    const active = view === item.id;
    return (
      <button
        key={item.id}
        type="button"
        className={`nav-item ${active ? 'is-active' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={() => onNavigate(item.id)}
        title={`${item.label} · ${item.hint}`}
      >
        <span className="nav-icon">
          <Icon name={item.icon} size={18} />
        </span>
        <span className="nav-text">
          <strong>{item.label}</strong>
          <small>{item.hint}</small>
        </span>
        <span className="nav-indicator" aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside className="sidebar" aria-label="主导航">
      <button type="button" className="brand" onClick={() => onNavigate('chat')} aria-label="butler · 回到对话">
        <span className="brand-mark">
          <Icon name="memory" size={17} strokeWidth={1.7} />
        </span>
        <span className="brand-text">
          <strong>butler</strong>
          <small>记得你，也懂你</small>
        </span>
      </button>

      <nav className="side-nav">
        <p className="side-caption">工作台</p>
        {NAV_TOP.map(renderNavItem)}

        <button
          type="button"
          className="nav-item nav-item--console"
          onClick={onOpenConsole}
          title="控制台 · 记忆 / 审计 / 演化"
        >
          <span className="nav-icon">
            <Icon name="console" size={18} />
          </span>
          <span className="nav-text">
            <strong>控制台</strong>
            <small>记忆 · 审计 · 演化</small>
          </span>
          {pending > 0 && (
            <span className="nav-badge" aria-label={`${pending} 条待审`}>
              {pending > 99 ? '99+' : pending}
            </span>
          )}
          <span className="nav-console-arrow" aria-hidden="true">
            <Icon name="chevronRight" size={13} />
          </span>
          <span className="nav-console-line" aria-hidden="true" />
        </button>

        {NAV_BOTTOM.map(renderNavItem)}
      </nav>

      <div className="side-glance">
        <div className="side-glance-head">
          <span>今日</span>
          <span className="side-glance-date">
            {overview !== null
              ? new Date(overview.now).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
              : '—'}
          </span>
        </div>

        {overview === null ? (
          <div className="side-glance-skel" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <div className="glance-rows">
            <div className="glance-row">
              <span className="glance-label">
                <i className="glance-dot glance-dot--ink" /> 发言
              </span>
              <span className="glance-value mono">{formatNumber(overview.totals.todayUserMessages)}</span>
            </div>
            <button type="button" className="glance-row is-action" onClick={onOpenPending}>
              <span className="glance-label">
                <i className={`glance-dot ${pending > 0 ? 'glance-dot--accent' : 'glance-dot--muted'}`} />
                待审候选
              </span>
              <span className={`glance-value mono ${pending > 0 ? 'is-accent' : ''}`}>
                {formatNumber(pending)}
              </span>
            </button>
            <div className="glance-row">
              <span className="glance-label">
                <i className="glance-dot glance-dot--muted" /> 新增记忆
              </span>
              <span className="glance-value mono">{formatNumber(overview.totals.todayMemories)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="side-foot">
        <button type="button" className="cmd-hint" onClick={onOpenCommand}>
          <span className="cmd-hint-left">
            <Icon name="command" size={14} />
            快速切换
          </span>
          <kbd>⌘ K</kbd>
        </button>
        <button
          type="button"
          className="side-collapse"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <span className="side-collapse-icon">
            <Icon name="panelLeft" size={16} />
          </span>
          <span className="side-collapse-text">收起侧边栏</span>
        </button>
      </div>
    </aside>
  );
}
