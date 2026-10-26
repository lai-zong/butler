import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { replaySessions, SessionStore } from '../types.js';

const T0 = 1_760_000_000_000;

describe('会话模型选择', () => {
  it('模型选择落事件并可在重放后恢复', () => {
    const log = new EventLog('s_model_selection');
    const store = new SessionStore(log, new FixedClock(T0), 'u');
    const session = store.createSession('s1');

    store.setSessionModel(session.id, 'profile_deepseek', 'deepseek-flash');

    expect(store.getSession(session.id)?.modelProfileId).toBe('profile_deepseek');
    expect(store.getSession(session.id)?.modelId).toBe('deepseek-flash');

    const replayed = replaySessions(log.all());
    expect(replayed.sessions[0]?.modelProfileId).toBe('profile_deepseek');
    expect(replayed.sessions[0]?.modelId).toBe('deepseek-flash');
  });

  it('审查记录保存本次使用的模型配置', () => {
    const log = new EventLog('s_review_model_selection');
    const store = new SessionStore(log, new FixedClock(T0), 'u');
    const session = store.createSession('s3');
    const run = store.appendReviewRun({
      sessionId: session.id,
      turnIds: ['m1'],
      status: 'completed',
      model: 'deepseek-flash',
      modelProfileId: 'profile_deepseek',
      modelId: 'deepseek-flash',
      promptVersion: 'v1',
      snapshotHash: 'hash',
      stages: [{ name: 'supervision', status: 'done' }],
      report: { criteriaChecks: [], findings: [], summary: 'ok' },
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    const replayed = replaySessions(log.all());
    const saved = replayed.reviewRuns.find((r) => r.id === run.id);
    expect(saved?.modelProfileId).toBe('profile_deepseek');
    expect(saved?.modelId).toBe('deepseek-flash');
  });

  it('重复选择以最后一次为准', () => {
    const log = new EventLog('s_model_selection_last');
    const store = new SessionStore(log, new FixedClock(T0), 'u');
    const session = store.createSession('s2');

    store.setSessionModel(session.id, 'p1', 'model-a');
    store.setSessionModel(session.id, 'p2', 'model-b');

    const replayed = replaySessions(log.all());
    expect(replayed.sessions[0]?.modelProfileId).toBe('p2');
    expect(replayed.sessions[0]?.modelId).toBe('model-b');
  });
});
