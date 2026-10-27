import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { loadModelRoles, saveModelRoles } from '../modelRoles.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('model roles', () => {
  it('记忆 / 重排角色独立持久化，缺省为空而不是回退 chat', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'butler-roles-'));
    dirs.push(dir);

    const empty = await loadModelRoles(dir);
    expect(empty.memory).toBeNull();
    expect(empty.rerank).toBeNull();

    await saveModelRoles(dir, {
      version: 1,
      memory: { profileId: 'p1', modelId: 'm1' },
      rerank: { profileId: 'p2', modelId: 'r1' },
    });
    const loaded = await loadModelRoles(dir);
    expect(loaded.memory).toEqual({ profileId: 'p1', modelId: 'm1' });
    expect(loaded.rerank).toEqual({ profileId: 'p2', modelId: 'r1' });
  });
});
