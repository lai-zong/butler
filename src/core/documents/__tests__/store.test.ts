import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DocumentStore } from '../store.js';

const dirs: string[] = [];

async function store(): Promise<DocumentStore> {
  const dir = await mkdtemp(join(tmpdir(), 'butler-docs-'));
  dirs.push(dir);
  return new DocumentStore(join(dir, 'docs'), () => 1_760_000_000_000);
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('DocumentStore', () => {
  it('入库后可检索，返回文档名和片段序号', async () => {
    const s = await store();
    const r = await s.ingest({
      name: '体检报告.txt',
      text: '血脂检查结果\n\n低密度脂蛋白 LDL 为 3.8 mmol/L，建议复查。',
    });
    expect(r.document.chunkCount).toBeGreaterThan(0);
    const hits = await s.search('LDL 多少', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.name).toBe('体检报告.txt');
    expect(hits[0]?.text).toContain('3.8');
  });

  it('同一份内容重复入库不产生第二份文档', async () => {
    const s = await store();
    const a = await s.ingest({ name: '合同.txt', text: '付款期限为三十天，逾期需要书面通知。' });
    const b = await s.ingest({ name: '合同.txt', text: '付款期限为三十天，逾期需要书面通知。' });
    expect(b.duplicate).toBe(true);
    expect(b.document.id).toBe(a.document.id);
    expect(await s.list()).toHaveLength(1);
  });

  it('过长文本分块，且不超过上限', async () => {
    const s = await store();
    const text = Array.from({ length: 30 }, (_, i) => `第${i}段：` + '内容'.repeat(300)).join('\n\n');
    const r = await s.ingest({ name: '长文档.txt', text });
    expect(r.document.chunkCount).toBeGreaterThan(1);
    expect(r.document.chunkCount).toBeLessThanOrEqual(500);
  });

  it('删除后列表和检索都不再出现', async () => {
    const s = await store();
    const r = await s.ingest({ name: '临时.txt', text: '这是一份临时会议记录，包含预算数字。' });
    expect(await s.remove(r.document.id)).toBe(true);
    expect(await s.list()).toHaveLength(0);
    expect(await s.search('预算')).toHaveLength(0);
  });
});
