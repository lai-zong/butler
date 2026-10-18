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
   * ★★ 主题挂在 **`<html>`** 上，不是挂在 `.app` 上。
   *
   * ⚠️ 之前的写法（`<div className="app" data-dark>`）造成了两个真实缺陷：
   *   ① `body { background: var(--bg) }` 用的仍是**浅色**变量
   *      —— 因为变量被改写在 `.app` 上，而 `.app` 是 body 的子元素；
   *      于是没有自己背景的容器（`.main`/`.chat`/`.chat-body`）全透出白底。
   *   ② `color` 是从 body **继承下来的计算值**（深色文字），
   *      `.app` 没重设 color —— 深底配深字，用户气泡里的字就看不见了。
   *
   *    挂到 html 之后，body 的背景色与文字色都会跟着深色变量走。
   */
  useEffect(() => {
    const root = document.documentElement;
    if (ready && dark) root.setAttribute('data-dark', '');
    else root.removeAttribute('data-dark');
  }, [ready, dark]);

  return (
    <div className="app">
      <aside className="side" data-collapsed={ready && collapsed ? '' : undefined}>
        <div className="side-brand">
          <span className="dot" aria-hidden />
          <span className="label">butler</span>
          <button
            type="button"
            className="icon-btn side-theme"
            onClick={toggleDark}
            title={dark ? '切换到浅色' : '切换到深色'}
            aria-label={dark ? '切换到浅色' : '切换到深色'}
          >
            {dark ? <IconSun /> : <IconMoon />}
          </button>
        </div>

        <nav className="side-nav">
          {NAV.map((item) => {
            // '/' 要精确匹配，否则所有子路径都会点亮首页
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

        {/*
          收起 / 展开：一行「› 收起」，收起后只剩箭头。
          ⚠️ 用同一个箭头（而不是“展开/收起”两种文案）——
             位置不变、点击目标不变，用户不用重新找按钮。
        */}
        <div className="side-foot">
          <button
            type="button"
            className="side-collapse"
            onClick={toggleNav}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            aria-expanded={!collapsed}
          >
            <span className="chev" aria-hidden>
              &gt;
            </span>
            <span className="label">收起</span>
          </button>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}

/**
 * 图标：内联 SVG，描边走 `currentColor`。
 *
 * ⚠️ 刻意不引图标库：只有两个图标，引一个包会让首屏 JS 变大，
 *    而且风格还得再对齐一次。
 */
function IconMoon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

function IconSun(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
