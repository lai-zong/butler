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

  /**
   * ★ 补漏回归（2026-11-11）。
   *
   *   旧字段表只列了 write_file / make_dir / move_path / remove_path /
   *   desktop_office_convert，漏掉的三个工具都能把文件写到工作区外，
   *   而它们在工作区权限下**本来就被允许执行**（normal 档）：
   *     · apply_patch  → 改任意文本文件
   *     · file_op      → mkdir / move / remove
   *     · desktop_act  → convert_office 带 source / target
   */
  it('apply_patch / file_op / desktop_act 越界同样拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'butler-task-workspace-'));
    try {
      const guard = workspacePathGuard(root);
      const outside = 'C:\\Users\\someone\\.ssh\\authorized_keys';

      expect(guard('apply_patch', { path: outside, oldText: 'a', newText: 'b' })).toContain('工作区权限拒绝');
      expect(guard('file_op', { action: 'mkdir', path: outside })).toContain('工作区权限拒绝');
      expect(guard('file_op', { action: 'move', from: 'in.txt', to: outside })).toContain('工作区权限拒绝');
      expect(guard('file_op', { action: 'remove', path: outside })).toContain('工作区权限拒绝');
      expect(guard('desktop_act', { action: 'convert_office', source: 'in.docx', target: outside })).toContain('工作区权限拒绝');

      // 工作区内的同类调用仍然放行
      expect(guard('apply_patch', { path: 'a.txt', oldText: 'a', newText: 'b' })).toBeNull();
      expect(guard('file_op', { action: 'mkdir', path: 'sub' })).toBeNull();
      expect(guard('desktop_act', { action: 'convert_office', source: 'a.docx', target: 'a.pdf' })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('desktop_act 的非文件动作不被当成路径检查', async () => {
    const root = await mkdtemp(join(tmpdir(), 'butler-task-workspace-'));
    try {
      const guard = workspacePathGuard(root);
      // set_value / invoke 没有 source/target，不该因为缺少路径字段被拒
      expect(guard('desktop_act', { action: 'set_value', window: '记事本', value: '你好' })).toBeNull();
      expect(guard('desktop_act', { action: 'invoke', window: '记事本', name: '保存' })).toBeNull();
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
