import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_VECTOR_INDEX_VERSION,
  cosineSimilarity,
  parseVectorIndex,
  searchVectorIndex,
  type DocumentVectorIndexData,
} from '../vectorIndex.js';

const index: DocumentVectorIndexData = {
  version: DOCUMENT_VECTOR_INDEX_VERSION,
  model: 'demo-model',
  dimension: 3,
  chunkVersion: 'v1:900:120',
  entries: [
    {
      chunkId: 'c1',
      documentId: 'd1',
      name: '报告',
      chunkIndex: 0,
      text: 'LDL 3.8',
      vector: [1, 0, 0],
    },
    {
      chunkId: 'c2',
      documentId: 'd2',
      name: '合同',
      chunkIndex: 1,
      text: '付款三十天',
      vector: [0.8, 0.2, 0],
    },
    {
      chunkId: 'c3',
      documentId: 'd3',
      name: '旅行',
      chunkIndex: 0,
      text: '西湖',
      vector: [0, 1, 0],
    },
  ],
};

describe('文档向量索引', () => {
  it('余弦相似度与排名', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    const hits = searchVectorIndex(index, [1, 0, 0], 0.5, 3);
    expect(hits.map((h) => h.documentId)).toEqual(['d1', 'd2']);
    expect(hits[0]?.semanticScore).toBeCloseTo(1);
  });

  it('阈值过滤和数量限制', () => {
    expect(searchVectorIndex(index, [0, 1, 0], 0.5, 10).map((h) => h.documentId)).toEqual(['d3']);
    expect(searchVectorIndex(index, [1, 0, 0], 0.5, 1)).toHaveLength(1);
    expect(searchVectorIndex(index, [0, 0, 1], 0.5, 10)).toEqual([]);
  });

  it('拒绝维度不一致的持久化索引', () => {
    expect(parseVectorIndex({
      ...index,
      entries: [{ ...index.entries[0]!, vector: [1, 0] }],
    })).toBeNull();
    expect(parseVectorIndex({ ...index, dimension: 0 })).toBeNull();
    expect(parseVectorIndex({ ...index, version: 99 })).toBeNull();
  });

  it('接受合法快照', () => {
    const parsed = parseVectorIndex(index);
    expect(parsed?.entries).toHaveLength(3);
    expect(parsed?.model).toBe('demo-model');
  });
});
