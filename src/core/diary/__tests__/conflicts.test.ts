import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { ModelPort } from '../../ports/model.js';
import { MemoryStore } from '../../memory/store.js';
import { reviewTrialConflicts } from '../conflicts.js';

const T0 = 1_760_000_000_000;

function fakeModel(kind: 'conflict' | 'noConflict' | 'unknown'): ModelPort {
  return {
    describe: () => ({
      provider: 'fake',
      model: 'fake-memory',
      capabilities: {
        supportsVision: false,
        supportsStreaming: false,
        supportsTools: false,
        supportsThinking: false,
      },
    }),
    complete: async () => {
      throw new Error('not used');
    },
    completeStructured: async () => ({
      value: { kind, reason: '测试裁决', candidateQuote: '喜欢安静', existingQuote: '喜欢热闹' },
      usage: { inputTokens: 1, outputTokens: 1 },
      attempts: 1,
    }),
  } as ModelPort;
}

function setup() {
  const log = new EventLog('conflict-review');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, 'u1');
  const active = store.create(
    { kind: 'butler', userId: 'u1' },
    {
      memClass: 'global_shared',
      kind: 'preference',
      content: '用户喜欢热闹',
      confidence: 0.9,
      evidence: ['diary:2026-10-20', 'diary:2026-10-21'],
      lifecycle: 'active',
    },
  );
  const trial = store.create(
    { kind: 'butler', userId: 'u1' },
    {
      memClass: 'global_shared',
      kind: 'preference',
      content: '用户喜欢安静',
      confidence: 0.8,
      evidence: ['diary:2026-10-27'],
      lifecycle: 'candidate',
    },
  );
  if (!active.ok || !trial.ok) throw new Error('seed failed');
  return { log, clock, store, active: active.entry.id, trial: trial.entry.id };
}

describe('reviewTrialConflicts', () => {
  it('模型判定冲突时保留稳定记忆，归档试行并留审计', async () => {
    const { log, clock, store, active, trial } = setup();
    const r = await reviewTrialConflicts({
      model: fakeModel('conflict'),
      log,
      clock,
      store,
      userId: 'u1',
    });
    expect(r.conflicts).toBe(1);
    expect(r.resolved).toBe(1);
    expect(store.get(active)?.lifecycle).toBe('active');
    expect(store.get(trial)?.lifecycle).toBe('archived');
    expect(log.byType('conflict.resolved')).toHaveLength(1);
  });

  it('unknown 不猜，记忆保持原样', async () => {
    const { log, clock, store, trial } = setup();
    const r = await reviewTrialConflicts({
      model: fakeModel('unknown'),
      log,
      clock,
      store,
      userId: 'u1',
    });
    expect(r.resolved).toBe(0);
    expect(store.get(trial)?.lifecycle).toBe('candidate');
  });
});
