'use client';

/**
 * 429 的倒计时。
 *
 * 服务端用 Retry-After 给出剩余秒数；界面把它变成逐秒减少的禁用态，
 * 让“请稍后再试”不是一句空话，也避免用户连续点击继续加重限速。
 */

import { useEffect, useState } from 'react';

interface RetryCountdown {
  readonly remaining: number | null;
  readonly start: (seconds: number) => void;
  readonly clear: () => void;
}

export function useRetryCountdown(): RetryCountdown {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (remaining === null) return;
    const timer = window.setTimeout(() => {
      setRemaining((current) => (current === null || current <= 1 ? null : current - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  return {
    remaining,
    start: (seconds: number) => setRemaining(Math.max(1, Math.ceil(seconds))),
    clear: () => setRemaining(null),
  };
}
