/**
 * 文件回收站
 *
 * ① 删除 → 移入回收站（不是物理删除），元数据记原路径；
 * ② 恢复 → 放回原路径；③ 彻底删除 → 真删。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../node.js';
import { TrashStore } from '../../storage/trashStore.js';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'butler-trash-'));
  const root = join(base, 'workspace');
  mkdirSync(root, { recursive: true });
  const trashDir = join(base, 'trash');
  const fsPort = new NodeFileSystem({ root, trashDir });
  const trash = new TrashStore(trashDir);
  return { base, root, trashDir, fsPort, trash };
}

describe('删文件进回收站', () => {
  it('删除后文件从工作区消失，但回收站里有', async () => {
    const { root, fsPort, trash } = setup();
    writeFileSync(join(root, 'a.txt'), 'hello', 'utf8');

    await fsPort.remove('a.txt');
    expect(existsSync(join(root, 'a.txt'))).toBe(false);

    const items = await trash.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.originalPath.endsWith('a.txt')).toBe(true);
  });

  it('恢复后回到原路径，内容不变', async () => {
    const { root, fsPort, trash } = setup();
    writeFileSync(join(root, 'b.txt'), '内容还在', 'utf8');
    await fsPort.remove('b.txt');

    const item = (await trash.list())[0];
    if (item === undefined) throw new Error('回收站为空');
    const result = await trash.restore(item.id);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('内容还在');
    expect(await trash.list()).toEqual([]);
  });

  it('目录也能回收站恢复', async () => {
    const { root, fsPort, trash } = setup();
    mkdirSync(join(root, 'dir'), { recursive: true });
    writeFileSync(join(root, 'dir', 'x.txt'), 'x', 'utf8');

    await fsPort.remove('dir', { recursive: true });
    expect(existsSync(join(root, 'dir'))).toBe(false);

    const item = (await trash.list())[0];
    if (item === undefined) throw new Error('回收站为空');
    expect((await trash.restore(item.id)).ok).toBe(true);
    expect(readFileSync(join(root, 'dir', 'x.txt'), 'utf8')).toBe('x');
  });

  it('原路径被占用时拒绝恢复', async () => {
    const { root, fsPort, trash } = setup();
    writeFileSync(join(root, 'c.txt'), 'old', 'utf8');
    await fsPort.remove('c.txt');
    writeFileSync(join(root, 'c.txt'), 'new', 'utf8');

    const item = (await trash.list())[0];
    if (item === undefined) throw new Error('回收站为空');
    const result = await trash.restore(item.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('target_exists');
  });

  it('彻底删除后回收站清空，文件不再可恢复', async () => {
    const { root, fsPort, trash } = setup();
    writeFileSync(join(root, 'd.txt'), 'd', 'utf8');
    await fsPort.remove('d.txt');
    const item = (await trash.list())[0];
    if (item === undefined) throw new Error('回收站为空');

    expect(await trash.purge(item.id)).toBe(true);
    expect(await trash.list()).toEqual([]);
    expect((await trash.restore(item.id)).ok).toBe(false);
  });

  it('没配回收站时仍是物理删除（验证脚本/测试不受影响）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'butler-trash-none-'));
    const root = join(base, 'ws');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'e.txt'), 'e', 'utf8');
    const fsPort = new NodeFileSystem({ root });
    await fsPort.remove('e.txt');
    expect(existsSync(join(root, 'e.txt'))).toBe(false);
  });
});
