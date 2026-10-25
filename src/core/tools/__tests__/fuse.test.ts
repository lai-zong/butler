import { describe, expect, it } from 'vitest';

import { ToolFuse } from '../fuse.js';

const T0 = 1_760_000_000_000;

describe('ToolFuse · 操作范围熔断', () => {
  it('窗口内超过阈值后拒绝，窗口滑过后恢复', () => {
    const fuse = new ToolFuse({ windowMs: 1_000, maxWrites: 2 });

    expect(fuse.allows(T0)).toBe(true);
    fuse.record(T0);
    fuse.record(T0 + 100);
    expect(fuse.allows(T0 + 200)).toBe(false);

    // 滑出窗口后恢复
    expect(fuse.allows(T0 + 1_101)).toBe(true);
  });

  it('只检查不记账：被拒绝的调用不消耗额度', () => {
    const fuse = new ToolFuse({ windowMs: 1_000, maxWrites: 1 });
    expect(fuse.allows(T0)).toBe(true);
    expect(fuse.allows(T0)).toBe(true); // 连续检查不会把自己锁死
    fuse.record(T0);
    expect(fuse.allows(T0 + 10)).toBe(false);
  });
});
