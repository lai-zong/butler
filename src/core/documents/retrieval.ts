/**
 * 知识库检索融合。
 *
 * 数据结论（2026-10-31，65 条查询）：
 *   · 纯语义：hit@1 / hit@5 有提升，但负例误召回偏高；
 *   · 标准 RRF：hit@5 好，但会打乱字面排序，hit@1 下降；
 *   · 字面优先混合：保留字面结果，再用语义补足，hit@1 与 hit@5 都更稳。
 *
 * 所以产品默认采用 lexical-first，而不是用一个未经验证的“纯语义”替换字面。
 */

import type { DocumentHit } from './store.js';
import type { SemanticDocumentHit } from './vectorIndex.js';

export type KnowledgeRetrievalMode = 'lexical' | 'semantic' | 'hybrid';

export type KnowledgeHitSource = 'lexical' | 'semantic' | 'both';

export interface KnowledgeHit extends DocumentHit {
  readonly retrieval: KnowledgeHitSource;
  readonly semanticScore?: number;
  readonly rerankScore?: number;
}

function keyOf(hit: DocumentHit): string {
  return `${hit.documentId}:${hit.chunkIndex}`;
}

export function semanticOnly(
  semantic: readonly SemanticDocumentHit[],
  limit: number,
): readonly KnowledgeHit[] {
  return semantic.slice(0, Math.max(1, limit)).map((hit) => ({
    documentId: hit.documentId,
    name: hit.name,
    chunkIndex: hit.chunkIndex,
    text: hit.text,
    score: hit.semanticScore,
    semanticScore: hit.semanticScore,
    retrieval: 'semantic',
  }));
}

/**
 * 字面优先的混合：
 *   1. 先保留字面命中顺序；
 *   2. 再把语义命中补到后面；
 *   3. 同一 chunk 去重；
 *   4. 字面没有命中时，语义结果自然成为主结果。
 *
 * 这不是“语义必须排在字面之前”，而是对两类查询都保留退路：
 *   · 精确查询（条款号、数字）不会因语义分数被挤下去；
 *   · 改写查询在字面没有命中时由语义补足。
 */
export function lexicalFirstHybrid(
  lexical: readonly DocumentHit[],
  semantic: readonly SemanticDocumentHit[],
  limit: number,
): readonly KnowledgeHit[] {
  const max = Math.max(1, limit);
  const out: KnowledgeHit[] = [];
  const seen = new Set<string>();

  for (const hit of lexical) {
    const key = keyOf(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    const semanticHit = semantic.find((x) => keyOf(x) === key);
    out.push({
      documentId: hit.documentId,
      name: hit.name,
      chunkIndex: hit.chunkIndex,
      text: hit.text,
      score: hit.score,
      retrieval: semanticHit === undefined ? 'lexical' : 'both',
      ...(semanticHit === undefined ? {} : { semanticScore: semanticHit.semanticScore }),
    });
    if (out.length >= max) return out;
  }

  for (const hit of semantic) {
    const key = keyOf(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      documentId: hit.documentId,
      name: hit.name,
      chunkIndex: hit.chunkIndex,
      text: hit.text,
      score: hit.semanticScore,
      semanticScore: hit.semanticScore,
      retrieval: 'semantic',
    });
    if (out.length >= max) break;
  }
  return out;
}
