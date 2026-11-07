import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createProfile,
  discoverModels,
  loadProfileStore,
  resolveProfileModel,
  saveProfileStore,
  updateProfile,
  type ModelProfileStore,
} from '../modelProfiles.js';

let dir: string | null = null;

afterEach(async () => {
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

async function tempDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'butler-model-profiles-'));
  return dir;
}

describe('model profiles', () => {
  it('保存配置与当前模型，不在 JSON 中保存 Key', async () => {
    const d = await tempDir();
    const profile = createProfile({
      name: 'OpenRouter 工作',
      presetId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ id: 'anthropic/claude-sonnet-4', capabilities: { tools: true, vision: true } }],
    });
    const store: ModelProfileStore = {
      version: 1,
      profiles: [profile],
      active: { profileId: profile.id, modelId: 'anthropic/claude-sonnet-4' },
      lastChat: { profileId: profile.id, modelId: 'anthropic/claude-sonnet-4' },
      lastReview: null,
      embedding: { kind: 'builtin', label: 'bge-base-zh-v1.5', dimension: 768 },
    };
    await saveProfileStore(d, store);

    const loaded = await loadProfileStore(d);
    expect(loaded.profiles).toHaveLength(1);
    expect(loaded.profiles[0]?.name).toBe('OpenRouter 工作');
    expect(loaded.active).toEqual({
      profileId: profile.id,
      modelId: 'anthropic/claude-sonnet-4',
    });
    expect(loaded.profiles[0]?.models[0]?.capabilities.vision).toBe(true);

    const raw = await readFile(join(d, 'model-profiles.json'), 'utf8');
    expect(raw).not.toContain('sk-');
    expect(raw).not.toContain('apiKey');
  });

  it('区分对话/嵌入模型并保存嵌入维度', async () => {
    const d = await tempDir();
    const profile = createProfile({
      name: 'OpenAI 双用途',
      presetId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-4.1-mini', kind: 'chat', capabilities: { tools: true } },
        { id: 'text-embedding-3-large', kind: 'embedding', dimension: 3072 },
      ],
    });
    await saveProfileStore(d, {
      version: 1,
      profiles: [profile],
      active: { profileId: profile.id, modelId: 'gpt-4.1-mini' },
      lastChat: { profileId: profile.id, modelId: 'gpt-4.1-mini' },
      lastReview: null,
      embedding: { kind: 'builtin', label: 'bge-base-zh-v1.5', dimension: 768 },
    });
    const loaded = await loadProfileStore(d);
    expect(loaded.profiles[0]?.models.map((m) => m.kind)).toEqual(['chat', 'embedding']);
    expect(loaded.profiles[0]?.models[1]?.dimension).toBe(3072);
    expect(loaded.embedding).toEqual({ kind: 'builtin', label: 'bge-base-zh-v1.5', dimension: 768 });
  });

  it('旧数据把嵌入模型当作当前模型时回退到对话模型', async () => {
    const d = await tempDir();
    const profile = createProfile({
      name: '混合配置',
      presetId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-4.1-mini', kind: 'chat' },
        { id: 'text-embedding-3-large', kind: 'embedding', dimension: 3072 },
      ],
    });
    await saveProfileStore(d, {
      version: 1,
      profiles: [profile],
      active: { profileId: profile.id, modelId: 'text-embedding-3-large' },
      lastChat: { profileId: profile.id, modelId: 'text-embedding-3-large' },
      lastReview: { profileId: profile.id, modelId: 'text-embedding-3-large' },
      embedding: { kind: 'builtin', label: 'bge-base-zh-v1.5', dimension: 768 },
    });
    const loaded = await loadProfileStore(d);
    expect(loaded.active).toEqual({ profileId: profile.id, modelId: 'gpt-4.1-mini' });
    expect(loaded.lastChat).toEqual({ profileId: profile.id, modelId: 'gpt-4.1-mini' });
    expect(loaded.lastReview).toBeNull();
  });

  it('可以修改名称与模型列表，但不会产生默认模型字段', () => {
    const profile = createProfile({
      name: '旧名称',
      presetId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-4o-mini' }],
    });
    const next = updateProfile(profile, {
      name: '新名称',
      presetId: 'openai',
      baseUrl: 'https://gateway.example.com/v1',
      models: [{ id: 'gpt-4.1-mini', capabilities: { tools: true } }],
    });
    expect(next.name).toBe('新名称');
    expect(next.baseUrl).toBe('https://gateway.example.com/v1');
    expect(next.models[0]?.id).toBe('gpt-4.1-mini');
    expect('defaultModel' in next).toBe(false);
  });

  it('从 OpenAI-compatible /models 读取模型并过滤明显非对话模型', async () => {
    let authorization = '';
    const server = createServer((req, res) => {
      authorization = String(req.headers.authorization ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        data: [
          { id: 'chat-model' },
          { id: 'embedding-model' },
          { id: 'rerank-model' },
          { id: 'chat-model' },
        ],
      }));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const models = await discoverModels({
        presetId: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test-key',
      });
      expect(models).toEqual(['chat-model']);
      expect(authorization).toBe('Bearer test-key');
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it('允许创建 LLM 重排配置', () => {
    const profile = createProfile({
      name: '重排测试',
      presetId: 'custom-rerank-llm',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'rerank-test', kind: 'rerank' }],
    });
    expect(profile.models).toMatchObject([{ id: 'rerank-test', kind: 'rerank' }]);
    expect(profile.presetId).toBe('custom-rerank-llm');
  });

  it('嵌入类型发现模型时不过滤 embedding', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        data: [{ id: 'text-embedding-3-large' }, { id: 'chat-model' }],
      }));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const models = await discoverModels({
        presetId: 'openai-embedding',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test-key',
      });
      expect(models).toContain('text-embedding-3-large');
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it('按 profileId/modelId 解析对话模型并拒绝非对话类型', async () => {
    const d = await tempDir();
    const profile = createProfile({
      name: 'DeepSeek 测试',
      presetId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      models: [
        { id: 'deepseek-flash', kind: 'chat' },
        { id: 'embed-test', kind: 'embedding', dimension: 768 },
      ],
    });
    const testProfile = {
      ...profile,
      credential: { kind: 'env' as const, name: 'DEEPSEEK_API_KEY' },
    };
    await saveProfileStore(d, {
      version: 1,
      profiles: [testProfile],
      active: { profileId: profile.id, modelId: 'deepseek-flash' },
      lastChat: { profileId: profile.id, modelId: 'deepseek-flash' },
      lastReview: null,
      embedding: { kind: 'builtin', label: 'bge-base-zh-v1.5', dimension: 768 },
    });
    const previous = process.env['DEEPSEEK_API_KEY'];
    process.env['DEEPSEEK_API_KEY'] = 'test-key';
    try {
      const resolved = await resolveProfileModel(d, profile.id, 'deepseek-flash', 'chat');
      expect(resolved?.config.model).toBe('deepseek-flash');
      expect(resolved?.config.apiKey).toBe('test-key');
      expect(await resolveProfileModel(d, profile.id, 'embed-test', 'chat')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env['DEEPSEEK_API_KEY'];
      else process.env['DEEPSEEK_API_KEY'] = previous;
    }
  });
});
