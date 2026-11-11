import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendUsagePing,
  clearUsage,
  loadUsagePings,
  loadUsageSettings,
  saveUsageSettings,
} from '../usageStore.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'butler-usage-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('usage store', () => {
  it('默认开启，保存开关后仍能读回', async () => {
    await expect(loadUsageSettings(dir)).resolves.toEqual({ enabled: true });
    await saveUsageSettings({ enabled: false }, dir);
    await expect(loadUsageSettings(dir)).resolves.toEqual({ enabled: false });
  });

  it('只保存页面、时间与活跃状态，清除不影响其它文件', async () => {
    await appendUsagePing({ at: 1000, page: 'chat', active: true, sessionId: 's1' }, dir);
    await appendUsagePing({ at: 2000, page: 'memory', active: false }, dir);
    const pings = await loadUsagePings(dir);
    expect(pings).toEqual([
      { at: 1000, page: 'chat', active: true, sessionId: 's1' },
      { at: 2000, page: 'memory', active: false },
    ]);

    await clearUsage(dir);
    await expect(loadUsagePings(dir)).resolves.toEqual([]);
  });
});
