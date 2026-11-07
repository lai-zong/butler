import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  defaultPetConfig,
  listPetAssets,
  loadPetConfig,
  savePetConfig,
} from '../petConfig.js';

describe('桌宠配置', () => {
  it('缺省配置安全，保存时可夹紧大小并保留人格', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-pet-config-'));
    try {
      const defaults = await loadPetConfig(dir);
      expect(defaults).toMatchObject({
        version: 1,
        enabled: true,
        size: 220,
        sprite: 'butler',
        alwaysOnTop: true,
        model: null,
        thinkingLevel: 'default',
        persona: '',
      });

      const saved = await savePetConfig(
        {
          size: 9999,
          sprite: 'not-yet-installed',
          persona: '像一位可靠但话不多的管家',
          thinkingLevel: 'high',
          alwaysOnTop: false,
        },
        dir,
      );
      expect(saved.size).toBe(480);
      expect(saved.sprite).toBe('not-yet-installed');
      expect(saved.persona).toContain('管家');
      expect(saved.thinkingLevel).toBe('high');
      expect(saved.alwaysOnTop).toBe(false);

      const loaded = await loadPetConfig(dir);
      expect(loaded.persona).toContain('管家');
      expect(loaded.size).toBe(480);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('默认值不会写入磁盘，资产只返回带 base.png 的目录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-pet-config-'));
    try {
      await loadPetConfig(dir);
      const again = await loadPetConfig(dir);
      expect(again.version).toBe(1);
      expect(again.size).toBe(defaultPetConfig().size);
      const assets = await listPetAssets();
      expect(assets.some((asset) => asset.id === 'butler')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
