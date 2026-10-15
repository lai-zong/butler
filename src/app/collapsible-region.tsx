'use client';

/**
 * 可折叠区域 —— 给顶栏与侧栏用的**空壳机制**
 *
 * ★ 按用户要求：先把「展开 / 收起」的机制做好，**不在上面布局**。
 *   所以这个组件刻意不预设里面放什么 —— 它只负责：
 *     · 折叠状态（并持久化到 localStorage）
 *     · 展开 / 收起的过渡
 *     · 提供 `children` 插槽与 `title`（留空则完全空白）
 *
 * ⚠️ 水合注意：localStorage 只能在浏览器读，服务端渲染时拿不到。
 *    若在首次渲染就读它，会出现「服务端渲染展开、客户端渲染收起」的
 *    不匹配警告。所以初始一律按 `defaultOpen` 渲染，
 *    挂载后再读持久化值 —— 代价是有一帧的闪动，但不会报错。
 */

import { useEffect, useState } from 'react';

export type CollapseEdge = 'top' | 'left';

export function CollapsibleRegion({
  id,
  edge,
  defaultOpen = false,
  /** 收起后保留的尺寸（顶栏是高度，侧栏是宽度） */
  collapsedSize = 0,
  /** 展开后的尺寸 */
  expandedSize = 240,
  /** 收起时显示的一条窄条（可放展开按钮） */
  collapsedLabel,
  title,
  children,
}: {
  readonly id: string;
  readonly edge: CollapseEdge;
  readonly defaultOpen?: boolean;
  readonly collapsedSize?: number;
  readonly expandedSize?: number;
  readonly collapsedLabel?: React.ReactNode;
  readonly title?: React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  const storageKey = `butler.collapse.${id}`;
  const [open, setOpen] = useState(defaultOpen);
  const [ready, setReady] = useState(false);

  // 挂载后再读持久化状态（避免水合不匹配）
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved !== null) setOpen(saved === '1');
    } catch {
      // 隐私模式下 localStorage 可能不可用 —— 用默认值即可
    }
    setReady(true);
  }, [storageKey]);

  const toggle = (): void => {
    setOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        // 存不下也不影响本次使用
      }
      return next;
    });
  };

  const size = open ? expandedSize : collapsedSize;
  const isTop = edge === 'top';

  return (
    <div
      className={`collapsible ${isTop ? 'collapsible-top' : 'collapsible-left'}`}
      style={isTop ? { height: size } : { width: size }}
      data-ready={ready ? '1' : '0'}
    >
      {open ? (
        <>
          {(title !== undefined || collapsedLabel !== undefined) && (
            <div className="collapsible-head">
              <span className="collapsible-title">{title}</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={toggle}
                aria-label="收起"
                title="收起"
              >
                {isTop ? '▲' : '◀'}
              </button>
            </div>
          )}
          <div className="collapsible-body">{children}</div>
        </>
      ) : (
        <button
          type="button"
          className="collapsible-stub"
          onClick={toggle}
          aria-label="展开"
          title="展开"
        >
          {collapsedLabel ?? (isTop ? '▼' : '▶')}
        </button>
      )}
    </div>
  );
}
