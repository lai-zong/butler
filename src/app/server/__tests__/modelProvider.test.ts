import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isModelProviderId,
  loadSelection,
  providerFromEnv,
  saveSelection,
} from '../modelProvider.js';

const savedEnv = process.env['MODEL_PROVIDER'];

afterEach(() => {
  if (savedEnv === undefined) delete process.env['MODEL_PROVIDER'];
  else process.env['MODEL_PROVIDER'] = savedEnv;
});

describe('模型 provider 选择', () => {
  it('识别合法 provider，拒绝未知值', () => {
    expect(isModelProviderId('deepseek')).toBe(true);
    expect(isModelProviderId('openai')).toBe(true);
    expect(isModelProviderId('ollama')).toBe(true);
    expect(isModelProviderId('unknown')).toBe(false);
  });

  it('环境变量优先于本地文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-model-'));
    try {
      await saveSelection(dir, { provider: 'openai', model: 'test-model' });
      process.env['MODEL_PROVIDER'] = 'ollama';
      const loaded = await loadSelection(dir);
      expect(loaded.selection.provider).toBe('ollama');
      expect(loaded.source).toBe('env');
      expect(loaded.envLocked).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('没有环境变量时读取本地保存的 provider/model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-model-'));
    try {
      delete process.env['MODEL_PROVIDER'];
      await saveSelection(dir, { provider: 'openai', model: 'gpt-test' });
      const loaded = await loadSelection(dir);
      expect(loaded.selection).toEqual({ provider: 'openai', model: 'gpt-test' });
      expect(loaded.source).toBe('file');
      expect(loaded.envLocked).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('配置文件损坏时退回默认 deepseek，不抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-model-'));
    try {
      delete process.env['MODEL_PROVIDER'];
      const loaded = await loadSelection(dir);
      expect(loaded.selection.provider).toBe('deepseek');
      expect(loaded.source).toBe('default');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('非法 MODEL_PROVIDER 不静默当成默认值', () => {
    expect(
      providerFromEnv({ MODEL_PROVIDER: 'nope' } as unknown as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});
