'use client';

/**
 * 侧栏里的会话列表
 *
 * ★ 与“时间 / 工作区”互斥切换：切换只改排列，不改数据。
 * ★ 列表独立滚动；品牌区与设置留在外面，不随列表滚走。
 * ★ 当前会话变化（新建、切换、从桌宠跳转）后自动滚到可见位置。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { EmptyState } from './Common';
import { Icon } from './Icon';
import { SessionListItem } from './SessionListItem';
import { useSessionIndex, listableSessions } from '../lib/sessionIndex.js';
import { groupByWorkspace, isPinnedInWorkspace, partitionByTime } from '../lib/sessionSort.js';
import { filterSessionsByQuery } from './sessionSearch.js';
import type { SessionSummary } from '../lib/types.js';

interface SidebarSessionsProps {
  /** 浮层形态（窄屏 / 图标栏）：需要遮罩与 Esc 关闭。 */
  readonly flyout: boolean;
  readonly onClose: () => void;
  readonly onNavigateToChat: () => void;
}

export function SidebarSessions({
  flyout,
  onClose,
  onNavigateToChat,
}: SidebarSessionsProps): JSX.Element {
  const {
    sessions,
    currentId,
    petSessionId,
    mode,
    setMode,
    openSession,
    openSettings,
    togglePin,
    renameSession,
    refresh,
  } = useSessionIndex();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');

  const visible = filterSessionsByQuery(listableSessions(sessions), query);

  // 面板打开时补一次列表：桌宠等其它入口创建的会话也能及时出现。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 当前会话滚进视口：只滚动列表容器，不带着整页一起动。
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null || currentId === null) return;
    const escaped = currentId.replace(/["\\]/g, '\\$&');
    const row = container.querySelector<HTMLElement>(`[data-session-id="${escaped}"]`);
    if (row === null) return;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // 留 2px 呼吸位，不要 6px：面板很矮时 6px 会把行顶出容器可视区。
    if (rowRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - rowRect.top + 2;
    } else if (rowRect.bottom > containerRect.bottom) {
      container.scrollTop += rowRect.bottom - containerRect.bottom + 2;
    }
  }, [currentId, mode, sessions]);

  useEffect(() => {
    if (!flyout) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [flyout, onClose]);

  const handleOpen = useCallback(
    (id: string): void => {
      onNavigateToChat();
      openSession(id);
      if (flyout) onClose();
    },
    [flyout, onClose, onNavigateToChat, openSession],
  );

  const handleSettings = useCallback(
    (id: string): void => {
      onNavigateToChat();
      openSettings(id);
      if (flyout) onClose();
    },
    [flyout, onClose, onNavigateToChat, openSettings],
  );

  function renderRow(session: SessionSummary): JSX.Element {
    return (
      <SessionListItem
        key={session.id}
        session={session}
        active={session.id === currentId}
        pinned={mode === 'workspace' ? isPinnedInWorkspace(session) : session.pinnedAt !== null}
        onOpen={() => handleOpen(session.id)}
        onOpenSettings={() => handleSettings(session.id)}
        onTogglePin={() => void togglePin(session.id)}
        onRename={(title) => renameSession(session.id, title)}
      />
    );
  }

  const groups = mode === 'workspace' ? groupByWorkspace(visible, petSessionId) : null;
  const time = mode === 'time' ? partitionByTime(visible, petSessionId) : null;

  const content = (
    <>
      {flyout && (
        <button
          type="button"
          className="side-sessions-backdrop"
          aria-label="关闭会话列表"
          onClick={onClose}
        />
      )}
      <section
        className={`side-sessions${flyout ? ' is-flyout' : ''}`}
        id="side-sessions"
        aria-label="对话列表"
      >
        <div className="side-sessions-head" role="group" aria-label="会话排列方式">
          <button
            type="button"
            className={`side-sessions-tab${mode === 'time' ? ' is-on' : ''}`}
            aria-pressed={mode === 'time'}
            onClick={() => setMode('time')}
            title="按时间排序：置顶优先"
          >
            <Icon name="clock" size={13} />
            时间
          </button>
          <button
            type="button"
            className={`side-sessions-tab${mode === 'workspace' ? ' is-on' : ''}`}
            aria-pressed={mode === 'workspace'}
            onClick={() => setMode('workspace')}
            title="按工作区分组：置顶只在所属工作区生效"
          >
            <Icon name="database" size={13} />
            工作区
          </button>
          {flyout && (
            <button
              type="button"
              className="side-sessions-close"
              onClick={onClose}
              aria-label="关闭会话列表"
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>

        <label className="side-sessions-search">
          <Icon name="search" size={13} />
          <input
            type="text"
            value={query}
            placeholder="搜索对话…"
            aria-label="搜索对话"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query.length > 0) {
                event.stopPropagation();
                setQuery('');
              }
            }}
          />
          {query.length > 0 && (
            <button
              type="button"
              className="side-sessions-search-clear"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </label>

        <div className="side-sessions-scroll" ref={scrollRef}>
          {visible.length === 0 && (
            <EmptyState
              compact
              icon="history"
              title={query.trim().length > 0 ? '没有匹配的对话' : '还没有对话'}
              description={
                query.trim().length > 0
                  ? '换个关键词试试，搜索范围是标题和最后一条消息。'
                  : '第一次开口之后，这里会出现历史。'
              }
            />
          )}

          {time !== null && (
            <>
              {time.rows.map((session) => renderRow(session))}
              {time.pet.length > 0 && (
                <div className="side-sessions-group">
                  <p className="side-sessions-group-title" title="桌宠固定会话">
                    <Icon name="user" size={11} />
                    <span>桌宠</span>
                  </p>
                  {time.pet.map((session) => renderRow(session))}
                </div>
              )}
            </>
          )}

          {groups !== null &&
            groups.map((group) => (
              <div className="side-sessions-group" key={group.key}>
                <p className="side-sessions-group-title" title={group.tooltip}>
                  {group.pet && <Icon name="user" size={11} />}
                  <span>{group.label}</span>
                </p>
                {group.pinned.map((session) => renderRow(session))}
                {group.rest.map((session) => renderRow(session))}
              </div>
            ))}
        </div>
      </section>
    </>
  );

  /**
   * 桌面窄窗口的浮层挂到 body：侧栏有 `backdrop-filter`，它会让 `position: fixed`
   * 的后代以侧栏为包含块 —— 不 portal 的话面板会错位、还可能被主区域的层盖住。
   */
  if (flyout && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }
  return content;
}
