/**
 * 知识库检索离线基准：字面 / 语义 / 混合（RRF）。
 *
 * 复用 DocumentStore 的真实分片；本地 bge 模型只用于评测，不写产品数据。
 * 运行：
 *   node --import tsx scripts/eval-knowledge-retrieval.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalBgeEmbedding } from '../src/adapters/embedding/localBge.js';
import { DocumentStore, type DocumentHit } from '../src/core/documents/store.js';
import { KNOWLEDGE_DOCUMENTS, KNOWLEDGE_QUERIES, type KnowledgeQuery } from './eval-knowledge-data.js';

const SEMANTIC_MINS = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const RRF_K = 60;

interface Chunk {
  readonly id: string;
  readonly documentId: string;
  readonly name: string;
  readonly chunkIndex: number;
  readonly text: string;
}

interface ScoredHit extends DocumentHit {
  readonly lexicalRank?: number;
  readonly semanticScore?: number;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function matches(hit: { text: string }, query: KnowledgeQuery): boolean {
  return query.want.length > 0 && query.want.every((w) => hit.text.includes(w));
}

function scoreMode(
  name: string,
  queries: readonly KnowledgeQuery[],
  results: ReadonlyMap<string, readonly { text: string }[]>,
): Record<string, number> {
  const positives = queries.filter((q) => q.type !== 'negative');
  const negatives = queries.filter((q) => q.type === 'negative');
  let hit1 = 0;
  let hit3 = 0;
  let hit5 = 0;
  let rr = 0;
  for (const q of positives) {
    const hits = results.get(q.q) ?? [];
    const rank = hits.findIndex((h) => matches(h, q));
    if (rank === 0) hit1 += 1;
    if (rank >= 0 && rank < 3) hit3 += 1;
    if (rank >= 0 && rank < 5) hit5 += 1;
    if (rank >= 0) rr += 1 / (rank + 1);
  }
  let falsePositive = 0;
  for (const q of negatives) {
    if ((results.get(q.q) ?? []).length > 0) falsePositive += 1;
  }
  const total = Math.max(1, positives.length);
  return {
    name: `${name}`,
    positives: positives.length,
    hit1: Number((hit1 / total).toFixed(3)),
    hit3: Number((hit3 / total).toFixed(3)),
    hit5: Number((hit5 / total).toFixed(3)),
    mrr: Number((rr / total).toFixed(3)),
    negativeFalsePositive: Number((falsePositive / Math.max(1, negatives.length)).toFixed(3)),
  };
}

const dir = await mkdtemp(join(tmpdir(), 'butler-knowledge-eval-'));
const store = new DocumentStore(join(dir, 'docs'));
for (const d of KNOWLEDGE_DOCUMENTS) await store.ingest(d);

const chunks: Chunk[] = [];
for (const summary of await store.list()) {
  const doc = await store.get(summary.id);
  if (doc === null) continue;
  for (const chunk of doc.chunks) {
    chunks.push({
      id: chunk.id,
      documentId: doc.id,
      name: doc.name,
      chunkIndex: chunk.index,
      text: chunk.text,
    });
  }
}

const embedding = new LocalBgeEmbedding(join(process.cwd(), '.butler-data', 'models'));
const chunkVectors = await embedding.embed(chunks.map((c) => c.text));
const vectorById = new Map<string, readonly number[]>();
for (let i = 0; i < chunks.length; i += 1) {
  const vector = chunkVectors[i];
  if (vector !== undefined) vectorById.set(chunks[i]!.id, vector);
}

const lexicalResults = new Map<string, readonly DocumentHit[]>();
const semanticAll = new Map<string, readonly ScoredHit[]>();

for (const q of KNOWLEDGE_QUERIES) {
  const lexical = await store.search(q.q, 10);
  lexicalResults.set(q.q, lexical);

  const qv = (await embedding.embed([q.q]))[0];
  const semantic: ScoredHit[] = [];
  if (qv !== undefined) {
    for (const chunk of chunks) {
      const v = vectorById.get(chunk.id);
      if (v === undefined) continue;
      const score = cosine(qv, v);
      semantic.push({
        documentId: chunk.documentId,
        name: chunk.name,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        score,
        semanticScore: score,
      });
    }
  }
  semantic.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId));
  semanticAll.set(q.q, semantic);
}

const sweep = SEMANTIC_MINS.map((min) => {
  const semanticResults = new Map<string, readonly ScoredHit[]>();
  const hybridResults = new Map<string, readonly ScoredHit[]>();
  const lexicalFirstResults = new Map<string, readonly ScoredHit[]>();
  for (const q of KNOWLEDGE_QUERIES) {
    const lexical = lexicalResults.get(q.q) ?? [];
    const semantic = (semanticAll.get(q.q) ?? []).filter((h) => (h.semanticScore ?? 0) >= min);
    semanticResults.set(q.q, semantic);

    const fused = new Map<string, ScoredHit>();
    for (let i = 0; i < lexical.length; i += 1) {
      const h = lexical[i]!;
      const key = `${h.documentId}:${h.chunkIndex}`;
      fused.set(key, { ...h, lexicalRank: i + 1 });
    }
    for (let i = 0; i < semantic.length; i += 1) {
      const h = semantic[i]!;
      const key = `${h.documentId}:${h.chunkIndex}`;
      const current = fused.get(key);
      const lexicalRank = current?.lexicalRank;
      const rrf =
        (lexicalRank === undefined ? 0 : 2 / (RRF_K + lexicalRank)) +
        1 / (RRF_K + i + 1);
      fused.set(key, { ...(current ?? h), score: rrf, semanticScore: h.semanticScore });
    }
    hybridResults.set(
      q.q,
      [...fused.values()]
        .sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId))
        .slice(0, 10),
    );

    const lexicalFirst: ScoredHit[] = lexical.map((h) => ({ ...h }));
    const seen = new Set(lexicalFirst.map((h) => `${h.documentId}:${h.chunkIndex}`));
    for (const h of semantic) {
      const key = `${h.documentId}:${h.chunkIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lexicalFirst.push(h);
    }
    lexicalFirstResults.set(q.q, lexicalFirst.slice(0, 10));
  }
  return {
    semanticMin: min,
    results: [
      scoreMode('semantic', KNOWLEDGE_QUERIES, semanticResults),
      scoreMode('hybrid', KNOWLEDGE_QUERIES, hybridResults),
      scoreMode('lexical-first-hybrid', KNOWLEDGE_QUERIES, lexicalFirstResults),
    ],
  };
});

const report = {
  documents: KNOWLEDGE_DOCUMENTS.length,
  chunks: chunks.length,
  queries: KNOWLEDGE_QUERIES.length,
  lexical: scoreMode('lexical', KNOWLEDGE_QUERIES, lexicalResults),
  sweep,
  breakdown: {
    exact: KNOWLEDGE_QUERIES.filter((q) => q.type === 'exact').length,
    paraphrase: KNOWLEDGE_QUERIES.filter((q) => q.type === 'paraphrase').length,
    negative: KNOWLEDGE_QUERIES.filter((q) => q.type === 'negative').length,
  },
};
console.log(JSON.stringify(report, null, 2));
await rm(dir, { recursive: true, force: true });
