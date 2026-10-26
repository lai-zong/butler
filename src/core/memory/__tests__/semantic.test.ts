import { describe, expect, it } from 'vitest';

import type { EmbeddingPort } from '../../ports/embedding.js';
import type { MemoryEntry } from '../types.js';
import { SemanticIndex } from '../semantic.js';

const T0 = 1_760_000_000_000;

function memory(id: string, content: string): MemoryEntry {
  return {
    id,
    owner: { kind: 'butler', userId: 'u' },
    memClass: 'global_shared',
    kind: 'preference',
    content,
    confidence: 0.8,
    evidence: [],
    fitness: 0.8,
    lifecycle: 'active',
    lastHitAt: T0,
    hitCount: 0,
    revivedCount: 0,
    scope: 'global',
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    useCount: 0,
  };
}

describe('SemanticIndex · 向量缓存', () => {
  it('同一记忆第二次查询不重复编码，查询本身每次编码', async () => {
    const calls: string[] = [];
    const fake: EmbeddingPort = {
      model: 'fake',
      embed: async (texts) => {
        calls.push(...texts);
        return texts.map((t) => [t.length, 1]);
      },
    };
    const index = new SemanticIndex(fake);
    const candidates = [memory('m1', '减脂期控油'), memory('m2', '喜欢清淡口味')];

    const first = await index.scores('火锅', candidates);
    expect(first.size).toBe(2);
    expect(calls).toEqual(['火锅', '减脂期控油', '喜欢清淡口味']);

    calls.length = 0;
    await index.scores('烧烤', candidates);
    // 只编码新查询，不重新编码两条记忆
    expect(calls).toEqual(['烧烤']);
  });

  it('重建后强制重新编码记忆向量', async () => {
    const calls: string[] = [];
    const fake: EmbeddingPort = {
      model: 'fake',
      embed: async (texts) => {
        calls.push(...texts);
        return texts.map(() => [1, 0]);
      },
    };
    const index = new SemanticIndex(fake);
    const candidates = [memory('m1', '喜欢咖啡')];
    await index.scores('咖啡', candidates);
    calls.length = 0;
    index.clear();
    await index.scores('咖啡', candidates);
    expect(calls).toEqual(['咖啡', '喜欢咖啡']);
  });

  it('记忆内容/版本变化后重新编码', async () => {
    let calls = 0;
    const fake: EmbeddingPort = {
      model: 'fake',
      embed: async (texts) => {
        calls += texts.length;
        return texts.map(() => [1, 0]);
      },
    };
    const index = new SemanticIndex(fake);
    const m = memory('m1', '旧内容');
    await index.scores('q', [m]);
    await index.scores('q', [{ ...m, content: '新内容', version: 2, updatedAt: T0 + 1 }]);

    // 两次查询 + 两条记忆（旧、新）
    expect(calls).toBe(4);
  });
});
