import { afterEach, describe, expect, it } from 'vitest';

import {
  checkRateLimit,
  clearFailures,
  recordFailure,
  resetRateLimitForTests,
} from '../localAuthRateLimit.js';

afterEach(() => {
  resetRateLimitForTests();
});

describe('本地登录限速', () => {
  it('达到阈值后拒绝并给出重试秒数', () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      expect(checkRateLimit('local', now).allowed).toBe(true);
      recordFailure('local', now);
    }
    const blocked = checkRateLimit('local', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('窗口过后恢复；成功登录可清空失败计数', () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i += 1) recordFailure('local', now);
    expect(checkRateLimit('local', now + 5 * 60 * 1000 + 1).allowed).toBe(true);

    for (let i = 0; i < 4; i += 1) recordFailure('other', now);
    clearFailures('other');
    expect(checkRateLimit('other', now).allowed).toBe(true);
  });
});
