import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createProfile,
  discoverModels,
  loadProfileStore,
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
});
