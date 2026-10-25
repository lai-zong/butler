import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
  getDocumentStore: vi.fn(),
  sinkCandidates: vi.fn(),
}));

vi.mock('@/app/runtime', () => ({ getRuntime: mocks.getRuntime }));
vi.mock('@/app/server/documents.js', () => ({ getDocumentStore: mocks.getDocumentStore }));
vi.mock('@/core/memory/sink.js', () => ({ sinkCandidates: mocks.sinkCandidates }));

import { POST } from '../route.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRuntime.mockResolvedValue({
    clock: { now: () => 1 },
    bootstrapped: { log: {}, memory: {} },
  });
  mocks.getDocumentStore.mockReturnValue({
    get: () => Promise.resolve({ id: 'doc_1', name: '报告.txt' }),
  });
  mocks.sinkCandidates.mockReturnValue({
    created: [{ id: 'm_1' }],
    skipped: [],
  });
});

describe('POST /api/documents/[id]/remember', () => {
  it('用户确认后只入候选，不直接生效', async () => {
    const r = await POST(
      new NextRequest('http://localhost/api/documents/doc_1/remember', {
        method: 'POST',
        body: JSON.stringify({ content: '用户对花生过敏', memClass: 'domain', domain: 'health' }),
      }),
      { params: Promise.resolve({ id: 'doc_1' }) },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { pendingReview: boolean; created: number };
    expect(body.pendingReview).toBe(true);
    expect(body.created).toBe(1);
    const candidate = mocks.sinkCandidates.mock.calls[0]?.[1]?.[0] as { content: string; scope: { domain: string } };
    expect(candidate.content).toContain('花生');
    expect(candidate.scope.domain).toBe('health');
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
