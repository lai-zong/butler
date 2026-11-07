'use client';

/**
 * 对话记录里的单行
 *
 * ★ 从 `<button>` 改成“行容器 + 主按钮 + 更多按钮”：
 *   HTML 不允许 button 嵌套，而“···”菜单不能触发切换对话。
 *
 * ★ 菜单目前只有「对话设置」：
 *   后端没有重命名/删除会话的端点，这里不画假菜单项。
 */

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../components/Icon';
import { relativeTime } from '../lib/format.js';
import type { SessionSummary } from '../lib/types.js';
import { settingsOf } from './sessionSettings.js';

interface HistorySessionRowProps {
  readonly session: SessionSummary;
  readonly active: boolean;
  readonly now: number;
  readonly onOpen: () => void;
  readonly onOpenSettings: () => void;
}

export function HistorySessionRow({
  session,
  active,
  now,
  onOpen,
  onOpenSettings,
}: HistorySessionRowProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ readonly top: number; readonly left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const settings = settingsOf(session);

  useEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    const place = (): void => {
      const trigger = moreRef.current;
      if (trigger === null) return;
      const rect = trigger.getBoundingClientRect();
      const width = 148;
      const height = 44;
      const left = Math.min(
        Math.max(rect.right - width, 10),
        window.innerWidth - width - 10,
      );
      const top =
        window.innerHeight - rect.bottom >= height + 12
          ? rect.bottom + 4
          : Math.max(10, rect.top - height - 4);
      setMenuPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    const onScroll = (): void => setMenuOpen(false);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) === true) return;
      if (menuRef.current?.contains(target) === true) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      moreRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const timer = window.setTimeout(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    }, 20);
    return () => window.clearTimeout(timer);
  }, [menuOpen]);

  return (
    <div
      ref={rootRef}
      className={`session-item ${active ? 'is-active' : ''} ${menuOpen ? 'has-menu' : ''}`}
    >
      <button
        type="button"
        className="session-item-main"
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
      >
        <span className="session-item-top">
          <strong>{session.title}</strong>
          <small>{relativeTime(session.updatedAt, now)}</small>
        </span>
        <span className="session-item-preview">
          {session.lastPreview.length > 0 ? session.lastPreview : '没有消息'}
        </span>
        <span className="session-item-meta mono">
          {session.messageCount} 条 · {session.turnCount} 回合
          {settings.hasPersona && (
            <span
              className="session-persona-mark"
              title={`已设置对话人格（${settings.personaLength} 字）`}
            >
              <i aria-hidden="true" />
              人格
            </span>
          )}
        </span>
      </button>

      <div className="session-item-actions">
        <button
          ref={moreRef}
          type="button"
          className="session-item-more"
          aria-label={`${session.title}的更多操作`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => setMenuOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
              if (!menuOpen) {
                event.preventDefault();
                setMenuOpen(true);
              }
            }
          }}
        >
          <Icon name="more" size={16} />
        </button>

        {menuOpen && menuPos !== null && typeof document !== 'undefined'
          ? createPortal(
              <div
                ref={menuRef}
                id={menuId}
                className="session-row-menu"
                role="menu"
                aria-label="对话操作"
                style={{ top: menuPos.top, left: menuPos.left }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="session-row-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenSettings();
                  }}
                >
                  <Icon name="settings" size={14} />
                  对话设置
                </button>
              </div>,
              document.body,
            )
          : null}
      </div>
    </div>
  );
}
