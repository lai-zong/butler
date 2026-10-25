import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/app/server/credentials.js', () => ({
  getCredentialVault: () =>
    Promise.resolve({
      list: mocks.list,
      put: mocks.put,
      remove: mocks.remove,
    }),
}));

import { GET, POST } from '../route.js';
import { DELETE } from '../[id]/route.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/api/credentials', () => {
  it('GET 只返回名称/时间，不返回内容', async () => {
    mocks.list.mockResolvedValue([{ id: 'c1', name: 'github', createdAt: 1 }]);
    const r = await GET();
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('github');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('cipher');
  });

  it('POST 保存但不回显 secret', async () => {
    mocks.put.mockResolvedValue({ id: 'c1', name: 'github', createdAt: 1 });
    const r = await POST(
      new NextRequest('http://localhost/api/credentials', {
        method: 'POST',
        body: JSON.stringify({ name: 'github', secret: 'ghp_topsecret' }),
      }),
    );
    expect(r.status).toBe(201);
    const text = await r.text();
    expect(text).toContain('github');
    expect(text).not.toContain('ghp_topsecret');
    expect(mocks.put).toHaveBeenCalledWith('github', 'ghp_topsecret');
  });

  it('空字段 400', async () => {
    const r = await POST(
      new NextRequest('http://localhost/api/credentials', {
        method: 'POST',
        body: JSON.stringify({ name: '', secret: '' }),
      }),
    );
    expect(r.status).toBe(400);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('DELETE 找不到 404', async () => {
    mocks.remove.mockResolvedValue(false);
    const r = await DELETE(
      new NextRequest('http://localhost/api/credentials/c1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect(r.status).toBe(404);
  });
});
