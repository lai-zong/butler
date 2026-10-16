/**
 * 新版界面 · 外壳
 *
 * ★ 布局按两张手绘图：
 *   图一：顶栏 + 侧栏 + 主区（默认）
 *   图二：主区在仆人执行时分成左右两栏，**两侧各带输入框**
 *
 * ⚠️ 按用户定的两条规则：
 *   · 顶栏/侧栏**只做展开收起，不做布局**
 *   · 与仆人的沟通走独立窗口，不是管家的附属面板
 *
 * ★ 「一眼看完」的三个具体手法：
 *   ① **正文列限宽 760px 并居中** ——
 *      一行铺满 1500px 的屏幕会有一百多个汉字，眼睛要来回扫，很累
 *   ② **侧栏可收起** —— 只想看对话时把导航收掉，主区更宽
 *   ③ **默认只有对话** —— 记忆、审计这些按需进入，不占主界面
 */

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import './new.css';

interface NavItem {
  readonly href: string;
  readonly icon: string;
  readonly label: string;
  /** 一句话说明这个页面是干什么的（鼠标悬停显示）——
      ⚠️ 对大众用户，光看名字常常不知道点进去是什么。 */
  readonly hint: string;
}

/**
 * 导航项。
 *
 * ★ 刻意**只有 4 项**，且按使用频率排：
 *   对话是天天用的；记忆库偶尔核对；审计是"想追究时"才去；设置极少改。
 *
 * ⚠️ 我刻意**不把**「记忆演化」「跨领域裁决」「行为观察」这些
 *    方案里的创新点做成独立菜单项 —— 那是给评委看的结构，
 *    不是给用户用的结构。它们的能力体现在**对话的结果**里，
 *    想深挖的人从「审计」进去就能看到。
 */
const NAV: readonly NavItem[] = [
  { href: '/app', icon: '💬', label: '对话', hint: '和管家说话，它安排仆人干活' },
  { href: '/app/memory', icon: '🧠', label: '记忆', hint: '它记住了你哪些事，可以改或删' },
  { href: '/app/audit', icon: '🔍', label: '审计', hint: '每次结论的依据与全过程' },
  { href: '/app/settings', icon: '⚙️', label: '设置', hint: '模型、字号、深浅色' },
];

export function Shell({
  children,
  right,
}: {
  readonly children: ReactNode;
  /** 右栏（仆人窗口）。给了才分栏。 */
  readonly right?: ReactNode;
}): ReactNode {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [dark, setDark] = useState(false);

  /**
   * ⚠️ 深色偏好**必须在挂载后读**，不能在 `useState` 初值里读：
   *    服务端渲染时没有 `localStorage` 与 `matchMedia`，
   *    在初值里读会导致**服务端与客户端渲染结果不一致**（hydration 报错）。
   */
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('butler-theme');
      if (saved === 'dark') setDark(true);
      else if (saved === 'light') setDark(false);
      else setDark(window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch {
      // 隐私模式下 localStorage 可能抛错 —— 用默认值即可
    }
    try {
      setCollapsed(window.localStorage.getItem('butler-nav') === 'collapsed');
    } catch {
      /* 同上 */
    }
  }, []);

  const toggleDark = useCallback(() => {
    setDark((v) => {
      const next = !v;
      try {
        window.localStorage.setItem('butler-theme', next ? 'dark' : 'light');
      } catch {
        /* 存不上也不影响本次生效 */
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

  return (
    <div className="nv" data-dark={dark ? '' : undefined}>
      {/* ── 顶栏：只有品牌 + 两个开关（按用户定的规则，不做布局）── */}
      <header className="nv-top">
        <button
          type="button"
          className="nv-iconbtn"
          onClick={toggleNav}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        >
          ☰
        </button>
        <span className="nv-brand">管家式 AI</span>
        <span className="nv-top-spacer" />
        <button
          type="button"
          className="nv-iconbtn"
          onClick={toggleDark}
          title={dark ? '切换到浅色' : '切换到深色'}
          aria-label={dark ? '切换到浅色' : '切换到深色'}
        >
          {dark ? '☀' : '🌙'}
        </button>
      </header>

      <div className="nv-body">
        {/* ── 侧栏 ── */}
        <nav className="nv-side" data-collapsed={collapsed ? '' : undefined}>
          <div className="nv-side-head">
            {!collapsed && <span className="nv-side-title">导航</span>}
          </div>
          <div className="nv-nav">
            {NAV.map((item) => {
              // ⚠️ 精确匹配：否则 `/app` 会在 `/app/memory` 上也高亮
              const on = path === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="nv-nav-item"
                  data-on={on ? '' : undefined}
                  title={collapsed ? `${item.label} — ${item.hint}` : item.hint}
                >
                  <span className="nv-nav-icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="nv-nav-label">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        {/* ── 主区（+ 可选右栏）──
            ⚠️ 两栏比例按图二是**各占一半**。
               我第一版写的是 `width: 380px` 固定窄栏 ——
               那会让仆人那侧看着像"附属信息面板"，
               而两者地位是平等的。 */}
        <main className="nv-main" data-split={right !== undefined ? '' : undefined}>
          {children}
        </main>
        {right}
      </div>
    </div>
  );
}
