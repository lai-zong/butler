/**
 * 审查沙箱里的命令执行（2026-11-11）
 *
 * ★ 修复前的事实：
 *   审查提示词明确教模型「用 run_command 在临时副本里跑测试」，
 *   而 `sessionPathGuard` 对 `run_command` **无条件拒绝** ——
 *   每次审查都先撞一次墙、白烧一轮 token，"在临时副本跑测试"承诺不成立。
 *
 * ★ 修复后仍然不是"放开命令执行"：
 *   · 只有给了 `commandRoot`（仅审查作用域）才可能放行；
 *   · cwd 必须在沙箱根内（字面 + 真实路径）；
 *   · 可执行文件必须白名单。
 */

import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sessionPathGuard } from '../sessionPathGuard.js';

async function guard(commandRoot?: string) {
  const workspace = mkdtempSync(join(tmpdir(), 'butler-guard-ws-'));
  mkdirSync(join(workspace, 'sub'), { recursive: true });
  return sessionPathGuard({
    workspace,
    permission: 'read-only',
    protectedPaths: [],
    ...(commandRoot !== undefined ? { commandRoot } : {}),
  });
}

describe('run_command：没有沙箱根时一律拒绝', () => {
  it('主对话（无 commandRoot）拒绝任何命令', async () => {
    const g = await guard();
    expect(await g('run_command', { command: 'npm', args: ['test'] })).toContain('不提供命令执行工具');
  });
});

describe('run_command：审查沙箱内可用，但受白名单与 cwd 约束', () => {
  it('沙箱内执行白名单命令放行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-guard-sandbox-'));
    mkdirSync(join(root, 'sub'), { recursive: true });
    const g = await guard(root);

    expect(await g('run_command', { command: 'npm', args: ['test'] })).toBeNull();
    expect(await g('run_command', { command: 'node', args: ['-v'], cwd: root })).toBeNull();
    expect(await g('run_command', { command: 'pnpm', args: ['run', 'build'], cwd: join(root, 'sub') })).toBeNull();
  });

  it('不在白名单的可执行文件被拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-guard-sandbox-'));
    const g = await guard(root);
    expect(await g('run_command', { command: 'cmd.exe', args: ['/c', 'dir'] })).toContain('不允许执行');
    expect(await g('run_command', { command: 'powershell', args: ['-c', 'x'] })).toContain('不允许执行');
    expect(await g('run_command', { command: 'curl', args: ['http://x'] })).toContain('不允许执行');
  });

  it('cwd 越出沙箱根被拒绝（字面与 .. 回溯）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-guard-sandbox-'));
    const g = await guard(root);
    expect(await g('run_command', { command: 'npm', cwd: tmpdir() })).toContain('只允许在临时副本');
    expect(await g('run_command', { command: 'npm', cwd: join(root, '..') })).toContain('只允许在临时副本');
    expect(await g('run_command', { command: 'npm', cwd: '..\\..' })).toContain('只允许在临时副本');
  });

  it('沙箱里的符号链接不能把 cwd 带出去', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-guard-sandbox-'));
    const outside = mkdtempSync(join(tmpdir(), 'butler-guard-outside-'));
    const link = join(root, 'escape');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // 权限不足时跳过这条（CI 容器里可能无法建链接）
      return;
    }
    const g = await guard(root);
    expect(await g('run_command', { command: 'npm', cwd: link })).toContain('只允许在临时副本');
  });

  it('只读档位下的文件写入仍然被拒绝（命令白名单不放宽文件权限）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-guard-sandbox-'));
    const g = await guard(root);
    expect(await g('write_file', { path: join(root, 'x.txt') })).toContain('只读权限拒绝');
  });
});
