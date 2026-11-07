/**
 * 文档向量索引 —— 纯计算与序列化结构。
 *
 * 与记忆的 SemanticIndex 分开：
 *   · 这里按 documentId + chunkIndex 建索引；
 *   · 持久化时带模型、维度和分片版本，避免混用旧向量；
 *   · 不依赖模型加载，具体嵌入由 app 层注入。
 */

import type { DocumentHit } from './store.js';

export const DOCUMENT_VECTOR_INDEX_VERSION = 1;

export interface DocumentVectorEntry {
  readonly chunkId: string;
  readonly documentId: string;
  readonly name: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly vector: readonly number[];
}

export interface DocumentVectorIndexData {
  readonly version: typeof DOCUMENT_VECTOR_INDEX_VERSION;
  readonly model: string;
  readonly dimension: number;
  readonly chunkVersion: string;
  readonly entries: readonly DocumentVectorEntry[];
}

export interface SemanticDocumentHit extends DocumentHit {
  readonly semanticScore: number;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
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

export function parseVectorIndex(raw: unknown): DocumentVectorIndexData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value['version'] !== DOCUMENT_VECTOR_INDEX_VERSION) return null;
  if (typeof value['model'] !== 'string' || value['model'].trim().length === 0) return null;
  if (typeof value['dimension'] !== 'number' || !Number.isInteger(value['dimension']) || value['dimension'] <= 0) {
    return null;
  }
  if (typeof value['chunkVersion'] !== 'string') return null;
  if (!Array.isArray(value['entries'])) return null;
  const entries: DocumentVectorEntry[] = [];
  for (const item of value['entries']) {
    if (typeof item !== 'object' || item === null) return null;
    const e = item as Record<string, unknown>;
    if (
      typeof e['chunkId'] !== 'string' ||
      typeof e['documentId'] !== 'string' ||
      typeof e['name'] !== 'string' ||
      typeof e['chunkIndex'] !== 'number' ||
      typeof e['text'] !== 'string' ||
      !Array.isArray(e['vector'])
    ) {
      return null;
    }
    const vector = e['vector'].map((x) => (typeof x === 'number' ? x : Number.NaN));
    if (vector.some((x) => !Number.isFinite(x)) || vector.length !== value['dimension']) return null;
    entries.push({
      chunkId: e['chunkId'],
      documentId: e['documentId'],
      name: e['name'],
      chunkIndex: e['chunkIndex'],
      text: e['text'],
      vector,
    });
  }
  return {
    version: DOCUMENT_VECTOR_INDEX_VERSION,
    model: value['model'],
    dimension: value['dimension'],
    chunkVersion: value['chunkVersion'],
    entries,
  };
}

export function searchVectorIndex(
  index: DocumentVectorIndexData,
  queryVector: readonly number[],
  minScore: number,
  limit: number,
): readonly SemanticDocumentHit[] {
  if (queryVector.length !== index.dimension || index.entries.length === 0) return [];
  const hits: SemanticDocumentHit[] = [];
  for (const entry of index.entries) {
    const score = cosineSimilarity(queryVector, entry.vector);
    if (score < minScore) continue;
    hits.push({
      documentId: entry.documentId,
      name: entry.name,
      chunkIndex: entry.chunkIndex,
      text: entry.text,
      score,
      semanticScore: score,
    });
  }
  hits.sort((a, b) => b.semanticScore - a.semanticScore || a.documentId.localeCompare(b.documentId));
  return hits.slice(0, Math.max(1, limit));
}
