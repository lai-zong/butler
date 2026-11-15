'use client';

/**
 * 专注计时。
 *
 * ★ 只是界面里的一个倒计时，不做系统通知、不写入服务端，也不在后台运行：
 *   离开专注空间就结束；回到页面时按真实时间校正，不会因为标签页休眠而走慢。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export const FOCUS_DURATIONS = [15, 25, 45, 60] as const;

export interface FocusTimerValue {
  readonly durationMin: number;
  readonly remainingMs: number;
  readonly running: boolean;
  readonly finished: boolean;
  readonly progress: number;
  readonly selectDuration: (minutes: number) => void;
  readonly start: () => void;
  readonly pause: () => void;
  readonly reset: () => void;
}

export function useFocusTimer(): FocusTimerValue {
  const [durationMin, setDurationMin] = useState(25);
  const [remainingMs, setRemainingMs] = useState(25 * 60_000);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const deadlineRef = useRef<number | null>(null);

  const settle = useCallback((): void => {
    const deadline = deadlineRef.current;
    if (deadline === null) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      deadlineRef.current = null;
      setRemainingMs(0);
      setRunning(false);
      setFinished(true);
      return;
    }
    setRemainingMs(left);
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(settle, 500);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') settle();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [running, settle]);

  const selectDuration = useCallback((minutes: number): void => {
    const safe = Number.isFinite(minutes) ? Math.max(1, Math.round(minutes)) : 25;
    deadlineRef.current = null;
    setDurationMin(safe);
    setRemainingMs(safe * 60_000);
    setRunning(false);
    setFinished(false);
  }, []);

  const start = useCallback((): void => {
    if (running) return;
    const nextRemaining = remainingMs > 0 ? remainingMs : durationMin * 60_000;
    deadlineRef.current = Date.now() + nextRemaining;
    setRemainingMs(nextRemaining);
    setFinished(false);
    setRunning(true);
  }, [durationMin, remainingMs, running]);

  const pause = useCallback((): void => {
    if (!running) return;
    const deadline = deadlineRef.current;
    if (deadline !== null) {
      setRemainingMs(Math.max(0, deadline - Date.now()));
    }
    deadlineRef.current = null;
    setRunning(false);
  }, [running]);

  const reset = useCallback((): void => {
    deadlineRef.current = null;
    setRunning(false);
    setFinished(false);
    setRemainingMs(durationMin * 60_000);
  }, [durationMin]);

  const totalMs = durationMin * 60_000;
  const progress = totalMs > 0 ? Math.min(1, Math.max(0, 1 - remainingMs / totalMs)) : 0;

  return {
    durationMin,
    remainingMs,
    running,
    finished,
    progress,
    selectDuration,
    start,
    pause,
    reset,
  };
}
