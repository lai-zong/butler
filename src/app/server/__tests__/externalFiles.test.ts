/**
 * 外部文件面板后端：类型判断、句柄、读写冲突、会话授权。
 *
 * ⚠️ 全部用临时目录；不碰真实 .butler-data。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyExternalFile,
  clearExternalGrants,
  closeExternalFile,
  externalGrantsFor,
  externalMeta,
  externalText,
  grantExternalPath,
  registerExternalFile,
  revokeExternalPath,
  saveExternalText,
} from '../externalFiles.js';

let base = '';
let file = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'butler-ext-'));
  file = join(base, 'notes.md');
  await writeFile(file, '# hello\n', 'utf8');
});

afterEach(async () => {
  clearExternalGrants('s1');
  await rm(base, { recursive: true, force: true });
});

describe('classifyExternalFile', () => {
  it('区分文本/图片/PDF/Office/未知类型', () => {
    expect(classifyExternalFile('a.md')).toBe('text');
    expect(classifyExternalFile('a.tsx')).toBe('text');
    expect(classifyExternalFile('Dockerfile')).toBe('text');
    expect(classifyExternalFile('a.png')).toBe('image');
    expect(classifyExternalFile('a.pdf')).toBe('pdf');
    expect(classifyExternalFile('a.docx')).toBe('office');
    expect(classifyExternalFile('a.bin')).toBe('unsupported');
  });
});

describe('external file handle', () => {
  it('登记后能读文本、拿到 meta；保存后 etag 变化', async () => {
    const handle = await registerExternalFile(file, 's1');
    expect(handle.kind).toBe('text');
    expect(handle.editable).toBe(true);
    const text = await externalText(handle.id, 's1');
    expect(text.text).toBe('# hello\n');
    const saved = await saveExternalText(handle.id, 's1', '# changed\n', text.etag);
    expect(saved.etag).not.toBe(text.etag);
    expect(await readFile(file, 'utf8')).toBe('# changed\n');
    const meta = await externalMeta(handle.id, 's1');
    expect(meta.size).toBe(Buffer.byteLength('# changed\n'));
  });

  it('etag 不匹配时拒绝保存（409 语义）', async () => {
    const handle = await registerExternalFile(file, 's1');
    const text = await externalText(handle.id, 's1');
    await writeFile(file, '# other\n', 'utf8');
    await expect(saveExternalText(handle.id, 's1', '# mine\n', text.etag)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await readFile(file, 'utf8')).toBe('# other\n');
  });

  it('会话不匹配的句柄拒绝访问', async () => {
    const handle = await registerExternalFile(file, 's1');
    await expect(externalText(handle.id, 's2')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('关闭文件同时撤销授权', async () => {
    const handle = await registerExternalFile(file, 's1');
    grantExternalPath('s1', file);
    expect(externalGrantsFor('s1')).toHaveLength(1);
    await closeExternalFile(handle.id, 's1');
    expect(externalGrantsFor('s1')).toHaveLength(0);
    await expect(externalText(handle.id, 's1')).rejects.toMatchObject({ code: 'bad_handle' });
  });

  it('授权可重复添加且撤销幂等', () => {
    grantExternalPath('s1', file);
    grantExternalPath('s1', file);
    expect(externalGrantsFor('s1')).toHaveLength(1);
    revokeExternalPath('s1', file);
    revokeExternalPath('s1', file);
    expect(externalGrantsFor('s1')).toHaveLength(0);
  });
});

describe('外部路径的 guard 授权', () => {
  it('workspace 档仅对 allowedPaths 放行，未授权仍拒绝', async () => {
    const { sessionPathGuard } = await import('../sessionPathGuard.js');
    const workspace = join(base, 'workspace');
    await mkdir(workspace, { recursive: true });
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'x', 'utf8');

    const denied = await sessionPathGuard({
      workspace,
      permission: 'workspace',
      protectedPaths: [],
    });
    expect(await denied('read_file', { path: outside })).toContain('工作区权限拒绝');

    const granted = await sessionPathGuard({
      workspace,
      permission: 'workspace',
      protectedPaths: [],
      allowedPaths: [outside],
    });
    expect(await granted('read_file', { path: outside })).toBeNull();
    expect(await granted('read_file', { path: join(base, 'other.txt') })).toContain(
      '工作区权限拒绝',
    );
  });

  it('受保护路径即使被授权也拒绝', async () => {
    const { sessionPathGuard } = await import('../sessionPathGuard.js');
    const workspace = join(base, 'workspace');
    const dataDir = join(base, 'data');
    await mkdir(workspace, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const secret = join(dataDir, 'events.jsonl');
    await writeFile(secret, '{}', 'utf8');

    const guard = await sessionPathGuard({
      workspace,
      permission: 'workspace',
      protectedPaths: [dataDir],
      allowedPaths: [secret],
    });
    expect(await guard('read_file', { path: secret })).toContain('受保护路径');
  });
});
