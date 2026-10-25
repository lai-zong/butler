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
  return modelScored(ids.map((id) => ({ id, relevance: 0.9 })));
}

function modelScored(items: readonly { readonly id: string; readonly relevance: number }[]): ModelPort {
  return {
    completeStructured: async () => ({
      value: { items },
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

  it('★ 过滤模式：低于阈值的软记忆被丢弃，硬约束始终保留', async () => {
    const candidates = [
      scored('hard', '用户对花生过敏', true),
      scored('high', '用户正在减脂，需要控油'),
      scored('mid', '用户喜欢清淡口味'),
      scored('low', '用户喜欢安静的位置'),
    ];
    const r = await rerankRecall({
      model: modelScored([
        { id: 'low', relevance: 0.1 },
        { id: 'mid', relevance: 0.45 },
        { id: 'high', relevance: 0.9 },
      ]),
      query: '我想吃火锅',
      candidates,
      filter: true,
      minRelevance: 0.5,
    });

    expect(r.used).toBe(true);
    expect(r.items.map((x) => x.memory.id)).toEqual(['hard', 'high']);
  });

  it('过滤模式下模型漏掉的候选不保留（未评分 = 不进入结果）', async () => {
    const candidates = [scored('a', 'A'), scored('b', 'B'), scored('c', 'C')];
    const r = await rerankRecall({
      model: modelScored([{ id: 'a', relevance: 0.9 }]),
      query: 'q',
      candidates,
      filter: true,
      minRelevance: 0.5,
    });
    expect(r.items.map((x) => x.memory.id)).toEqual(['a']);
  });

  it('过滤模式下模型没有返回任何有效 id 时回退原顺序，不删光记忆', async () => {
    const candidates = [scored('a', 'A'), scored('b', 'B')];
    const r = await rerankRecall({
      model: modelScored([{ id: 'made-up', relevance: 0.9 }]),
      query: 'q',
      candidates,
      filter: true,
      minRelevance: 0.5,
    });
    expect(r.used).toBe(false);
    expect(r.items.map((x) => x.memory.id)).toEqual(['a', 'b']);
  });
});
