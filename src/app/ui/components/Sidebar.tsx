'use client';

/**
 * 侧栏 —— 空间导航 + 会话历史
 *
 * 结构（自上而下，固定顺序）：
 *   [butler 品牌区]   整块可点：收起 / 展开侧边栏（不再是“回到对话”）
 *   定时任务
 *   控制台
 *   对话              点击展开 / 收起下面的会话列表
 *     [时间] [工作区]  互斥切换
 *     会话列表         独立滚动，品牌区与设置不跟着滚
 *   设置              固定在底部
 *
 * ★ 历史只能从侧栏进入：对话页顶部的“记录”按钮与左侧历史图标已删除。
 * ★ 侧栏收起时品牌图标仍可点开；设置仍以图标形式留在导航里。
 */

import { Icon, type IconName } from './Icon';
import { SidebarSessions } from './SidebarSessions';
import { useMediaQuery } from '../lib/hooks.js';
import type { ViewId } from '../lib/types.js';

interface NavItem {
  readonly id: ViewId;
  readonly label: string;
  readonly icon: IconName;
}

const NAV_TOP: readonly NavItem[] = [
  // 定时任务是用户自己的提醒与工作；放在对话与控制台之间，属于工作台而不是治理层。
  { id: 'tasks', label: '定时任务', icon: 'calendar' },
];

const NAV_BOTTOM: readonly NavItem[] = [
  { id: 'settings', label: '设置', icon: 'settings' },
];

interface SidebarProps {
  readonly view: ViewId;
  readonly collapsed: boolean;
  readonly sessionsOpen: boolean;
  readonly onNavigate: (view: ViewId) => void;
  readonly onOpenConsole: () => void;
  readonly onToggleCollapse: () => void;
  /** 点“对话”：在对话页时展开/收起列表，不在对话页时先过去再展开。 */
  readonly onChatClick: () => void;
  readonly onCloseSessions: () => void;
  readonly onNavigateToChat: () => void;
}

export function Sidebar({
  view,
  collapsed,
  sessionsOpen,
  onNavigate,
  onOpenConsole,
  onToggleCollapse,
  onChatClick,
  onCloseSessions,
  onNavigateToChat,
}: SidebarProps): JSX.Element {
  // 窄屏（≤1100）侧栏变成图标栏：会话列表改成从侧栏旁边弹出的浮层，不挤在 78px 里。
  const narrow = useMediaQuery('(max-width: 1100px)');
  const mobile = useMediaQuery('(max-width: 760px)');
  const showSessions = sessionsOpen && (narrow || !collapsed);

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
      <button
        type="button"
        className="brand"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
        title={collapsed ? '展开侧边栏' : '收起侧边栏'}
      >
        <span className="brand-mark">
          <Icon name="memory" size={17} strokeWidth={1.7} />
        </span>
        <span className="brand-text">
          <strong>butler</strong>
          <small>记得你，也懂你</small>
        </span>
        <span className="brand-caret" aria-hidden="true">
          <Icon name={collapsed ? 'chevronRight' : 'arrowLeft'} size={14} />
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

        <button
          type="button"
          className={`nav-item nav-item--chat ${view === 'chat' ? 'is-active' : ''}`}
          aria-current={view === 'chat' ? 'page' : undefined}
          aria-expanded={sessionsOpen}
          aria-controls="side-sessions"
          onClick={onChatClick}
          title="对话"
        >
          <span className="nav-icon">
            <Icon name="chat" size={18} />
          </span>
          <span className="nav-text">
            <strong>对话</strong>
          </span>
          <span className={`nav-chevron${sessionsOpen ? ' is-open' : ''}`} aria-hidden="true">
            <Icon name="chevronDown" size={13} />
          </span>
          <span className="nav-indicator" aria-hidden="true" />
        </button>

        {showSessions && (
          <SidebarSessions
            flyout={narrow}
            mobile={mobile}
            onClose={onCloseSessions}
            onNavigateToChat={onNavigateToChat}
          />
        )}

        <div className="side-nav-bottom">{NAV_BOTTOM.map(renderNavItem)}</div>
      </nav>
    </aside>
  );
}
