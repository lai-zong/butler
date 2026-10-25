import { describe, expect, it } from 'vitest';

import { EventLog } from '../../../core/events/log.js';
import { toSessionCancellations } from '../cancellations.js';

describe('会话取消记录投影', () => {
  it('只返回指定会话，并保留阶段/工具数/序号', () => {
    const log = new EventLog('s_cancel');
    log.append({
      type: 'session.cancelled',
      actor: 'user',
      payload: {
        sessionId: 's_cancel',
        reason: 'user_cancelled',
        phase: 'execute',
        fromSeq: 11,
        toSeq: 18,
        toolCalls: 3,
        toolResults: 2,
      },
      createdAt: 123,
    });
    log.append({
      type: 'session.cancelled',
      actor: 'user',
      payload: { sessionId: 'other', phase: 'execute' },
      createdAt: 124,
    });

    const rows = toSessionCancellations(log, 's_cancel');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: 'user_cancelled',
      phase: 'execute',
      fromSeq: 11,
      toSeq: 18,
      toolCalls: 3,
      toolResults: 2,
      createdAt: 123,
    });
  });

  it('字段缺失时使用安全默认值，不抛异常', () => {
    const log = new EventLog('s_cancel_defaults');
    log.append({
      type: 'session.cancelled',
      actor: 'user',
      payload: { sessionId: 's_cancel_defaults' },
      createdAt: 5,
    });
    const rows = toSessionCancellations(log, 's_cancel_defaults');
    expect(rows[0]).toMatchObject({
      reason: 'user_cancelled',
      phase: 'unknown',
      fromSeq: 0,
      toSeq: 0,
      toolCalls: 0,
      toolResults: 0,
    });
  });
});
