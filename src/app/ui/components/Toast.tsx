'use client';

/**
 * 轻提示 —— 只用来确认“刚才那一动作生效了”，不承载重要信息
 *
 * ⚠️ 失败信息也走它，但使用更长的停留时间与更明确的文案；
 *    需要用户决策的事情一律用对话框，不用 toast。
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ToastMessage } from '../lib/types.js';
import { Icon, type IconName } from './Icon';

const ICON: Record<ToastMessage['tone'], IconName> = {
  default: 'info',
  success: 'checkCircle',
  warning: 'alert',
  danger: 'xCircle',
};

interface ToastStackProps {
  readonly toasts: readonly ToastMessage[];
  readonly onDismiss: (id: number) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps): JSX.Element | null {
  /**
   * ★ 首帧必须与服务端一致（服务端没有 DOM，返回 null）。
   *
   * 直接 `typeof document === 'undefined'` 会让客户端首帧就创建 portal，
   * 而服务端这一块是空的；启动层接入后，React 会把 body 里已有的启动层
   * DOM 误认成 portal 的子节点，报 hydration 错误。
   * 等挂载后再创建 portal，是“仅客户端存在”结构的标准做法。
   */
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          <span className="toast-icon">
            <Icon name={ICON[t.tone]} size={16} />
          </span>
          <span className="toast-text">{t.text}</span>
          <button type="button" className="toast-close" onClick={() => onDismiss(t.id)} aria-label="关闭提示">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
