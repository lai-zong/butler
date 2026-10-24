import { describe, expect, it } from 'vitest';

import type { ModelPort } from '../../ports/model.js';
import type { ScoredMemory } from '../recall.js';
import { rerankRecall } from '../rerank.js';

function scored(id: string, content: string, hard = false): ScoredMemory {
  return {
    memory: {
      id,
      owner: { kind: 'butler', userId: 'u' },
      memClass: hard ? 'global_constraint' : 'global_shared',
      kind: 'preference',
      content,
      confidence: 0.8,
      evidence: [],
      fitness: 0.8,
      lifecycle: 'active',
      lastHitAt: 1,
      hitCount: 1,
      revivedCount: 0,
      scope: 'global',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      useCount: 1,
    },
    score: 0.8,
    relevance: 0.8,
    fitness: 0.8,
    confidence: 0.8,
    exploratory: false,
    why: '测试',
  };
}

function modelReturning(ids: readonly string[]): ModelPort {
  return {
    completeStructured: async () => ({
      value: { items: ids.map((id) => ({ id, relevance: 0.9 })) },
      usage: { inputTokens: 1, outputTokens: 1 },
      attempts: 1,
    }),
    complete: async () => {
      throw new Error('not used');
    },
    describe: () => {
      throw new Error('not used');
    },
  } as unknown as ModelPort;
}

describe('语义精排', () => {
  it('按模型顺序排非硬约束，硬约束仍然最前', async () => {
    const candidates = [
      scored('hard', '用户对花生过敏', true),
      scored('light', '用户喜欢清淡口味'),
      scored('fatloss', '用户正在减脂，需要控油'),
    ];
    const r = await rerankRecall({
      model: modelReturning(['fatloss', 'light']),
      query: '我想吃火锅',
      candidates,
    });

    expect(r.used).toBe(true);
    expect(r.items.map((x) => x.memory.id)).toEqual(['hard', 'fatloss', 'light']);
  });

  it('模型失败时保持原顺序', async () => {
    const candidates = [scored('a', 'A'), scored('b', 'B')];
    const model = {
      completeStructured: async () => {
        throw new Error('timeout');
      },
    } as unknown as ModelPort;
    const r = await rerankRecall({ model, query: 'q', candidates });
    expect(r.used).toBe(false);
    expect(r.fallbackReason).toContain('timeout');
    expect(r.items.map((x) => x.memory.id)).toEqual(['a', 'b']);
  });

  it('模型漏掉的候选追加到末尾，不丢记忆', async () => {
    const candidates = [scored('a', 'A'), scored('b', 'B'), scored('c', 'C')];
    const r = await rerankRecall({
      model: modelReturning(['b']),
      query: 'q',
      candidates,
    });
    expect(r.items.map((x) => x.memory.id)).toEqual(['b', 'a', 'c']);
  });
});
