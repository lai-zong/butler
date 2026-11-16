/**
 * 中断消息：无论用户停止、网络断还是余额不足，
 * 已经发生的事都要留在历史里，并且可以被审查。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { replaySessions, SessionStore } from '../types.js';

const T0 = 1_760_000_000_000;

describe('中断消息持久化', () => {
  it('interrupted 状态与原因都会落事件并在重放后保留', () => {
    const log = new EventLog('s_interrupted');
    const store = new SessionStore(log, new FixedClock(T0), 'u');
    const session = store.createSession('s1');

    store.appendMessage(session.id, {
      role: 'butler',
      text: '> 本轮已终止：你点了停止。',
      status: 'interrupted',
      interruptReason: 'user_stopped',
      auditRange: { fromSeq: 3, toSeq: 9 },
    });

    const replayed = replaySessions(log.all());
    const msg = replayed.messages[0];
    expect(msg?.status).toBe('interrupted');
    expect(msg?.interruptReason).toBe('user_stopped');
    expect(msg?.auditRange).toEqual({ fromSeq: 3, toSeq: 9 });
  });

  it('已生成正文、narration 和思考都能落盘并在重放后保留', () => {
    const log = new EventLog('s_interrupted_partial');
    const store = new SessionStore(log, new FixedClock(T0), 'u');
    const session = store.createSession('s_partial');

    store.appendMessage(session.id, {
      role: 'butler',
      text: '已经生成的正文\n\n---\n\n> 本轮已终止',
      narration: '我先看一下文件。',
      reasoning: '需要先确认路径。',
      status: 'interrupted',
      interruptReason: 'user_stopped',
    });

    const replayed = replaySessions(log.all());
    const msg = replayed.messages[0];
    expect(msg?.text).toContain('已经生成的正文');
    expect(msg?.narration).toBe('我先看一下文件。');
    expect(msg?.reasoning).toBe('需要先确认路径。');
    expect(msg?.status).toBe('interrupted');
  });

  it('事件 payload 里带中断原因（刷新后仍能区分是谁断的）', () => {
    const log = new EventLog('s_interrupted_payload');
    const store = new SessionStore(log, new FixedClock(T0), 'u');
    const session = store.createSession('s2');

    store.appendMessage(session.id, {
      role: 'butler',
      text: '中断',
      status: 'interrupted',
      interruptReason: 'insufficient_balance',
    });

    const event = log.byType('session.message')[0];
    const payload = event?.payload as Record<string, unknown>;
    expect(payload['status']).toBe('interrupted');
    expect(payload['interruptReason']).toBe('insufficient_balance');
  });

  it('正常消息不会带上中断原因', () => {
    const log = new EventLog('s_normal');
    const store = new SessionStore(log, new FixedClock(T0), 'u');
    const session = store.createSession('s3');

    store.appendMessage(session.id, { role: 'butler', text: '正常' });
    const payload = log.byType('session.message')[0]?.payload as Record<string, unknown>;
    expect(payload['interruptReason']).toBeUndefined();
  });
});
