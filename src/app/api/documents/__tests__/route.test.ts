import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  ingest: vi.fn(),
  remove: vi.fn(),
  // 删除改成两步：先移入文档存档区（可恢复），再在存档区彻底删除
  archiveOut: vi.fn(),
}));

vi.mock('@/app/server/documents.js', () => ({
  getDocumentStore: () => ({
    list: mocks.list,
    search: mocks.search,
    ingest: mocks.ingest,
    remove: mocks.remove,
    archiveOut: mocks.archiveOut,
  }),
}));

import { GET, POST } from '../route.js';
import { DELETE } from '../[id]/route.js';

beforeEach(() => vi.clearAllMocks());

describe('/api/documents', () => {
  it('GET 返回文档列表', async () => {
    mocks.list.mockResolvedValue([{ id: 'doc_1', name: '报告.pdf', chunkCount: 2 }]);
    const r = await GET(new NextRequest('http://localhost/api/documents'));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('报告.pdf');
  });

  it('GET ?q= 返回带出处的片段', async () => {
    mocks.search.mockResolvedValue([{ documentId: 'doc_1', name: '报告.pdf', chunkIndex: 1, text: 'LDL 3.8', score: 1 }]);
    const r = await GET(new NextRequest('http://localhost/api/documents?q=LDL'));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('LDL 3.8');
    expect(mocks.search).toHaveBeenCalledWith('LDL', 8);
  });

  it('POST 入库并返回 id', async () => {
    mocks.ingest.mockResolvedValue({
      document: { id: 'doc_1', name: '报告.pdf', chunkCount: 2 },
      duplicate: false,
    });
    const r = await POST(
      new NextRequest('http://localhost/api/documents', {
        method: 'POST',
        body: JSON.stringify({ name: '报告.pdf', text: '低密度脂蛋白 3.8' }),
      }),
    );
    expect(r.status).toBe(201);
    expect(await r.text()).toContain('doc_1');
  });

  it('POST 空内容 400', async () => {
    const r = await POST(
      new NextRequest('http://localhost/api/documents', {
        method: 'POST',
        body: JSON.stringify({ name: '', text: '' }),
      }),
    );
    expect(r.status).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('DELETE 找不到 404', async () => {
    mocks.archiveOut.mockResolvedValue(null);
    const r = await DELETE(
      new NextRequest('http://localhost/api/documents/doc_x', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'doc_x' }) },
    );
    expect(r.status).toBe(404);
  });

  it('DELETE 成功后返回已移入存档区（不是彻底删除）', async () => {
    mocks.archiveOut.mockResolvedValue('darc_1');
    const r = await DELETE(
      new NextRequest('http://localhost/api/documents/doc_1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'doc_1' }) },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { archived?: boolean; archiveId?: string };
    expect(body.archived).toBe(true);
    expect(body.archiveId).toBe('darc_1');
    expect(mocks.archiveOut).toHaveBeenCalledWith('doc_1', '用户删除');
  });
});
