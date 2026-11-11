/**
 * 语义相似度索引 —— 纯计算层，不加载模型。
 *
 * 输入：EmbeddingPort + 可见记忆；输出：memoryId → 余弦相似度。
 * 记忆向量的缓存键包含内容/版本/更新时间，记忆修订后不会复用旧向量。
 */

import type { EmbeddingPort } from '../ports/embedding.js';
import type { MemoryEntry } from './types.js';

export const SEMANTIC_BATCH_SIZE = 16;

function embeddingTextOf(memory: MemoryEntry): string {
  const p = memory.principle;
  return p !== undefined
    ? `${memory.content}\n当：${p.condition}\n则：${p.action}`
    : memory.content;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** 向量缓存上限（条）。按记忆条数算，几千条已足够覆盖日常召回。 */
const SEMANTIC_CACHE_MAX = 4000;

export class SemanticIndex {
  private readonly cache = new Map<string, { readonly key: string; readonly vector: readonly number[] }>();

  constructor(private readonly embedding: EmbeddingPort) {}

  /** 嵌入模型变化或手动重建时清空内存向量缓存。 */
  clear(): void {
    this.cache.clear();
  }

  async scores(
    query: string,
    candidates: readonly MemoryEntry[],
  ): Promise<ReadonlyMap<string, number>> {
    if (query.trim().length === 0 || candidates.length === 0) return new Map();

    const [queryVector] = await this.embedding.embed([query]);
    if (queryVector === undefined) return new Map();

    const vectors = await this.vectorsFor(candidates);
    const result = new Map<string, number>();
    for (const memory of candidates) {
      const vector = vectors.get(memory.id);
      if (vector === undefined) continue;
      /**
       * ★ 维度必须一致。
       *
       *   `cosine` 内部按 `Math.min(a.length,b.length)` 截断，维度不同（换了
       *   嵌入模型，768 → 1024）时会算出一个"看起来正常"的分数（实测 3 维 vs 5 维
       *   得 1.0），检索质量静默下降。宁可这条不给分，也不要用错误的分数。
       */
      if (vector.length !== queryVector.length) continue;
      result.set(memory.id, cosine(queryVector, vector));
    }
    return result;
  }

  /**
   * 全量两两语义相似度。图投影用；没有向量/模型不可用时由调用方降级。
   * 结果只包含成功嵌入的节点。
   */
  async pairwise(
    memories: readonly MemoryEntry[],
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, number>>> {
    const vectors = await this.vectorsFor(memories);
    const result = new Map<string, Map<string, number>>();
    for (const a of memories) {
      const va = vectors.get(a.id);
      if (va === undefined) continue;
      const row = new Map<string, number>();
      for (const b of memories) {
        if (a.id === b.id) continue;
        const vb = vectors.get(b.id);
        if (vb === undefined) continue;
        row.set(b.id, cosine(va, vb));
      }
      result.set(a.id, row);
    }
    return result;
  }

  private async vectorsFor(
    memories: readonly MemoryEntry[],
  ): Promise<Map<string, readonly number[]>> {
    const missing: { readonly id: string; readonly key: string; readonly text: string }[] = [];
    const vectors = new Map<string, readonly number[]>();

    for (const memory of memories) {
      const text = embeddingTextOf(memory);
      const key = `${this.embedding.model}|${memory.id}|${memory.version}|${memory.updatedAt}|${memory.content.length}`;
      const hit = this.cache.get(memory.id);
      if (hit !== undefined && hit.key === key) {
        vectors.set(memory.id, hit.vector);
      } else {
        missing.push({ id: memory.id, key, text });
      }
    }

    for (let i = 0; i < missing.length; i += SEMANTIC_BATCH_SIZE) {
      const batch = missing.slice(i, i + SEMANTIC_BATCH_SIZE);
      const out = await this.embedding.embed(batch.map((m) => m.text));
      for (let j = 0; j < batch.length; j++) {
        const vector = out[j];
        const item = batch[j];
        if (vector === undefined || item === undefined) continue;
        this.cache.set(item.id, { key: item.key, vector });
        vectors.set(item.id, vector);
        /**
         * ★ 缓存必须有上限。
         *
         *   旧实现只增不减（仅换模型时才 clear）：长期运行内存单调增长，
         *   而且遗忘/归档的记忆向量也一直驻留。超出上限按**插入顺序**淘汰最旧的。
         */
        if (this.cache.size > SEMANTIC_CACHE_MAX) {
          const oldest = this.cache.keys().next();
          if (!oldest.done) this.cache.delete(oldest.value);
        }
      }
    }

    return vectors;
  }
}
