/**
 * 产品级全局 AGENTS 读取
 *
 * 三条纪律：
 *   ① 缺失/损坏 → 空规则 + 原因，绝不抛错阻断对话
 *   ② 记录 SHA-256 与长度（审计）
 *   ③ 只读 config/AGENTS.md，不递归、不找工作区
 */

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_GLOBAL_AGENTS_CHARS,
  globalAgentsPath,
  loadGlobalAgents,
} from '../globalAgents.js';
import * as globalAgentsModule from '../globalAgents.js';

let dir: string | null = null;

async function root(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'butler-agents-'));
  return dir;
}

afterEach(async () => {
  if (dir !== null) {
    await rm(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe('loadGlobalAgents', () => {
  it('文件存在 → 读取正文、SHA-256 与长度', async () => {
    const r = await root();
    await mkdir(join(r, 'config'), { recursive: true });
    const text = '# 规则\n\n不要编造。\n';
    await writeFile(globalAgentsPath(r), text, 'utf8');

    const snap = await loadGlobalAgents(r);
    expect(snap.loaded).toBe(true);
    expect(snap.text).toBe(text);
    expect(snap.length).toBe(text.length);
    expect(snap.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.truncated).toBe(false);
    expect(snap.error).toBeUndefined();
  });

  it('文件缺失 → 空规则 + 原因，不抛错', async () => {
    const r = await root();
    const snap = await loadGlobalAgents(r);
    expect(snap.loaded).toBe(false);
    expect(snap.text).toBe('');
    expect(snap.length).toBe(0);
    expect(snap.hash).toBe('');
    expect(snap.error).toBeDefined();
  });

  it('内容含 NUL → 按损坏处理（空规则）', async () => {
    const r = await root();
    await mkdir(join(r, 'config'), { recursive: true });
    await writeFile(globalAgentsPath(r), 'abc\u0000def', 'utf8');
    const snap = await loadGlobalAgents(r);
    expect(snap.loaded).toBe(false);
    expect(snap.text).toBe('');
    expect(snap.error).toContain('NUL');
  });

  it('超长文件 → 截断并标记，仍可用', async () => {
    const r = await root();
    await mkdir(join(r, 'config'), { recursive: true });
    const text = 'a'.repeat(MAX_GLOBAL_AGENTS_CHARS + 10);
    await writeFile(globalAgentsPath(r), text, 'utf8');
    const snap = await loadGlobalAgents(r);
    expect(snap.loaded).toBe(true);
    expect(snap.truncated).toBe(true);
    expect(snap.text).toHaveLength(MAX_GLOBAL_AGENTS_CHARS);
    expect(snap.length).toBe(text.length);
  });

  it('不递归：config/AGENTS.md 旁边的工作区 AGENTS.md 不会被读', async () => {
    const r = await root();
    await mkdir(join(r, 'config'), { recursive: true });
    await writeFile(globalAgentsPath(r), '只有这一条', 'utf8');
    await writeFile(join(r, 'AGENTS.md'), '工作区规则不应被读', 'utf8');
    const snap = await loadGlobalAgents(r);
    expect(snap.text).toBe('只有这一条');
    expect(snap.text).not.toContain('工作区规则');
  });

  it('★ 读取是只读的：缺失时不会创建文件，也不会改写已有文件', async () => {
    const r = await root();
    // 缺失时加载
    const missing = await loadGlobalAgents(r);
    expect(missing.loaded).toBe(false);
    expect(existsSync(globalAgentsPath(r))).toBe(false);

    // 已有文件时加载，内容不变
    await mkdir(join(r, 'config'), { recursive: true });
    await writeFile(globalAgentsPath(r), '原始内容', 'utf8');
    await loadGlobalAgents(r);
    const after = await loadGlobalAgents(r);
    expect(after.text).toBe('原始内容');
  });

  it('模块不暴露任何写/编辑入口（只有读取与路径）', () => {
    const writeLike = Object.keys(globalAgentsModule).filter((key) =>
      /write|save|update|edit|remove|delete|rename|move/i.test(key),
    );
    expect(writeLike).toEqual([]);
  });
});
