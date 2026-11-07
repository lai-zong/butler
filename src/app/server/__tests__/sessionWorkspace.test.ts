/**
 * 会话工作区校验的验收
 *
 * ★ 这里必须用**真实临时目录**：工作区合法性依赖 stat / realpath，
 *   mock 文件系统证明不了“不存在会被拒绝”。
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertSessionWorkspace,
  isPathInside,
  protectedSessionPaths,
} from '../sessionWorkspace.js';

let base = '';
let dataDir = '';
let appRoot = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'butler-session-ws-'));
  dataDir = join(base, 'data');
  appRoot = join(base, 'app');
  await mkdir(dataDir, { recursive: true });
  await mkdir(appRoot, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('assertSessionWorkspace', () => {
  it('合法目录 → 返回 realpath（`..` 也被归一）', async () => {
    const real = join(base, 'work', 'alpha');
    await mkdir(real, { recursive: true });
    const normalized = await assertSessionWorkspace(
      join(base, 'work', 'alpha', '..', 'alpha'),
      { dataDir, appRoot },
    );
    expect(normalized).toBe(await realpath(real));
  });

  it('相对路径 → 拒绝', async () => {
    await expect(
      assertSessionWorkspace('relative\\workspace', { dataDir, appRoot }),
    ).rejects.toThrow(/绝对路径/);
  });

  it('不存在 → 拒绝', async () => {
    const missing = join(base, 'missing');
    await expect(assertSessionWorkspace(missing, { dataDir, appRoot })).rejects.toThrow(
      /不存在/,
    );
  });

  it('是文件而不是目录 → 拒绝（含 .env.local 文件）', async () => {
    const file = join(base, 'not-a-dir.txt');
    await writeFile(file, 'x', 'utf8');
    await expect(assertSessionWorkspace(file, { dataDir, appRoot })).rejects.toThrow(
      /不是目录/,
    );

    const envFile = join(base, '.env.local');
    await writeFile(envFile, 'SECRET=x', 'utf8');
    await expect(assertSessionWorkspace(envFile, { dataDir, appRoot })).rejects.toThrow(
      /不是目录/,
    );
  });

  it('系统数据目录本身或其子目录 → 拒绝', async () => {
    await expect(assertSessionWorkspace(dataDir, { dataDir, appRoot })).rejects.toThrow(
      /受保护|系统数据目录/,
    );
    const child = join(dataDir, 'workspace');
    await mkdir(child, { recursive: true });
    await expect(assertSessionWorkspace(child, { dataDir, appRoot })).rejects.toThrow(
      /受保护|系统数据目录/,
    );
  });

  it('应用根下的默认 .butler-data → 拒绝', async () => {
    const defaultData = join(appRoot, '.butler-data');
    await mkdir(defaultData, { recursive: true });
    await expect(
      assertSessionWorkspace(defaultData, { dataDir, appRoot }),
    ).rejects.toThrow(/受保护|系统数据目录/);
  });

  it('工作区不能是名为 .env.local 的目录', async () => {
    const envDir = join(base, '.env.local');
    await mkdir(envDir, { recursive: true });
    await expect(assertSessionWorkspace(envDir, { dataDir, appRoot })).rejects.toThrow(
      /\.env\.local/,
    );
  });

  it('应用 config 目录 → 拒绝（全局 AGENTS 不能被选作工作区）', async () => {
    const configDir = join(appRoot, 'config');
    await mkdir(configDir, { recursive: true });
    await expect(
      assertSessionWorkspace(configDir, { dataDir, appRoot }),
    ).rejects.toThrow(/受保护|config/);
  });
});

describe('protectedSessionPaths', () => {
  it('始终包含数据目录、应用 .env.local、config 与工作区 .env.local', async () => {
    const workspace = join(base, 'work');
    await mkdir(workspace, { recursive: true });
    const paths = protectedSessionPaths(workspace, { dataDir, appRoot });
    expect(paths).toContain(dataDir);
    expect(paths).toContain(join(appRoot, '.env.local'));
    expect(paths).toContain(join(appRoot, 'config'));
    expect(paths).toContain(join(workspace, '.env.local'));
  });
});

describe('isPathInside', () => {
  it('按路径段判断，相似前缀不误伤', () => {
    const root = join(base, 'data');
    expect(isPathInside(root, join(root, 'a.txt'))).toBe(true);
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, `${root}-backup`)).toBe(false);
    expect(isPathInside(root, join(base, 'other'))).toBe(false);
  });
});
