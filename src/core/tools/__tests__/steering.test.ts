import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginTurnSteering,
  clearCancelRemainingTools,
  drainSteering,
  hasActiveTurn,
  shouldCancelRemainingTools,
  steerTurn,
  type TurnSteeringOptions,
} from '../steering.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function begin(sessionId: string, options: TurnSteeringOptions = {}) {
  const cleanup = beginTurnSteering(sessionId, options);
  cleanups.push(cleanup);
  return cleanup;
}

describe('当前轮 steering 队列', () => {
  it('接收消息后按顺序 drain，并通知持久化回调', () => {
    const seen: string[] = [];
    begin('s1', { onMessage: (text) => seen.push(text) });

    expect(steerTurn('s1', '第一句').ok).toBe(true);
    expect(steerTurn('s1', '第二句').ok).toBe(true);
    expect(seen).toEqual(['第一句', '第二句']);
    expect(drainSteering('s1')).toEqual(['第一句', '第二句']);
    expect(drainSteering('s1')).toEqual([]);
  });

  it('取消审批会调用本轮 cancelApprovals，并标记剩余工具取消', () => {
    const cancel = vi.fn(() => 2);
    begin('s2', { cancelApprovals: cancel });

    const result = steerTurn('s2', '先停一下', { cancelApprovals: true });
    expect(result).toMatchObject({ ok: true, cancelled: 2, queued: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(shouldCancelRemainingTools('s2')).toBe(true);

    clearCancelRemainingTools('s2');
    expect(shouldCancelRemainingTools('s2')).toBe(false);
  });

  it('没有活跃轮次时不接收，调用方应退回普通发送', () => {
    expect(hasActiveTurn('missing')).toBe(false);
    expect(steerTurn('missing', 'hello')).toMatchObject({ ok: false, queued: false });
  });

  it('清理后旧轮次不再接收消息', () => {
    const cleanup = begin('s3');
    expect(hasActiveTurn('s3')).toBe(true);
    cleanup();
    expect(hasActiveTurn('s3')).toBe(false);
    expect(steerTurn('s3', 'late')).toMatchObject({ ok: false });
  });
});
