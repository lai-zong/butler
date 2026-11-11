/**
 * 命令输出与 stdin（2026-11-11 加固）
 *
 * 两条都是实测复现的：
 *   · 12 万个汉字里出现 6 个 U+FFFD（chunk 边界切断了 3 字节字符）；
 *   · 不传 stdin 时，读 stdin 的命令一直挂到超时（timedOut=true）。
 */

import { describe, expect, it } from 'vitest';

import { NodeExec } from '../node.js';

const exec = new NodeExec();

describe('多字节输出不被截断', () => {
  it('12 万汉字没有替换字符', async () => {
    const r = await exec.run({
      command: process.execPath,
      args: ['-e', "process.stdout.write('中'.repeat(120000))"],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxOutputBytes: 8_000_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.stdout.includes('\uFFFD')).toBe(false);
    expect(r.stdout.length).toBe(120000);
  });
});

describe('stdin 必须无条件关闭', () => {
  it('不传 stdin 时，读 stdin 到 EOF 的命令能正常结束', async () => {
    const r = await exec.run({
      command: process.execPath,
      args: [
        '-e',
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write('EOF')})",
      ],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe('EOF');
  });

  it('传了 stdin 的内容会被读到', async () => {
    const r = await exec.run({
      command: process.execPath,
      args: ['-e', "process.stdin.on('data',c=>process.stdout.write(c))"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      stdin: '你好',
    });
    expect(r.stdout).toBe('你好');
  });
});
