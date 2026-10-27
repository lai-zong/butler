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
import type { ViewId } from '../lib/types.js';

interface NavItem {
  readonly id: ViewId;
  readonly label: string;
  readonly icon: IconName;
}

const NAV_TOP: readonly NavItem[] = [
  { id: 'chat', label: '对话', icon: 'chat' },
];

const NAV_BOTTOM: readonly NavItem[] = [
  { id: 'settings', label: '设置', icon: 'settings' },
];

interface SidebarProps {
  readonly view: ViewId;
  readonly collapsed: boolean;
  readonly onNavigate: (view: ViewId) => void;
  readonly onOpenConsole: () => void;
  readonly onOpenCommand: () => void;
  readonly onToggleCollapse: () => void;
}

export function Sidebar({
  view,
  collapsed,
  onNavigate,
  onOpenConsole,
  onOpenCommand,
  onToggleCollapse,
}: SidebarProps): JSX.Element {
  function renderNavItem(item: NavItem): JSX.Element {
    const active = view === item.id;
    return (
      <button
        key={item.id}
        type="button"
        className={`nav-item ${active ? 'is-active' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={() => onNavigate(item.id)}
        title={item.label}
      >
        <span className="nav-icon">
          <Icon name={item.icon} size={18} />
        </span>
        <span className="nav-text">
          <strong>{item.label}</strong>
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
          title="控制台"
        >
          <span className="nav-icon">
            <Icon name="console" size={18} />
          </span>
          <span className="nav-text">
            <strong>控制台</strong>
          </span>
          <span className="nav-console-arrow" aria-hidden="true">
            <Icon name="chevronRight" size={13} />
          </span>
          <span className="nav-console-line" aria-hidden="true" />
        </button>

        {NAV_BOTTOM.map(renderNavItem)}
      </nav>

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
