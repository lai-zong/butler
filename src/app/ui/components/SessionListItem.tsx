'use client';

/**
 * 侧栏会话行
 *
 * ★ 一行只允许：标题、图钉（仅置顶时）、`···`。
 *   时间 / 消息条数 / 回合数 / 最新消息预览 / 人格标记都不在这里显示。
 *
 * ★ 结构是“行容器 + 主按钮 + 更多按钮”：
 *   HTML 不允许 button 嵌套，而 `···` 菜单不能触发切换会话。
 *
 * ★ 菜单三个真实入口：重命名、对话设置、置顶/取消置顶。
 *   “重命名”打开居中小对话框，不走浏览器 prompt。
 */

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';
import { RenameSessionDialog } from './RenameSessionDialog';
import type { SessionSummary } from '../lib/types.js';

interface SessionListItemProps {
  readonly session: SessionSummary;
  readonly active: boolean;
  /**
   * 这一行在当前排列下是否显示图钉。
   *
   * ★ 工作区模式只认 `pinnedWorkspace === effectiveWorkspace`：
   *   在别的工作区置顶过的会话，到本组不算置顶，也不显示图钉。
   */
  readonly pinned: boolean;
  readonly onOpen: () => void;
  readonly onOpenSettings: () => void;
  readonly onTogglePin: () => void;
  /** 保存重命名；失败向对话框抛错。 */
  readonly onRename: (title: string) => Promise<void>;
}

/** 三个菜单项的估算高度；用于决定向上还是向下展开。 */
const MENU_HEIGHT = 112;
const MENU_WIDTH = 152;

export function SessionListItem({
  session,
  active,
  pinned,
  onOpen,
  onOpenSettings,
  onTogglePin,
  onRename,
}: SessionListItemProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ readonly top: number; readonly left: number } | null>(
    null,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  /** 菜单文案跟“全局是否置顶”走（动作本身是全局开关），与图钉是否显示无关。 */
  const pinnedNow = session.pinnedAt !== null;

  useEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    const place = (): void => {
      const trigger = moreRef.current;
      if (trigger === null) return;
      const rect = trigger.getBoundingClientRect();
      const left = Math.min(
        Math.max(rect.right - MENU_WIDTH, 10),
        window.innerWidth - MENU_WIDTH - 10,
      );
      const top =
        window.innerHeight - rect.bottom >= MENU_HEIGHT + 12
          ? rect.bottom + 4
          : Math.max(10, rect.top - MENU_HEIGHT - 4);
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

  function closeMenu(): void {
    setMenuOpen(false);
  }

  return (
    <div
      ref={rootRef}
      className={`side-session${active ? ' is-active' : ''}${menuOpen ? ' has-menu' : ''}`}
      data-session-id={session.id}
    >
      <button
        type="button"
        className="side-session-main"
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
        title={session.title}
      >
        <span className="side-session-title">{session.title}</span>
      </button>

      {pinned && (
        <span className="side-session-pin" role="img" aria-label="已置顶" title="已置顶">
          <Icon name="pin" size={13} />
        </span>
      )}

      <button
        ref={moreRef}
        type="button"
        className="side-session-more"
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
        <Icon name="more" size={15} />
      </button>

      {menuOpen && menuPos !== null && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="side-session-menu"
              role="menu"
              aria-label="对话操作"
              style={{ top: menuPos.top, left: menuPos.left }}
            >
              <button
                type="button"
                role="menuitem"
                className="side-session-menu-item"
                onClick={() => {
                  closeMenu();
                  // 菜单项会随菜单卸载；把焦点先交还给“···”，
                  // 对话框关闭后 Modal 才能把焦点还到真正的触发按钮。
                  moreRef.current?.focus();
                  setRenameOpen(true);
                }}
              >
                <Icon name="pencil" size={14} />
                重命名
              </button>
              <button
                type="button"
                role="menuitem"
                className="side-session-menu-item"
                onClick={() => {
                  closeMenu();
                  moreRef.current?.focus();
                  onOpenSettings();
                }}
              >
                <Icon name="settings" size={14} />
                对话设置
              </button>
              <button
                type="button"
                role="menuitem"
                className="side-session-menu-item"
                onClick={() => {
                  closeMenu();
                  onTogglePin();
                }}
              >
                <Icon name="pin" size={14} />
                {pinnedNow ? '取消置顶' : '置顶'}
              </button>
            </div>,
            document.body,
          )
        : null}

      <RenameSessionDialog
        open={renameOpen}
        title={session.title}
        onClose={() => setRenameOpen(false)}
        onSubmit={onRename}
      />
    </div>
  );
}
