/**
 * 登录失败限速：单进程、按来源键计数。
 *
 * 本地单机没有 Redis；这里只做“防连续猜密码”，重启进程后计数清零。
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function bucketFor(key: string, now: number): Bucket {
  const current = buckets.get(key);
  if (current !== undefined && current.resetAt > now) return current;
  const fresh: Bucket = { count: 0, resetAt: now + WINDOW_MS };
  buckets.set(key, fresh);
  return fresh;
}

export interface RateLimitState {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export function checkRateLimit(key: string, now = Date.now()): RateLimitState {
  const bucket = bucketFor(key, now);
  if (bucket.count < MAX_FAILURES) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

export function recordFailure(key: string, now = Date.now()): void {
  const bucket = bucketFor(key, now);
  bucket.count += 1;
}

export function clearFailures(key: string): void {
  buckets.delete(key);
}

/** 仅供测试：清空所有计数。 */
export function resetRateLimitForTests(): void {
  buckets.clear();
}
