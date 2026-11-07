import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  launchPet,
  petPidPath,
  petRuntimeStatus,
  writePetPidForTest,
} from '../petRuntime.js';

const dirs: string[] = [];
const originalDataDir = process.env['BUTLER_DATA_DIR'];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'butler-pet-runtime-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env['BUTLER_DATA_DIR'];
  else process.env['BUTLER_DATA_DIR'] = originalDataDir;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('桌宠进程状态', () => {
  it('当前 PID 存活时显示运行中', async () => {
    const dir = await tempDir();
    process.env['BUTLER_DATA_DIR'] = dir;
    await writePetPidForTest(process.pid, dir);
    expect(petPidPath()).toBe(join(dir, 'pet.pid'));
    const status = await petRuntimeStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
  });

  it('Web 显示模式拒绝启动桌面进程', async () => {
    const dir = await tempDir();
    process.env['BUTLER_DATA_DIR'] = dir;
    await writeFile(
      join(dir, 'pet-config.json'),
      JSON.stringify({ displayMode: 'web' }),
      'utf8',
    );
    await expect(launchPet()).rejects.toThrow('Web 界面显示');
  });

  it('PID 不存活会清理陈旧文件并允许重新启动', async () => {
    const dir = await tempDir();
    process.env['BUTLER_DATA_DIR'] = dir;
    await writePetPidForTest(999_999_999, dir);
    const status = await petRuntimeStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    // 第二次读取仍是干净的未运行状态。
    expect((await petRuntimeStatus()).running).toBe(false);
  });
});
