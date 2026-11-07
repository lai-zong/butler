'use client';

/**
 * 浮层 —— 对话设置、审批、表单共用一套进出场
 *
 * ★ 行为都在这里收口：
 *   锁滚动、Esc 关闭、点遮罩关闭、焦点陷阱、关闭后把焦点还给触发元素。
 * ★ 形态只影响定位与宽度（dialog / wide / settings），
 *   不再保留右侧滑入的抽屉形态。
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';

type Variant = 'dialog' | 'wide' | 'settings';

interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly variant?: Variant;
  readonly closeOnBackdrop?: boolean;
  /** 用于“必须做一个选择”的确认框：不显示右上角关闭 */
  readonly hideClose?: boolean;
  /** 打开时优先聚焦的元素；缺省聚焦对话框本身。 */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /** 额外的根节点 class（例如抬高 z-index）。 */
  readonly rootClassName?: string;
  /** 额外的面板 class（例如对话框专属宽度）。 */
  readonly panelClassName?: string;
}

const EXIT_MS = 260;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = 'dialog',
  closeOnBackdrop = true,
  hideClose = false,
  initialFocusRef,
  rootClassName,
  panelClassName,
}: ModalProps): JSX.Element | null {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  /** 最新 onClose 只走 ref：避免父组件每次渲染都重跑焦点捕获 effect。 */
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // 进场 / 退场
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Esc + 焦点
  useEffect(() => {
    if (!open) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const timer = window.setTimeout(() => {
      (initialFocusRef?.current ?? panelRef.current)?.focus();
    }, 30);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (panel === null) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = bodyOverflow;
      if (previous !== null) previous.focus();
    };
  }, [initialFocusRef, open]);

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={`modal-root modal-root--${variant}${rootClassName !== undefined ? ` ${rootClassName}` : ''} ${visible ? 'is-open' : ''}`}
      onMouseDown={(e) => {
        if (!closeOnBackdrop) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-backdrop" aria-hidden="true" onMouseDown={closeOnBackdrop ? onClose : undefined} />
      <div
        ref={panelRef}
        className={`modal-panel modal-panel--${variant}${panelClassName !== undefined ? ` ${panelClassName}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        tabIndex={-1}
      >
        {title !== undefined && (
          <header className="modal-head">
            <div className="modal-head-text">
              <h2 id={titleId}>{title}</h2>
              {description !== undefined && <p>{description}</p>}
            </div>
            {!hideClose && (
              <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
                <Icon name="close" size={18} />
              </button>
            )}
          </header>
        )}
        <div className="modal-body">{children}</div>
        {footer !== undefined && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
