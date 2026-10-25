import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
  pdf: vi.fn(),
}));

vi.mock('@/app/runtime', () => ({
  getRuntime: mocks.getRuntime,
}));

vi.mock('@/app/server/artifactPdf.js', () => ({
  artifactToPdf: mocks.pdf,
}));

import { GET } from '../route.js';

const artifact = {
  id: 'a1',
  label: '购物清单',
  kind: 'list' as const,
  status: 'active' as const,
  currentVersion: 1,
  producedByStep: 't1',
  createdAt: 1,
  updatedAt: 1,
};
const revision = {
  artifactId: 'a1',
  version: 1,
  content: '苹果\n牛奶',
  items: ['苹果', '牛奶, 2 盒'],
  author: 'butler' as const,
  reason: 'test',
  producedBy: [],
  createdAt: 1,
};
const store = {
  get: vi.fn(),
  currentRevision: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  store.get.mockReturnValue(artifact);
  store.currentRevision.mockReturnValue(revision);
  mocks.getRuntime.mockResolvedValue({ bootstrapped: { artifacts: store } });
});

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/artifacts/[id]/download', () => {
  it('不支持格式明确 400', async () => {
    const r = await GET(
      new NextRequest('http://localhost/api/artifacts/a1/download?format=txt'),
      ctx('a1'),
    );
    expect(r.status).toBe(400);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('找不到产出物 404', async () => {
    store.get.mockReturnValue(undefined);
    const r = await GET(
      new NextRequest('http://localhost/api/artifacts/missing/download?format=csv'),
      ctx('missing'),
    );
    expect(r.status).toBe(404);
  });

  it('CSV 返回内容、转义与 RFC 5987 文件名', async () => {
    const r = await GET(
      new NextRequest('http://localhost/api/artifacts/a1/download?format=csv'),
      ctx('a1'),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    const body = await r.text();
    expect(body).toContain('牛奶, 2 盒');
    expect(body).toContain('"牛奶, 2 盒"');
  });

  it('PDF 返回 application/pdf 与 pdf 文件名', async () => {
    mocks.pdf.mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
    const r = await GET(
      new NextRequest('http://localhost/api/artifacts/a1/download?format=pdf'),
      ctx('a1'),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toContain('.pdf');
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('%PDF-1.4 fake');
  });

  it('PDF 生成失败返回 503，而不是空文件', async () => {
    mocks.pdf.mockRejectedValue(new Error('PDF 导出需要本机 Edge/Chrome'));
    const r = await GET(
      new NextRequest('http://localhost/api/artifacts/a1/download?format=pdf'),
      ctx('a1'),
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toContain('Edge');
  });

  it('ICS 返回 VTODO 任务清单，不猜日期', async () => {
    const r = await GET(
      new NextRequest('http://localhost/api/artifacts/a1/download?format=ics'),
      ctx('a1'),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/calendar');
    const body = await r.text();
    expect(body).toContain('BEGIN:VTODO');
    expect(body).toContain('SUMMARY:牛奶\\, 2 盒');
    expect(body).not.toContain('DTSTART');
    expect(body).not.toContain('DUE:');
  });
});
