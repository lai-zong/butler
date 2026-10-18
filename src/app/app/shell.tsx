/**
 * 新版界面 · 统一外壳
 *
 * ★★ 一个窗口装下全部界面。
 *
 *   ⚠️ 这是我被指出问题后重写的第二版。第一版的错误是：
 *      **每个页面各自包一层外壳** ——
 *      切换页面时侧栏重建、收起状态与深浅色不共享、
 *      右栏只在对华页存在。视觉上像"几个独立小工具"，不是一个应用。
 *
 *   ★ 现在：外壳由 `layout.tsx` **只包一次**，跨路由保持挂载。
 *
 * ★ 右栏（监督与执行）的接入方式：
 *   它在语义上属于**对话**（执行只在对话时发生），
 *   但视觉上属于**外壳**（它是第二栏）。
 *   所以用 context：对话页把右栏内容**发布**出来，外壳渲染它。
 *   ⚠️ 不用 portal —— 那要额外的 DOM 节点与手动样式同步。
 *
 * ★ 布局按两张手绘图：
 *   图一：顶栏 + 侧栏 + 主区
 *   图二：主区在执行时分成左右两栏
 */

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import './new.css';

// ═══════════════════════════════════════════════════════════
// 右栏 context
// ═══════════════════════════════════════════════════════════

interface ShellCtx {
  /** 发布右栏内容。传 `null` 撤下。 */
  readonly setRight: (node: ReactNode | null) => void;
}

const Ctx = createContext<ShellCtx>({ setRight: () => undefined });

/**
 * 在页面里用：把右栏内容交给外壳。
 *
 * ⚠️ 用 `useEffect` 发布而不是在渲染期间直接调用 `setRight` ——
 *    后者会在渲染中触发父组件 setState，React 会警告
 *    「Cannot update a component while rendering a different component」。
 */
export function useRightPane(node: ReactNode | null): void {
  const { setRight } = useContext(Ctx);
  useEffect(() => {
    setRight(node);
    // 卸载时撤下右栏 —— 否则切到「记忆」页右栏还挂着上一次的执行
    return () => setRight(null);
  }, [node, setRight]);
}

// ═══════════════════════════════════════════════════════════
// 导航
// ═══════════════════════════════════════════════════════════

interface NavItem {
  readonly href: string;
  readonly icon: string;
  readonly label: string;
  /** 一句话说明这个页面干什么 ——
      ⚠️ 对大众用户，光看名字常常不知道点进去是什么。 */
  readonly hint: string;
}

/**
 * ★ 刻意**只有 4 项**，按使用频率排。
 *
 * ⚠️ 我刻意**不把**「记忆演化」「跨领域裁决」「行为观察」
 *    这些方案里的创新点做成独立菜单项 ——
 *    那是给评委看的结构，不是给用户用的结构。
 *    它们的能力体现在**对话的结果**里；
 *    想深挖的人从「审计」进去就能看到全过程。
 */
const NAV: readonly NavItem[] = [
  { href: '/app', icon: '💬', label: '对话', hint: '和管家说话，它自己动手做' },
  { href: '/app/memory', icon: '🧠', label: '记忆', hint: '它记住了你哪些事' },
  { href: '/app/audit', icon: '🔍', label: '审计', hint: '每次结论的依据与全过程' },
  { href: '/app/settings', icon: '⚙️', label: '设置', hint: '模型、外观、数据' },
];

// ═══════════════════════════════════════════════════════════
// 外壳
// ═══════════════════════════════════════════════════════════

export function AppShell({ children }: { readonly children: ReactNode }): ReactNode {
  const path = usePathname();
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [dark, setDark] = useState(false);
  const [right, setRight] = useState<ReactNode | null>(null);

  /**
   * ⚠️ 偏好**必须在挂载后读**，不能在 `useState` 初值里读：
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
      /* 隐私模式下 localStorage 可能抛错 —— 用默认值 */
    }
    try {
      setNavCollapsed(window.localStorage.getItem('butler-nav') === 'collapsed');
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
    setNavCollapsed((v) => {
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
   * ⚠️ `setRight` 必须**引用稳定**（`useCallback` 空依赖）——
   *    否则 `useRightPane` 的 effect 每次渲染都会重跑：
   *    先撤下再发布 → 右栏闪一下。
   */
  const ctx = useMemo<ShellCtx>(() => ({ setRight }), []);

  const split = right !== null;

  return (
    <Ctx.Provider value={ctx}>
      <div className="nv" data-dark={dark ? '' : undefined}>
        {/* ── 顶栏：品牌 + 两个开关（按用户定的规则，不做布局）── */}
        <header className="nv-top">
          <button
            type="button"
            className="nv-iconbtn"
            onClick={toggleNav}
            title={navCollapsed ? '展开侧栏' : '收起侧栏'}
            aria-label={navCollapsed ? '展开侧栏' : '收起侧栏'}
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
          <nav className="nv-side" data-collapsed={navCollapsed ? '' : undefined}>
            <div className="nv-side-head">
              {!navCollapsed && <span className="nv-side-title">导航</span>}
            </div>
            <div className="nv-nav">
              {NAV.map((item) => {
                /**
                 * ⚠️ 高亮判定：`/app` 要**精确匹配**，
                 *    否则它在 `/app/memory` 上也会亮。
                 */
                const on = item.href === '/app' ? path === '/app' : path.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="nv-nav-item"
                    data-on={on ? '' : undefined}
                    title={navCollapsed ? `${item.label} — ${item.hint}` : item.hint}
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

          {/* ── 主区 ──
              ⚠️ 两栏比例按图二是**各占一半**。
                 固定窄栏会让右栏看着像"附属信息面板"，
                 而两者地位是平等的（方案 § 2.2 平等编排）。 */}
          <main className="nv-main" data-split={split ? '' : undefined}>
            {children}
          </main>

          {/* ── 右栏（监督与执行）── */}
          {split && <aside className="nv-side-pane">{right}</aside>}
        </div>
      </div>
    </Ctx.Provider>
  );
}
