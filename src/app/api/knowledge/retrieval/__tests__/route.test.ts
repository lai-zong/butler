import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  config: {
    version: 1,
    mode: 'hybrid',
    embedding: { kind: 'builtin', label: 'bge-base-zh-v1.5', dimension: 768 },
    rerank: false,
  },
  load: vi.fn(),
  save: vi.fn(),
  status: vi.fn(),
  choices: vi.fn(),
  setConfig: vi.fn(),
  rebuild: vi.fn(),
}));

vi.mock('@/app/server/knowledge.js', () => ({
  DEFAULT_KNOWLEDGE_CONFIG: mocks.config,
  loadKnowledgeConfig: mocks.load,
  saveKnowledgeConfig: mocks.save,
  getKnowledgeService: () => ({
    status: mocks.status,
    embeddingChoices: mocks.choices,
    setConfig: mocks.setConfig,
    rebuild: mocks.rebuild,
  }),
}));

import { GET, POST } from '../route.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(mocks.config);
  mocks.status.mockResolvedValue({
    mode: 'hybrid',
    embedding: mocks.config.embedding,
    rerank: false,
    rerankAvailable: true,
    semanticMin: 0.5,
    documents: 0,
    chunks: 0,
    index: {
      ready: false,
      model: null,
      dimension: null,
      indexedChunks: 0,
      staleReason: null,
      rebuiltAt: null,
    },
  });
  mocks.choices.mockResolvedValue([{ kind: 'builtin', label: 'bge', dimension: 768 }]);
  mocks.rebuild.mockResolvedValue({
    mode: 'hybrid',
    embedding: mocks.config.embedding,
    rerank: false,
    rerankAvailable: true,
    semanticMin: 0.5,
    documents: 0,
    chunks: 0,
    index: {
      ready: true,
      model: 'bge',
      dimension: 768,
      indexedChunks: 0,
      staleReason: null,
      rebuiltAt: 1,
    },
  });
});

describe('/api/knowledge/retrieval', () => {
  it('GET 返回配置、状态和嵌入选项', async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['config']).toMatchObject({ mode: 'hybrid' });
    expect(body['choices']).toHaveLength(1);
    expect((body['status'] as Record<string, unknown>)['rerankAvailable']).toBe(true);
  });

  it('set-mode 校验并保存合法模式', async () => {
    const r = await POST(new NextRequest('http://localhost/api/knowledge/retrieval', {
      method: 'POST',
      body: JSON.stringify({ action: 'set-mode', mode: 'lexical' }),
    }));
    expect(r.status).toBe(200);
    expect(mocks.setConfig).toHaveBeenCalledWith({ ...mocks.config, mode: 'lexical' });
  });

  it('拒绝非法模式', async () => {
    const r = await POST(new NextRequest('http://localhost/api/knowledge/retrieval', {
      method: 'POST',
      body: JSON.stringify({ action: 'set-mode', mode: 'bad' }),
    }));
    expect(r.status).toBe(400);
    expect(mocks.setConfig).not.toHaveBeenCalled();
  });

  it('rebuild 返回新状态', async () => {
    const r = await POST(new NextRequest('http://localhost/api/knowledge/retrieval', {
      method: 'POST',
      body: JSON.stringify({ action: 'rebuild' }),
    }));
    expect(r.status).toBe(200);
    expect(mocks.rebuild).toHaveBeenCalled();
    expect(await r.text()).toContain('indexedChunks');
  });
});
