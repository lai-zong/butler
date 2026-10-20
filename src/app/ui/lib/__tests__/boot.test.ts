import { describe, expect, it } from 'vitest';

import { computeBootStatus, type ChatBootState } from '../boot.js';

const loadingSessions: ChatBootState = { state: 'loading', phase: 'sessions' };
const loadingSession: ChatBootState = { state: 'loading', phase: 'session' };
const ready: ChatBootState = { state: 'ready' };

describe('computeBootStatus', () => {
  it('does not advance before hydration', () => {
    const status = computeBootStatus({
      hydrated: false,
      overview: 'loading',
      chat: loadingSessions,
    });
    expect(status.progress).toBe(0.05);
    expect(status.stage).toBe('正在加载界面');
    expect(status.ready).toBe(false);
  });

  it('advances only after overview is ready', () => {
    expect(
      computeBootStatus({ hydrated: true, overview: 'loading', chat: loadingSessions }).stage,
    ).toBe('正在读取记忆');

    const status = computeBootStatus({ hydrated: true, overview: 'ready', chat: loadingSessions });
    expect(status.progress).toBe(0.55);
    expect(status.stage).toBe('正在恢复会话');
  });

  it('distinguishes session list from first session', () => {
    const session = computeBootStatus({ hydrated: true, overview: 'ready', chat: loadingSession });
    expect(session.progress).toBe(0.8);
    expect(session.stage).toBe('正在恢复最近对话');
  });

  it('is ready only when everything is loaded', () => {
    const status = computeBootStatus({ hydrated: true, overview: 'ready', chat: ready });
    expect(status.progress).toBe(1);
    expect(status.stage).toBe('进入工作台');
    expect(status.ready).toBe(true);
    expect(status.error).toBeNull();
  });

  it('surfaces an overview error instead of pretending success', () => {
    const status = computeBootStatus({
      hydrated: true,
      overview: 'error',
      overviewError: '连接失败',
      chat: ready,
    });
    expect(status.ready).toBe(false);
    expect(status.error).toBe('连接失败');
  });

  it('surfaces a chat error and a timeout', () => {
    expect(
      computeBootStatus({
        hydrated: true,
        overview: 'ready',
        chat: { state: 'error', error: '会话读取失败' },
      }).error,
    ).toBe('会话读取失败');

    expect(
      computeBootStatus({
        hydrated: true,
        overview: 'ready',
        chat: loadingSessions,
        timedOut: true,
      }).error,
    ).toContain('30 秒');
  });
});
