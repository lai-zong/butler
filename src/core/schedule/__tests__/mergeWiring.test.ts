import { describe, expect, it, vi } from 'vitest';

import { buildTasks } from '../tasks.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../../memory/store.js';

const T0 = 1_760_000_000_000;
const USER = 'u_test';

function tasks(merge?: () => { readonly merged: number; readonly absorbed: number }) {
  const log = new EventLog('s_merge');
  const clock = new FixedClock(T0);
  return buildTasks({
    log,
    clock,
    store: new MemoryStore(log, clock, USER),
    userId: USER,
    observer: undefined as never,
    sessionCount: () => 0,
    ...(merge !== undefined ? { merge } : {}),
  });
}

const ctx = { kind: 'weeklyReview' as const, scheduledAt: T0, manual: true };

describe('周复盘相似合并接线', () => {
  it('注入 merge 时调用并写进摘要', async () => {
    const merge = vi.fn(() => ({ merged: 2, absorbed: 3 }));
    const r = await tasks(merge).handlers.weeklyReview(ctx);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(r.summary).toContain('相似合并 2 组');
    expect(r.summary).toContain('吸收 3 条');
  });

  it('没有注入时如实写“未接入”，不假装合并过', async () => {
    const r = await tasks().handlers.weeklyReview(ctx);
    expect(r.summary).toContain('未接入相似合并');
  });
});
