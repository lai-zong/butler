import { describe, expect, it } from 'vitest';

import { localModelViews } from '../localModels.js';

describe('本地模型目录', () => {
  it('把 BGE 嵌入和本地重排作为可展示的模型条目', () => {
    const models = localModelViews();
    const embedding = models.find((model) => model.kind === 'embedding');
    const rerank = models.find((model) => model.kind === 'rerank');
    expect(embedding).toMatchObject({
      id: 'local-bge-embedding',
      source: 'local',
      dimension: 768,
    });
    expect(rerank).toMatchObject({
      id: 'local-bge-reranker',
      source: 'local',
      dimension: null,
    });
    expect(embedding?.label).toContain('bge-base-zh');
    expect(rerank?.label).toContain('bge-reranker');
  });
});
