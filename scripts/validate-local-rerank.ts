/**
 * 本地 embedding 重排验证（不调用对话模型）。
 */

import { join } from 'node:path';

import { LocalBgeEmbedding } from '../src/adapters/embedding/localBge.js';
import { SemanticIndex } from '../src/core/memory/semantic.js';
import { rerankRecall } from '../src/core/memory/rerank.js';
import type { ScoredMemory } from '../src/core/memory/recall.js';
import type { MemoryEntry } from '../src/core/memory/types.js';

const T0 = 1_760_000_000_000;

function memory(id: string, content: string): MemoryEntry {
  return {
    id,
    owner: { kind: 'butler', userId: 'u1' },
    memClass: 'global_shared',
    kind: 'fact',
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

function scored(m: MemoryEntry): ScoredMemory {
  return {
    memory: m,
    score: 0.8,
    relevance: 0.8,
    fitness: 0.8,
    confidence: 0.8,
    exploratory: false,
    why: 'eval',
  };
}

const root = process.env['BUTLER_MODEL_DIR'] ?? join(process.cwd(), '.butler-data', 'models');
const index = new SemanticIndex(new LocalBgeEmbedding(root));
const candidates = [
  scored(memory('coffee', '用户喜欢喝美式咖啡。')),
  scored(memory('cilantro', '用户不吃香菜。')),
  scored(memory('quiet', '用户喜欢安静。')),
];
const r = await rerankRecall({
  scorer: {
    name: 'local-embedding',
    score: async (query, items) =>
      index.scores(
        query,
        items.map((c) => c.memory),
      ),
  },
  query: '晚饭可以放香菜吗？',
  candidates,
  filter: false,
});
console.log(
  JSON.stringify(
    {
      order: r.items.map((c) => ({ id: c.memory.id, content: c.memory.content })),
      used: r.used,
      latencyMs: r.latencyMs,
      top: r.items[0]?.memory.id,
    },
    null,
    2,
  ),
);
