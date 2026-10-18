/**
 * 组件级错误边界验证（v8 · AI 交互体验）
 *
 * ★ 这个文件测什么、不测什么，必须说清（否则会误以为覆盖了全部）：
 *
 *   **测**：`getDerivedStateFromError` 的错误 → 状态映射，
 *          这是本组件唯一**自己的**逻辑（其余是 React 的语义）。
 *
 *   **不测**：子树崩溃后"兄弟节点仍存活"这条隔离性 ——
 *          那是 React 的既有语义，不是我们的代码；
 *          要真测它需要 `jsdom + @testing-library/react`（目前没有装）。
 *          ⚠️ 所以不要在这里写"已验证隔离"这种话。
 *
 *   ⚠️ 关键断言：**detail 里不许出现堆栈**。
 *      边界最容易犯的错就是把 `err.stack` 甩到界面上 ——
 *      对用户毫无用处，还会把内部实现细节漏出去。
 */

import { describe, expect, it } from 'vitest';

import { AppErrorBoundary, BOUNDARY_INITIAL_STATE } from '../error-boundary.js';

describe('AppErrorBoundary.getDerivedStateFromError', () => {
  it('Error → failed=true，detail 取 message', () => {
    expect(AppErrorBoundary.getDerivedStateFromError(new Error('渲染炸了'))).toEqual({
      failed: true,
      detail: '渲染炸了',
    });
  });

  it('非 Error（字符串 / 数字 / null / 对象）也能转成 detail，不抛错', () => {
    expect(AppErrorBoundary.getDerivedStateFromError('字符串错误').detail).toBe('字符串错误');
    expect(AppErrorBoundary.getDerivedStateFromError(500).detail).toBe('500');
    expect(AppErrorBoundary.getDerivedStateFromError(null).detail).toBe('null');
    expect(AppErrorBoundary.getDerivedStateFromError(undefined).detail).toBe('undefined');
    expect(AppErrorBoundary.getDerivedStateFromError({ a: 1 }).detail).toBe('[object Object]');
  });

  it('★ detail 里不含堆栈（不把内部实现漏给用户）', () => {
    const err = new Error('带堆栈的错误');
    const state = AppErrorBoundary.getDerivedStateFromError(err);

    // 前提确认：这个 Error 确实有堆栈
    expect(typeof err.stack).toBe('string');
    expect((err.stack ?? '').length).toBeGreaterThan(0);

    // 而 detail 不含它
    expect(state.detail).not.toContain('at ');
    expect(state.detail).toBe('带堆栈的错误');
  });

  it('空 message 的 Error 也不抛错（详情由界面兜底成"（无信息）"）', () => {
    const state = AppErrorBoundary.getDerivedStateFromError(new Error(''));
    expect(state.failed).toBe(true);
    expect(state.detail).toBe('');
  });

  it('长度异常长的 message 不被截断（截断是渲染层的事，不是状态层）', () => {
    const long = 'x'.repeat(5_000);
    expect(AppErrorBoundary.getDerivedStateFromError(new Error(long)).detail).toHaveLength(5_000);
  });
});

describe('AppErrorBoundary 初始状态', () => {
  it('未出错时 failed=false 且 detail 为空（不会一挂载就显示兜底）', () => {
    // 类组件可以直接实例化读初始 state —— 比"断言函数存在"有意义得多
    const boundary = new AppErrorBoundary({ children: null, area: '推理过程' });
    expect(boundary.state).toEqual({ failed: false, detail: '' });
  });
});

describe('AppErrorBoundary 的「重试这一块」', () => {
  /**
   * ⚠️ **这里测什么、不测什么，必须说清：**
   *
   *   `reset()` 内部是 `this.setState(...)`。**未挂载**的类组件调用 setState
   *   不会更新 state（React 18 直接忽略并告警），所以无 DOM 环境下
   *   **无法**验证"点了重试真的回到正常渲染"。
   *
   *   → 本文件只验证**重置目标状态**（`BOUNDARY_INITIAL_STATE`）是干净的；
   *     `reset()` 的接线由"常量与初始 state 共用同一份"来保证（结构性，不靠人同步）。
   *     真实点击行为在浏览器里验证；等引入 jsdom + testing-library 后补真渲染测试。
   *
   *   ⚠️ 不要为了"让测试变绿"去伪造一个 setState 能生效的场景 —— 那是假通过。
   */
  it('★ 重置目标状态是干净的（failed=false 且 detail 为空）', () => {
    expect(BOUNDARY_INITIAL_STATE).toEqual({ failed: false, detail: '' });
  });

  it('★ 崩溃后的状态与重置目标状态不同（否则重试没有意义）', () => {
    const crashed = AppErrorBoundary.getDerivedStateFromError(new Error('炸了'));
    expect(crashed).not.toEqual(BOUNDARY_INITIAL_STATE);
    expect(crashed.failed).toBe(true);
    expect(crashed.detail).toBe('炸了');
  });

  it('★ 初始 state 与重置目标指向同一份（保证 reset 不留旧 detail）', () => {
    const boundary = new AppErrorBoundary({ children: null, area: '监督与执行' });
    expect(boundary.state).toBe(BOUNDARY_INITIAL_STATE);
  });
});
