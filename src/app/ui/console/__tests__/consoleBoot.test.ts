import { describe, expect, it } from 'vitest';

import { computeConsoleBootStatus } from '../consoleBoot.js';

const base = { mode: 'first' as const, mounted: true, shellMounted: false, dataReady: false };

describe('computeConsoleBootStatus · 控制台真实进度', () => {
  it('未挂载时从 0 开始', () => {
    const s = computeConsoleBootStatus({ ...base, mounted: false });
    expect(s).toMatchObject({ progress: 0, ready: false });
  });

  it('模块未挂载 / 数据未就绪 / 就绪 三档推进', () => {
    expect(computeConsoleBootStatus(base).progress).toBe(0.18);
    expect(computeConsoleBootStatus({ ...base, shellMounted: true }).progress).toBe(0.8);
    expect(computeConsoleBootStatus({ ...base, shellMounted: true, dataReady: true })).toMatchObject({
      progress: 1,
      ready: true,
    });
  });

  it('超时兜底：显示 95% 并放行，而不是永远卡住', () => {
    expect(computeConsoleBootStatus({ ...base, timedOut: true })).toMatchObject({
      progress: 0.95,
      ready: true,
    });
  });

  it('二次打开直接就绪，不再等取数', () => {
    const s = computeConsoleBootStatus({
      mode: 'quick',
      mounted: true,
      shellMounted: true,
      dataReady: true,
    });
    expect(s).toMatchObject({ progress: 1, ready: true });
  });

  it('首次打开不会因为 shell 已挂载就跳满：必须等数据', () => {
    const s = computeConsoleBootStatus({ ...base, shellMounted: true, dataReady: false });
    expect(s.ready).toBe(false);
    expect(s.progress).toBeLessThan(1);
  });
});
