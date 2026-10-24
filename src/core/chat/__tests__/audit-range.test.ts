import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { TaskContract } from '../../butler/contract.js';
import { replaySessions, SessionStore } from '../types.js';

const T0 = 1_760_000_000_000;

const CONTRACT: TaskContract = {
  deliverable: '测试交付物',
  criteria: ['测试判据'],
  mustObey: [],
  domains: ['life'],
  confidence: 0.8,
  raw: {
    deliverable: '测试交付物',
    criteria: ['测试判据'],
    mustObey: [],
    domains: ['life'],
    confidence: 0.8,
  },
};

describe('本轮审计范围持久化', () => {
  it('消息上的 auditRange 会落事件并在重放后保留', () => {
    const log = new EventLog('s_audit_range');
    const store = new SessionStore(log, new FixedClock(T0), 'u');
    const session = store.createSession('s1');

    store.appendMessage(session.id, {
      role: 'butler',
      text: '回复',
      auditRange: { fromSeq: 4, toSeq: 12 },
    });

    const replayed = replaySessions(log.all());
    expect(replayed.messages[0]?.auditRange).toEqual({ fromSeq: 4, toSeq: 12 });
  });

  it('手动复核快照会落事件并在重放后保留', () => {
    const log = new EventLog('s_review_snapshot');
    const store = new SessionStore(log, new FixedClock(T0), 'u');
    const session = store.createSession('s2');

    store.appendMessage(session.id, {
      role: 'butler',
      text: '回复',
      reviewSnapshot: {
        userGoal: '今晚吃什么',
        contract: CONTRACT,
        hardConstraints: ['对花生过敏'],
        outputSummary: '推荐了清淡菜',
      },
    });

    const replayed = replaySessions(log.all());
    const snap = replayed.messages[0]?.reviewSnapshot;
    expect(snap?.userGoal).toBe('今晚吃什么');
    expect(snap?.contract.deliverable).toBe('测试交付物');
    expect(snap?.hardConstraints).toEqual(['对花生过敏']);
  });

  it('ReviewRun 会落事件并在重放后保留', () => {
    const log = new EventLog('s_review_run');
    const store = new SessionStore(log, new FixedClock(T0), 'u');
    const session = store.createSession('s3');
    const run = store.appendReviewRun({
      sessionId: session.id,
      turnIds: ['msg_1'],
      status: 'completed',
      model: 'fake',
      promptVersion: 'v1',
      snapshotHash: 'abc',
      stages: [{ name: 'supervision', status: 'done' }],
      report: { criteriaChecks: [], findings: [], summary: '通过' },
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    const replayed = replaySessions(log.all());
    expect(replayed.reviewRuns[0]?.id).toBe(run.id);
    expect(replayed.reviewRuns[0]?.report?.summary).toBe('通过');
  });
});
