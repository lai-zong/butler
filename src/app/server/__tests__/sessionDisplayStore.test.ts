import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadSessionDisplays,
  patchSessionDisplay,
  readSessionDisplay,
  sessionDisplayPath,
} from '../sessionDisplayStore.js';

describe('会话展示元数据 sidecar', () => {
  it('标题与置顶可分别写入，不互相覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-session-display-'));
    try {
      await patchSessionDisplay(dir, 's1', {
        title: '整理冰箱食材',
        titleGeneratedAt: 10,
      });
      await patchSessionDisplay(dir, 's1', {
        pinnedAt: 20,
        pinnedWorkspace: 'C:\\workplace',
      });

      const display = await readSessionDisplay(dir, 's1');
      expect(display).toMatchObject({
        title: '整理冰箱食材',
        titleGeneratedAt: 10,
        pinnedAt: 20,
        pinnedWorkspace: 'C:\\workplace',
      });
      expect((await loadSessionDisplays(dir)).get('s1')?.title).toBe('整理冰箱食材');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('文件损坏时按空数据处理', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-session-display-'));
    try {
      await writeFile(sessionDisplayPath(dir), '{broken', 'utf8');
      expect(await readSessionDisplay(dir, 'missing')).toEqual({});
      expect((await loadSessionDisplays(dir)).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('取消置顶会清空作用域', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-session-display-'));
    try {
      await patchSessionDisplay(dir, 's1', { pinnedAt: 1, pinnedWorkspace: 'C:\\a' });
      await patchSessionDisplay(dir, 's1', { pinnedAt: null, pinnedWorkspace: null });
      expect(await readSessionDisplay(dir, 's1')).toMatchObject({
        pinnedAt: null,
        pinnedWorkspace: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
