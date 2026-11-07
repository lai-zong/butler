import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DocumentStore } from '@/core/documents/store.js';
import {
  DEFAULT_KNOWLEDGE_CONFIG,
  KnowledgeService,
  loadKnowledgeConfig,
  parseKnowledgeConfig,
  saveKnowledgeConfig,
} from '../knowledge.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'butler-knowledge-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('知识库检索配置', () => {
  it('缺省使用混合模式和本地 BGE', () => {
    expect(parseKnowledgeConfig(null)).toEqual(DEFAULT_KNOWLEDGE_CONFIG);
    expect(DEFAULT_KNOWLEDGE_CONFIG.mode).toBe('hybrid');
    expect(DEFAULT_KNOWLEDGE_CONFIG.embedding.kind).toBe('builtin');
  });

  it('拒绝非法模式并保留合法 profile 选择', () => {
    const parsed = parseKnowledgeConfig({
      mode: 'not-a-mode',
      embedding: {
        kind: 'profile',
        profileId: 'p1',
        modelId: 'embed-1',
        label: 'embed-1',
        dimension: 1024,
      },
      rerank: true,
    });
    expect(parsed.mode).toBe('hybrid');
    expect(parsed.rerank).toBe(true);
    expect(parsed.embedding).toMatchObject({
      kind: 'profile',
      profileId: 'p1',
      modelId: 'embed-1',
      dimension: 1024,
    });
  });

  it('保存后能读回；缺少文件时回退默认值', async () => {
    const dir = await tempDir();
    const saved = {
      ...DEFAULT_KNOWLEDGE_CONFIG,
      mode: 'lexical' as const,
      rerank: true,
    };
    await saveKnowledgeConfig(saved, dir);
    expect(await loadKnowledgeConfig(dir)).toEqual(saved);
    expect(await loadKnowledgeConfig(join(dir, 'missing'))).toEqual(DEFAULT_KNOWLEDGE_CONFIG);
  });
});

describe('KnowledgeService 字面模式', () => {
  it('不加载语义模型也能列出文档并检索', async () => {
    const dir = await tempDir();
    const store = new DocumentStore(join(dir, 'documents'));
    await store.ingest({ name: '合同.txt', text: '付款条款：验收后三十天内付款。' });
    await store.ingest({ name: '报告.txt', text: '血脂 LDL 3.8，三个月后复查。' });
    const service = new KnowledgeService(dir, store);

    const status = await service.status();
    expect(status.documents).toBe(2);
    expect(status.chunks).toBe(2);
    expect(status.mode).toBe('hybrid');
    expect(status.rerankModel).toBe('Xenova/bge-reranker-base');
    expect(status.index.ready).toBe(false);

    const result = await service.search('付款三十天', 5);
    expect(result.hits[0]?.name).toBe('合同.txt');
    // 没有预先构建索引时，混合模式会尝试构建；本地模型不存在则回退字面。
    expect(['hybrid', 'lexical']).toContain(result.mode);
    if (result.mode === 'lexical') expect(result.fallbackReason).not.toBeNull();
  });
});
