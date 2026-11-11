import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadPermissionMode,
  loadPermissionSettings,
  savePermissionMode,
  savePermissionSettings,
} from '../permissionStore.js';

const dirs: string[] = [];
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'butler-perm-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('C5 权限模式持久化', () => {
  it('保存后可以重新加载', async () => {
    const d = await dir();
    await savePermissionMode(d, 'workspace');
    expect(await loadPermissionMode(d)).toBe('workspace');
  });

  it('缺文件/坏 JSON/非法值都返回 undefined', async () => {
    const d = await dir();
    expect(await loadPermissionMode(d)).toBeUndefined();
    await writeFile(join(d, 'settings.json'), '{bad', 'utf8');
    expect(await loadPermissionMode(d)).toBeUndefined();
    await writeFile(join(d, 'settings.json'), JSON.stringify({ permissionMode: 'nope' }), 'utf8');
    expect(await loadPermissionMode(d)).toBeUndefined();
  });

  it('确认开关独立持久化；旧文件缺字段时默认开启', async () => {
    const d = await dir();
    expect((await loadPermissionSettings(d)).confirmActions).toBe(true);

    await savePermissionSettings(d, { mode: 'full', confirmActions: false });
    expect(await loadPermissionSettings(d)).toEqual({
      mode: 'full',
      confirmActions: false,
    });

    await savePermissionMode(d, 'workspace');
    expect(await loadPermissionSettings(d)).toEqual({
      mode: 'workspace',
      confirmActions: false,
    });

    await writeFile(join(d, 'settings.json'), JSON.stringify({ permissionMode: 'full' }), 'utf8');
    expect((await loadPermissionSettings(d)).confirmActions).toBe(true);
  });
});
