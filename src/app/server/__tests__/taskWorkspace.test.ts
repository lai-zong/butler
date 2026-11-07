import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertWorkspaceDirectory, workspacePathGuard } from '../taskWorkspace.js';

describe('用户任务工作区', () => {
  it('工作区内的写路径放行，越界路径拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'butler-task-workspace-'));
    try {
      await mkdir(join(root, 'reports'), { recursive: true });
      const guard = workspacePathGuard(root);
      expect(guard('write_file', { path: 'reports/a.md' })).toBeNull();
      expect(guard('write_file', { path: 'C:\\Windows\\x.txt' })).toContain('工作区权限拒绝');
      expect(guard('move_path', { from: 'reports/a.md', to: '..\\outside.md' })).toContain('工作区权限拒绝');
      expect(guard('read_file', { path: 'C:\\Windows\\x.txt' })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('不存在或不是目录的工作区会被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'butler-task-workspace-'));
    try {
      await mkdir(join(root, 'real'));
      await expect(assertWorkspaceDirectory(join(root, 'missing'))).rejects.toThrow('不存在');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
