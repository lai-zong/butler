/**
 * 受保护路径的测试
 *
 * ★ 这个文件锁的是一条**实测暴露的安全边界**，不是预防性设计。
 *
 *   实测经过（一次真实对话）：
 *     模型调 `read_file {"path":".butler-data/events.jsonl"}`
 *     → 然后说出「系统本次未召回任何用户健康记忆
 *       （memory.recalled count = 0）」
 *     ——它通过读事件文件**推断出了系统内部状态**。
 *
 *   ⚠️ 这同时击穿三条设计：
 *     ① 记忆分权 —— 敏感域隔离与逐次授权失效（直接读原始事件）
 *     ② 审计 —— 读文件不产生 `memory.recalled`，内容却拿到了
 *     ③ 提示隔离 —— 能看到系统写给自己的内部诊断
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../node.js';

let root = '';
let outside = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fs-protect-'));
  outside = await mkdtemp(join(tmpdir(), 'fs-outside-'));

  await writeFile(join(root, '正常文件.txt'), '可以读', 'utf8');
  await writeFile(join(root, '.env.local'), 'DEEPSEEK_API_KEY=sk-secret', 'utf8');

  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, '.butler-data'), { recursive: true });
  await writeFile(join(root, '.butler-data', 'events.jsonl'), '{"记忆":"过敏"}', 'utf8');

  await writeFile(join(outside, '外部文件.txt'), '不该被读到', 'utf8');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function fs(opts?: { protectedPaths?: string[] }) {
  return new NodeFileSystem({
    root,
    protectedPaths: opts?.protectedPaths ?? ['.butler-data', '.env.local'],
  });
}

describe('★ 受保护路径（实测暴露的漏洞）', () => {
  it('★ 读事件文件被拒 —— 那是整个系统的真相源', async () => {
    await expect(fs().readText('.butler-data/events.jsonl')).rejects.toThrow(/受保护/);
  });

  it('★ 读 .env.local 被拒 —— 那里有密钥', async () => {
    await expect(fs().readText('.env.local')).rejects.toThrow(/受保护/);
  });

  it('★ 写事件文件被拒 —— 伪造审计记录必须是死路', async () => {
    await expect(fs().writeText('.butler-data/events.jsonl', 'x')).rejects.toThrow(/受保护/);
  });

  it('★ 列 .butler-data 目录被拒 —— 目录名本身也泄露结构', async () => {
    await expect(fs().listDir('.butler-data')).rejects.toThrow(/受保护/);
  });

  it('★ stat 被拒 —— 文件大小也是信息', async () => {
    await expect(fs().stat('.butler-data/events.jsonl')).rejects.toThrow(/受保护/);
  });

  it('★ mkdir 被拒', async () => {
    await expect(fs().mkdir('.butler-data/sub')).rejects.toThrow(/受保护/);
  });

  it('★ remove 被拒 —— 删掉事件流等于抹除审计', async () => {
    await expect(fs().remove('.butler-data/events.jsonl')).rejects.toThrow(/受保护/);
  });
});

describe('★ 绕过尝试（路径规范化后才判断，字符串匹配挡不住这些）', () => {
  it('★ `./.butler-data/events.jsonl` 被拒', async () => {
    await expect(fs().readText('./.butler-data/events.jsonl')).rejects.toThrow(/受保护/);
  });

  it('★ `x/../.butler-data/events.jsonl` 被拒', async () => {
    await expect(fs().readText('x/../.butler-data/events.jsonl')).rejects.toThrow(/受保护/);
  });

  it('★ 多余分隔符 `././.butler-data//events.jsonl` 被拒', async () => {
    await expect(fs().readText('././.butler-data//events.jsonl')).rejects.toThrow(/受保护/);
  });
});

describe('正常路径不受影响', () => {
  it('工作区内的普通文件可读', async () => {
    await expect(fs().readText('正常文件.txt')).resolves.toBe('可以读');
  });

  it('相似但不同的名字**不**被误伤（前缀匹配要按路径段）', async () => {
    // ⚠️ 若写成 `abs.startsWith(p)` 的纯字符串前缀匹配，
    //    `.butler-data-backup` 会被误判为受保护 —— 那是误伤
    const f = fs({ protectedPaths: ['.butler-data'] });
    await expect(f.readText('.butler-data-backup.txt')).rejects.toThrow();
    // 文件不存在应当报 NOT_FOUND，而不是"受保护"
    await expect(f.readText('.butler-data-backup.txt')).rejects.not.toThrow(/受保护/);
  });

  it('不配受保护路径时行为与之前一致', async () => {
    const f = new NodeFileSystem({ root });
    await expect(f.readText('.butler-data/events.jsonl')).resolves.toContain('记忆');
  });
});
