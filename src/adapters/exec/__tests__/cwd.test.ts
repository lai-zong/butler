/**
 * 命令执行的工作目录边界（2026-11-11 补测）
 *
 * ★ 旧实现是 `!req.cwd.startsWith(this.cwdRoot)`，实测能绕过：
 *   · 兄弟目录：`…\ws-evil` 与 `…\ws` 前缀相同；
 *   · 回溯：`…\ws\..\ws-evil`。
 *   两者都能在"工作区"之外执行命令。
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NodeExec } from '../node.js';

function sandbox(): { readonly base: string; readonly ws: string; readonly sibling: string } {
  const base = mkdtempSync(join(tmpdir(), 'butler-exec-'));
  const ws = join(base, 'ws');
  const sibling = join(base, 'ws-evil');
  mkdirSync(ws, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  return { base, ws, sibling };
}

const request = (cwd: string) => ({
  command: 'node',
  args: ['-e', '0'],
  cwd,
  timeoutMs: 10_000,
});

describe('NodeExec 工作目录边界', () => {
  it('工作区内放行', async () => {
    const { ws } = sandbox();
    const exec = new NodeExec({ cwdRoot: ws });
    await expect(exec.run(request(ws))).resolves.toBeDefined();
  });

  it('同前缀的兄弟目录被拒绝', async () => {
    const { ws, sibling } = sandbox();
    const exec = new NodeExec({ cwdRoot: ws });
    await expect(exec.run(request(sibling))).rejects.toThrow('工作目录必须在');
  });

  it('用 .. 回溯出去被拒绝', async () => {
    const { ws, sibling } = sandbox();
    const exec = new NodeExec({ cwdRoot: ws });
    // 未 resolve 的路径：旧实现用 startsWith 比较，这种写法会直接通过
    const raw = `${ws}\\..\\${sibling.split(/[\\/]/).pop() ?? 'ws-evil'}`;
    expect(raw.startsWith(ws)).toBe(true);
    await expect(exec.run(request(raw))).rejects.toThrow('工作目录必须在');
    await expect(exec.run(request(join(ws, '..', 'ws-evil')))).rejects.toThrow('工作目录必须在');
  });

  it('完全无关的目录被拒绝', async () => {
    const { ws } = sandbox();
    const exec = new NodeExec({ cwdRoot: ws });
    await expect(exec.run(request(tmpdir() === ws ? '/tmp' : tmpdir()))).rejects.toThrow(
      '工作目录必须在',
    );
  });
});
