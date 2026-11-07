import { describe, expect, it } from 'vitest';

import { lexicalFirstHybrid, semanticOnly } from '../retrieval.js';
import type { DocumentHit } from '../store.js';
import type { SemanticDocumentHit } from '../vectorIndex.js';

const lexical: readonly DocumentHit[] = [
  { documentId: 'doc_a', name: '合同', chunkIndex: 0, text: '付款三十天', score: 3 },
  { documentId: 'doc_b', name: '手册', chunkIndex: 1, text: '迁移脚本', score: 2 },
];

const semantic: readonly SemanticDocumentHit[] = [
  { documentId: 'doc_c', name: '报告', chunkIndex: 0, text: 'LDL 3.8', score: 0.8, semanticScore: 0.8 },
  { documentId: 'doc_a', name: '合同', chunkIndex: 0, text: '付款三十天', score: 0.7, semanticScore: 0.7 },
  { documentId: 'doc_d', name: '流程', chunkIndex: 2, text: '上线前评审', score: 0.6, semanticScore: 0.6 },
];

describe('知识库检索融合', () => {
  it('字面优先：保留字面顺序，并用语义补足，避免重复', () => {
    const hits = lexicalFirstHybrid(lexical, semantic, 4);
    expect(hits.map((h) => `${h.documentId}:${h.chunkIndex}`)).toEqual([
      'doc_a:0',
      'doc_b:1',
      'doc_c:0',
      'doc_d:2',
    ]);
    expect(hits[0]?.retrieval).toBe('both');
    expect(hits[2]?.retrieval).toBe('semantic');
  });

  it('字面为空时，语义结果自然成为主结果', () => {
    const hits = lexicalFirstHybrid([], semantic, 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.documentId).toBe('doc_c');
    expect(hits[0]?.retrieval).toBe('semantic');
  });

  it('纯语义只按语义分数排序，不混入字面结果', () => {
    const hits = semanticOnly(semantic, 2);
    expect(hits.map((h) => h.documentId)).toEqual(['doc_c', 'doc_a']);
    expect(hits.every((h) => h.retrieval === 'semantic')).toBe(true);
  });

  it('限制返回数量', () => {
    expect(lexicalFirstHybrid(lexical, semantic, 1)).toHaveLength(1);
    expect(lexicalFirstHybrid(lexical, semantic, 1)[0]?.documentId).toBe('doc_a');
  });
});
