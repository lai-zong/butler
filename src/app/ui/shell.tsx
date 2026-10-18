/**
 * 外壳（客户端）—— 侧栏 + 主题 + 收起
 *
 * ★ 导航只有 5 项，按"我会来看什么"排，不按技术模块排：
 *   对话 → 概览 → 记忆 → 审计 → 设置
 *
 * ⚠️ 三个必须踩住的点（都是踩过才知道）：
 *   ① 偏好**挂载后**才读 —— 服务端没有 localStorage/matchMedia，
 *      写进 useState 初值会造成 hydration 前后不一致
 *   ② `path === '/app'` 这类要**精确匹配**，否则会与子路径一起高亮
 *   ③ localStorage 在隐私模式下会抛错 —— 全部包 try/catch，存不上不影响本次生效
 */

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

interface NavItem {
  readonly href: string;
  readonly label: string;
  /** 一句话说明（收起时作为 title）*/
  readonly hint: string;
}

const NAV: readonly NavItem[] = [
  { href: '/', label: '对话', hint: '和管家说话，它自己动手做' },
  { href: '/overview', label: '概览', hint: '它现在知道什么、学到了什么' },
  { href: '/memory', label: '记忆', hint: '它记住了你哪些事' },
  { href: '/audit', label: '审计', hint: '它凭什么这么说' },
  { href: '/settings', label: '设置', hint: '模型、外观、数据' },
];

export function Shell({
  children,
  pendingReview,
}: {
  readonly children: ReactNode;
  readonly pendingReview: number;
}): React.ReactElement {
  const path = usePathname();
  const [dark, setDark] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('butler-theme');
      if (saved === 'dark') setDark(true);
      else if (saved === 'light') setDark(false);
      else setDark(window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch {
      /* 隐私模式：用默认值 */
    }
    try {
      setCollapsed(window.localStorage.getItem('butler-nav') === 'collapsed');
    } catch {
      /* 同上 */
    }
    setReady(true);
  }, []);

  const toggleDark = useCallback(() => {
    setDark((v) => {
      const next = !v;
      try {
        window.localStorage.setItem('butler-theme', next ? 'dark' : 'light');
      } catch {
        /* 存不上不影响本次生效 */
      }
      return next;
    });
  }, []);

  const toggleNav = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem('butler-nav', next ? 'collapsed' : 'open');
      } catch {
        /* 同上 */
      }
      return next;
    });
  }, []);

  /**
   * ⚠️ 首帧用 `ready` 压住 `data-dark` 与 `data-collapsed`，
   *    避免"服务端浅色 → 客户端深色"的闪一下。
   */
  return (
    <div className="app" data-dark={ready && dark ? '' : undefined}>
      <aside className="side" data-collapsed={ready && collapsed ? '' : undefined}>
        <div className="side-brand">
          <span className="dot" aria-hidden />
          <span className="label">管家式 AI</span>
        </div>

        <nav className="side-nav">
          {NAV.map((item) => {
            // '/app' 类路径要精确匹配，否则子页也会点亮
            const on =
              item.href === '/'
                ? path === '/'
                : path === item.href || path.startsWith(`${item.href}/`);
            const badge = item.href === '/memory' && pendingReview > 0 ? pendingReview : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="side-item"
                data-on={on ? '' : undefined}
                title={collapsed ? `${item.label} — ${item.hint}` : item.hint}
                aria-current={on ? 'page' : undefined}
              >
                <span className="label">{item.label}</span>
                {badge !== null && <span className="n">{badge}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="side-foot">
          <button type="button" onClick={toggleDark} title={dark ? '切换到浅色' : '切换到深色'}>
            {dark ? '浅色' : '深色'}
          </button>
          <button type="button" onClick={toggleNav} title={collapsed ? '展开侧栏' : '收起侧栏'}>
            {collapsed ? '展开' : '收起'}
          </button>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
