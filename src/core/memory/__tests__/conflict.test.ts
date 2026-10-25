import { describe, expect, it, afterEach } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../store.js';
import type { MemoryCandidate } from '../../reflection/reflect.js';
import type { ModelPort } from '../../ports/model.js';
import { explicitNegationConflict, detectConflicts } from '../conflict.js';
import { sinkAndAdmit } from '../../reflection/runReflection.js';

const T0 = 1_760_000_000_000;
const USER = 'u_conflict';

function candidate(content: string, evidence = '用户说：这是原话'): MemoryCandidate {
  return {
    id: `cand_${Math.random().toString(36).slice(2)}`,
    kind: 'preference',
    content,
    confidence: 0.9,
    evidence: [evidence],
    scope: { memClass: 'global_shared' },
    rationale: '测试',
    layer: 'butler',
    by: 'butler',
    createdAt: T0,
  };
}

function modelWith(value: unknown, onCall?: () => void): ModelPort {
  return {
    complete: () => Promise.reject(new Error('not used')),
    completeStructured: () => {
      onCall?.();
      return Promise.resolve({
        value,
        usage: { inputTokens: 1, outputTokens: 1 },
        attempts: 1,
        promptVersion: 'test',
      });
    },
    describe: () => ({
      provider: 'stub',
      model: 'stub',
      capabilities: {
        supportsVision: false,
        supportsStreaming: false,
        supportsTools: false,
        supportsThinking: false,
      },
    }),
  } as unknown as ModelPort;
}

function setup(): { log: EventLog; store: MemoryStore; clock: FixedClock } {
  const log = new EventLog('s_conflict');
  const clock = new FixedClock(T0);
  return { log, store: new MemoryStore(log, clock, USER), clock };
}

function addExisting(store: MemoryStore, content: string): void {
  const r = store.create(
    { kind: 'butler', userId: USER },
    {
      memClass: 'global_shared',
      kind: 'preference',
      content,
      confidence: 0.8,
      evidence: ['seed'],
      lifecycle: 'active',
    },
  );
  if (!r.ok) throw new Error(r.reason);
}

afterEach(() => {
  delete process.env['CONFLICT_DETECTION_MODE'];
});

describe('显式否定冲突', () => {
  it('同句加否定词 → conflict', () => {
    expect(explicitNegationConflict('对花生过敏', '对花生不过敏')).not.toBeNull();
    expect(explicitNegationConflict('喜欢安静', '不喜欢安静')).not.toBeNull();
    expect(explicitNegationConflict('周一去健身', '周一不去健身')).not.toBeNull();
  });

  it('相似但可共存 → 不能判冲突', () => {
    expect(explicitNegationConflict('喜欢安静的位置', '喜欢热闹的靠窗位')).toBeNull();
  });

  it('重复内容 / 不同句子 → 不能判冲突', () => {
    expect(explicitNegationConflict('喜欢安静', '喜欢安静')).toBeNull();
    expect(explicitNegationConflict('喜欢安静', '喜欢热闹')).toBeNull();
  });
});

describe('冲突检测', () => {
  it('off 模式不调用模型', async () => {
    const { log, store, clock } = setup();
    addExisting(store, '喜欢安静');
    let calls = 0;
    const result = await detectConflicts({
      mode: 'off',
      store,
      candidates: [candidate('不喜欢安静')],
      log,
      clock,
      model: modelWith({ kind: 'conflict', reason: 'x' }, () => { calls += 1; }),
    });
    expect(result.byCandidate.size).toBe(0);
    expect(calls).toBe(0);
  });

  it('显式否定命中时不调用模型', async () => {
    const { log, store, clock } = setup();
    addExisting(store, '喜欢安静');
    let calls = 0;
    const result = await detectConflicts({
      mode: 'review',
      store,
      candidates: [candidate('不喜欢安静')],
      log,
      clock,
      model: modelWith({ kind: 'conflict', reason: 'x' }, () => { calls += 1; }),
    });
    const conflicts = [...result.byCandidate.values()].flat();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.detector).toBe('explicit');
    expect(calls).toBe(0);
  });

  it('相似但不矛盾时模型返回 unknown → 不标记冲突', async () => {
    const { log, store, clock } = setup();
    addExisting(store, '喜欢安静的位置');
    const result = await detectConflicts({
      mode: 'review',
      store,
      candidates: [candidate('喜欢热闹的靠窗位')],
      log,
      clock,
      model: modelWith({
        kind: 'unknown',
        reason: '没有同一场景，不能证明矛盾',
      }),
    });
    expect(result.byCandidate.size).toBe(0);
  });

  it('模型明确冲突且引用双方时 → 标记冲突', async () => {
    const { log, store, clock } = setup();
    addExisting(store, '营业时间是九点');
    const result = await detectConflicts({
      mode: 'review',
      store,
      candidates: [candidate('营业时间是十点')],
      log,
      clock,
      model: modelWith({
        kind: 'conflict',
        reason: '同一门店的营业时间不可能同时为九点和十点',
        candidateQuote: '营业时间是十点',
        existingQuote: '营业时间是九点',
      }),
    });
    const conflicts = [...result.byCandidate.values()].flat();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.detector).toBe('model');
  });

  it('模型判断失败 → 不标记冲突，但落 judgeFailed 审计', async () => {
    const { log, store, clock } = setup();
    addExisting(store, '营业时间是九点');
    const model = {
      complete: () => Promise.reject(new Error('not used')),
      completeStructured: () => Promise.reject(new Error('model down')),
      describe: () => ({
        provider: 'stub',
        model: 'stub',
        capabilities: {
          supportsVision: false,
          supportsStreaming: false,
          supportsTools: false,
          supportsThinking: false,
        },
      }),
    } as unknown as ModelPort;
    const result = await detectConflicts({
      mode: 'review',
      store,
      candidates: [candidate('营业时间是十点')],
      log,
      clock,
      model,
    });
    expect(result.byCandidate.size).toBe(0);
    expect(result.modelErrors).toBe(1);
    expect(log.byType('conflict.judgeFailed')).toHaveLength(1);
  });
});

describe('准入接线', () => {
  it('检测到冲突后候选进入待审，并落 conflict.detected', async () => {
    process.env['CONFLICT_DETECTION_MODE'] = 'review';
    const { log, store, clock } = setup();
    addExisting(store, '营业时间是九点');
    const cand = candidate('营业时间是十点');
    const result = await sinkAndAdmit({
      log,
      store,
      clock,
      candidates: [cand],
      model: modelWith({
        kind: 'conflict',
        reason: '同一门店营业时间矛盾',
        candidateQuote: '营业时间是十点',
        existingQuote: '营业时间是九点',
      }),
    });
    expect(result.conflictsDetected).toBe(1);
    expect(result.pendingReview).toBe(1);
    expect(result.admittedAutonomously).toBe(0);
    expect(log.byType('conflict.detected')).toHaveLength(1);
  });
});
