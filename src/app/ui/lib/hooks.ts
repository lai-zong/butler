'use client';

/**
 * 少量通用 hooks —— 只放真正复用的逻辑
 *
 * ⚠️ 不过度抽象：一个 hook 只有在一处以上使用时才值得存在。
 */

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** 数字从当前值平滑过渡到目标值。尊重 prefers-reduced-motion。 */
export function useCountUp(target: number, duration = 720): number {
  const [display, setDisplay] = useState(0);
  const currentRef = useRef(0);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const from = currentRef.current;
    if (reduce || duration <= 0 || from === target) {
      currentRef.current = target;
      setDisplay(target);
      return;
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number): void => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - p) ** 3;
      const v = from + (target - from) * eased;
      currentRef.current = v;
      setDisplay(v);
      if (p < 1) raf = requestAnimationFrame(tick);
      else currentRef.current = target;
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return display;
}

/** 每隔一段时间刷新一次 now（相对时间用）。 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** 文本域自动增高。 */
export function useAutoResize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeight = 220,
): void {
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    node.style.height = 'auto';
    const next = Math.min(maxHeight, node.scrollHeight);
    node.style.height = `${next}px`;
  }, [ref, value, maxHeight]);
}

/** 首帧之后再渲染依赖时间/随机的内容，避免服务端与客户端不一致。 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/** 全局快捷键。 */
export function useHotkey(combo: { key: string; meta?: boolean; ctrl?: boolean }, handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const keyMatch = e.key.toLowerCase() === combo.key.toLowerCase();
      if (!keyMatch) return;
      const metaOk = combo.meta === true ? e.metaKey : true;
      const ctrlOk = combo.ctrl === true ? e.ctrlKey : true;
      if (!metaOk || !ctrlOk) return;
      e.preventDefault();
      handlerRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo.key, combo.meta, combo.ctrl]);
}

/** 媒体查询（首帧为 false，避免服务端与客户端不一致）。 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = (): void => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return matches;
}
