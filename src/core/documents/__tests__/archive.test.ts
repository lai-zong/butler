/**
 * 文档存档区（两步删除）
 *
 * ① 删除 → 移入文档自己的存档区（可恢复）；检索索引立即移除；
 * ② 存档区再删除 → 原文才真正消失。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DocumentStore } from '../store.js';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'butler-doc-archive-'));
  const store = new DocumentStore(join(base, 'documents'), () => 1_760_000_000_000, join(base, 'archive', 'documents'));
  return { store };
}

describe('文档两步删除', () => {
  it('删除后进存档区，文档列表里看不到', async () => {
    const { store } = setup();
    const { document } = await store.ingest({ name: '合同.txt', text: '甲方与乙方签订本协议，甲方付款。' });

    const archiveId = await store.archiveOut(document.id, '误删');
    expect(archiveId).not.toBeNull();

    expect(await store.list()).toEqual([]);
    const archived = await store.listArchived();
    expect(archived.map((a) => a.name)).toEqual(['合同.txt']);
    expect(archived[0]?.reason).toBe('误删');
  });

  it('从存档区恢复后重新出现在文档列表', async () => {
    const { store } = setup();
    const { document } = await store.ingest({ name: '协议.txt', text: '这是协议正文，用于检索。' });
    const archiveId = await store.archiveOut(document.id, '手滑');
    if (archiveId === null) throw new Error('存档失败');

    expect(await store.restoreArchived(archiveId)).toBe(true);
    const list = await store.list();
    expect(list.map((d) => d.name)).toEqual(['协议.txt']);
    expect((await store.get(document.id))?.chunks.length).toBeGreaterThan(0);
    expect(await store.listArchived()).toEqual([]);
  });

  it('彻底删除后存档区也清空', async () => {
    const { store } = setup();
    const { document } = await store.ingest({ name: '草稿.txt', text: '草稿内容。' });
    const archiveId = await store.archiveOut(document.id, '不要了');
    if (archiveId === null) throw new Error('存档失败');

    expect(await store.purgeArchived(archiveId)).toBe(true);
    expect(await store.listArchived()).toEqual([]);
    // 文档库也不会因为彻底删除而复活
    expect(await store.get(document.id)).toBeNull();
  });

  it('存档 id 非法时不会被当成路径穿越', async () => {
    const { store } = setup();
    await expect(store.readArchived('../evil')).rejects.toThrow('非法存档 id');
  });
});
