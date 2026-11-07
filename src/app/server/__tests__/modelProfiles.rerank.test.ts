import { describe, expect, it } from 'vitest';

import { createProfile, updateProfile } from '../modelProfiles.js';

const rerankModel = { id: 'gpt-4o-mini', kind: 'rerank' as const };

describe('重排模型配置', () => {
  it('允许创建 LLM 重排 profile', () => {
    const profile = createProfile({
      name: '测试重排',
      presetId: 'custom-rerank-llm',
      baseUrl: 'https://api.openai.com/v1',
      models: [rerankModel],
    });
    expect(profile.models).toMatchObject([rerankModel]);
    expect(profile.presetId).toBe('custom-rerank-llm');
  });

  it('允许更新重排 profile', () => {
    const profile = createProfile({
      name: '测试重排',
      presetId: 'ollama-rerank-llm',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [rerankModel],
    });
    const updated = updateProfile(profile, {
      name: '测试重排 2',
      baseUrl: 'http://127.0.0.1:11434/v1',
      presetId: 'ollama-rerank-llm',
      models: [rerankModel],
    });
    expect(updated.name).toBe('测试重排 2');
    expect(updated.models).toMatchObject([rerankModel]);
  });
});
