/**
 * 会话级互斥（2026-11-11）
 *
 * ★ 没有这把锁时，双击发送 / 前端重试 / 两个标签页会让同一个 session
 *   并行跑两轮 `runTurn`：事件交错、熔断计数各算各的、模型被调两次。
 *
 * ★ 与 `activeTurns` 计数器的区别：计数器只说"全局有没有在跑"，
 *   这把锁说"**这个会话**有没有在跑" —— 不同会话并发是正常用法，不能被误伤。
 */

import { describe, expect, it } from 'vitest';

import { acquireSessionTurn, isSessionBusy } from '../activeTurns.js';

describe('会话级执行权', () => {
  it('同一会话第二次获取失败，释放后可以再拿', () => {
    const release = acquireSessionTurn('s_lock_a');
    expect(release).not.toBeNull();
    expect(isSessionBusy('s_lock_a')).toBe(true);

    expect(acquireSessionTurn('s_lock_a')).toBeNull();

    release?.();
    expect(isSessionBusy('s_lock_a')).toBe(false);
    const again = acquireSessionTurn('s_lock_a');
    expect(again).not.toBeNull();
    again?.();
  });

  it('不同会话互不影响（并发用不同会话是正常用法）', () => {
    const a = acquireSessionTurn('s_lock_b');
    const b = acquireSessionTurn('s_lock_c');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a?.();
    expect(isSessionBusy('s_lock_c')).toBe(true);
    b?.();
  });

  it('重复释放是安全的（finally 与 cancel 可能都调到）', () => {
    const release = acquireSessionTurn('s_lock_d');
    release?.();
    expect(() => release?.()).not.toThrow();
    expect(isSessionBusy('s_lock_d')).toBe(false);
  });
});
