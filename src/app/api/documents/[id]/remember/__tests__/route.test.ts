import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
  getDocumentStore: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@/app/runtime', () => ({
  DEFAULT_USER_ID: 'local',
  getRuntime: mocks.getRuntime,
}));
vi.mock('@/app/server/documents.js', () => ({ getDocumentStore: mocks.getDocumentStore }));

import { POST } from '../route.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRuntime.mockResolvedValue({
    clock: { now: () => 1 },
    bootstrapped: {
      memory: { create: mocks.create },
      log: { flushPersistence: () => Promise.resolve() },
    },
  });
  mocks.getDocumentStore.mockReturnValue({
    get: () => Promise.resolve({ id: 'doc_1', name: '报告.txt' }),
  });
  mocks.create.mockReturnValue({ ok: true, entry: { id: 'm_1' } });
});

describe('POST /api/documents/[id]/remember', () => {
  it('用户明确选择后直接生效，不再进入待审候选', async () => {
    const r = await POST(
      new NextRequest('http://localhost/api/documents/doc_1/remember', {
        method: 'POST',
        body: JSON.stringify({ content: '用户对花生过敏', memClass: 'domain', domain: 'health' }),
      }),
      { params: Promise.resolve({ id: 'doc_1' }) },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { active: boolean; created: number };
    expect(body.active).toBe(true);
    expect(body.created).toBe(1);

    const call = mocks.create.mock.calls[0] as [unknown, { content: string; lifecycle: string; domain?: string }];
    expect(call[0]).toMatchObject({ kind: 'user', userId: 'local' });
    expect(call[1].content).toContain('花生');
    expect(call[1].lifecycle).toBe('active');
    expect(call[1].domain).toBe('health');
  });

  it('缺少 domain 的 domain 类记忆被拒', async () => {
    const r = await POST(
      new NextRequest('http://localhost/api/documents/doc_1/remember', {
        method: 'POST',
        body: JSON.stringify({ content: 'x', memClass: 'domain' }),
      }),
      { params: Promise.resolve({ id: 'doc_1' }) },
    );
    expect(r.status).toBe(400);
  });
});
