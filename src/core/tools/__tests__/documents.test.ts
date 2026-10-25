import { describe, expect, it } from 'vitest';

import { documentSearchTool } from '../builtin/documents.js';
import type { DocumentStore } from '../../documents/store.js';

function fakeStore(hits: Awaited<ReturnType<DocumentStore['search']>>): DocumentStore {
  return {
    search: async () => hits,
  } as unknown as DocumentStore;
}

describe('document_search 工具', () => {
  it('返回文档名与片段号，不编造', async () => {
    const tool = documentSearchTool(
      fakeStore([
        { documentId: 'doc_1', name: '报告.pdf', chunkIndex: 2, text: 'LDL 3.8 mmol/L', score: 2 },
      ]),
    );
    const r = await tool.execute({ query: 'LDL', limit: 3 }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('报告.pdf');
    expect(r.output).toContain('片段 3');
    expect(r.output).toContain('LDL 3.8');
  });

  it('没有命中时明确说没有，不返回空泛内容', async () => {
    const tool = documentSearchTool(fakeStore([]));
    const r = await tool.execute({ query: '合同' }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('没有找到');
  });
});
