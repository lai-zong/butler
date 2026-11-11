/**
 * 确认队列测试（不需要 jsdom）。
 *
 * 覆盖：
 *   · 没有 timeoutMs 的 approval 事件仍能进入队列并展示
 *   · 旧事件多带 timeoutMs 也不会污染界面状态
 *   · 只有明确“允许/拒绝”才出队，没有时间驱动的自动拒绝
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { SseEvent } from '../../lib/types.js';
import * as queueModule from '../approvalQueue.js';
import {
  approvalFromEvent,
  currentApproval,
  dequeueApproval,
  enqueueApproval,
  removeApproval,
} from '../approvalQueue.js';

const EVENT = {
  id: 'ap_1',
  toolName: 'write_file',
  tier: 'normal',
  summary: '写入 冰箱盘点.txt',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('approvalFromEvent', () => {
  it('SSE 类型契约里不再声明 timeoutMs', () => {
    expectTypeOf<Extract<SseEvent, { type: 'approval' }>>().not.toHaveProperty('timeoutMs');
  });

  it('没有 timeoutMs 的事件能生成可展示的队列项', () => {
    const item = approvalFromEvent(EVENT);

    expect(item).toEqual(EVENT);
    expect(item.toolName).toBe('write_file');
    expect(item.summary).toContain('写入');
    expect('timeoutMs' in item).toBe(false);
  });

  it('旧事件多带 timeoutMs 时会被丢弃，不进入界面状态', () => {
    const legacy = { ...EVENT, timeoutMs: 5_000 };
    const item = approvalFromEvent(legacy);

    expect('timeoutMs' in item).toBe(false);
    expect('receivedAt' in item).toBe(false);
  });

  it('preview 可选：有就保留，没有就不新造字段', () => {
    expect(approvalFromEvent({ ...EVENT, preview: '--- a\n+++ b' }).preview).toBe('--- a\n+++ b');
    expect('preview' in approvalFromEvent(EVENT)).toBe(false);
  });
});

describe('队列：展示与出队', () => {
  it('队首进入弹窗；允许/拒绝后才轮到下一个', () => {
    const first = approvalFromEvent(EVENT);
    const second = approvalFromEvent({
      ...EVENT,
      id: 'ap_2',
      toolName: 'exec',
      summary: '执行 dir',
    });

    let queue = enqueueApproval(enqueueApproval([], first), second);
    expect(currentApproval(queue)).toEqual(first);

    // 允许第一条
    queue = dequeueApproval(queue);
    expect(currentApproval(queue)).toEqual(second);

    // 拒绝第二条
    queue = dequeueApproval(queue);
    expect(currentApproval(queue)).toBeNull();
    expect(dequeueApproval([])).toEqual([]);
  });

  it('没有待确认时不伪造弹窗内容', () => {
    expect(currentApproval([])).toBeNull();
  });

  it('按 id 只移除当前卡，不影响等待期间新入队的请求', () => {
    const first = approvalFromEvent(EVENT);
    const second = approvalFromEvent({ ...EVENT, id: 'ap_2', summary: '执行 dir' });
    const queue = enqueueApproval(enqueueApproval([], first), second);

    const next = removeApproval(queue, first.id);
    expect(next).toEqual([second]);
    expect(removeApproval(queue, 'missing')).toEqual(queue);
  });
});

describe('没有自动拒绝', () => {
  it('长时间流逝不会改变队列；只有明确的出队操作才会清空', async () => {
    vi.useFakeTimers();
    const queue = enqueueApproval([], approvalFromEvent(EVENT));

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);

    expect(currentApproval(queue)).toEqual(approvalFromEvent(EVENT));
    expect(queue).toHaveLength(1);
  });

  it('模块不导出任何按时间过期/自动拒绝的函数', () => {
    const timeDriven = Object.keys(queueModule).filter((name) =>
      /timeout|expire|countdown|autoReject/i.test(name),
    );
    expect(timeDriven).toEqual([]);
  });
});
