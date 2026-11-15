'use client';

/**
 * 第一界面主题状态 —— 暖纸浅色（默认）与纯黑深色
 *
 * ★ 持久化只用一个键：butler.theme = 'dark' | 'light'。
 *   没有存值时就是浅色，和改造前完全一致。
 * ★ 首帧由 layout 的阻塞脚本设置 data-theme；
 *   这里首帧仍按 light 渲染，挂载后再对齐 DOM / localStorage，
 *   避免服务端与客户端标记不一致（水合报错）。
 * ★ 切换优先用 View Transitions 做整页交叉淡入；
 *   不支持时只加一个短暂 class，让颜色类属性过渡，不常驻 transition。
 */

import { flushSync } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'butler.theme';

const TRANSITION_CLASS = 'is-theme-transition';
const TRANSITION_MS = 240;

function readTheme(): Theme {
  if (typeof document !== 'undefined') {
    if (document.documentElement.getAttribute('data-theme') === 'dark') return 'dark';
  }
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(theme: Theme): void {
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 隐私模式/禁用 storage 时只影响持久化，当前页面仍然切换
  }
}

export interface UseThemeResult {
  readonly theme: Theme;
  readonly toggleTheme: () => void;
}

export function useTheme(): UseThemeResult {
  const [theme, setTheme] = useState<Theme>('light');
  const transitionRef = useRef<ViewTransition | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);

  // 首帧与 SSR 保持一致；挂载后立刻对齐脚本已经设置好的值。
  useEffect(() => {
    const next = readTheme();
    setTheme(next);
    if (next === 'dark' && document.documentElement.getAttribute('data-theme') !== 'dark') {
      applyTheme(next);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (fallbackTimerRef.current !== null) window.clearTimeout(fallbackTimerRef.current);
      transitionRef.current?.skipTransition();
    };
  }, []);

  const toggleTheme = useCallback((): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    const root = document.documentElement;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const commit = (): void => {
      setTheme(next);
      applyTheme(next);
    };

    if (reduceMotion) {
      commit();
      return;
    }

    // 连点时不叠两层快照：先结束上一段，再开新的。
    transitionRef.current?.skipTransition();

    if (typeof document.startViewTransition === 'function') {
      try {
        const transition = document.startViewTransition(() => {
          flushSync(commit);
        });
        transitionRef.current = transition;
        void transition.finished
          .catch(() => undefined)
          .finally(() => {
            if (transitionRef.current === transition) transitionRef.current = null;
          });
        return;
      } catch {
        // 某些内嵌浏览器声明了 API 却拒绝执行；继续走 class 兜底。
      }
    }

    if (fallbackTimerRef.current !== null) window.clearTimeout(fallbackTimerRef.current);
    root.classList.add(TRANSITION_CLASS);
    fallbackTimerRef.current = window.setTimeout(() => {
      root.classList.remove(TRANSITION_CLASS);
      fallbackTimerRef.current = null;
    }, TRANSITION_MS);
    commit();
  }, [theme]);

  return { theme, toggleTheme };
}
