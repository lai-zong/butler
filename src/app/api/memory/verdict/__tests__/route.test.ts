import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
}));

vi.mock('@/app/runtime', () => ({
  getRuntime: mocks.getRuntime,
}));

import { POST } from '../route.js';

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/memory/verdict', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const store = {
  get: vi.fn(),
  recordVerdict: vi.fn(),
};
const append = vi.fn();
const flushPersistence = vi.fn();

function memory(id: string, memClass: 'domain' | 'sensitive' | 'global_constraint'): unknown {
  return { id, memClass };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.get.mockImplementation((id: string) => {
    if (id === 'winner') return memory('winner', 'domain');
    if (id === 'loser') return memory('loser', 'domain');
    if (id === 'secret') return memory('secret', 'sensitive');
    if (id === 'global') return memory('global', 'global_constraint');
    return undefined;
  });
  store.recordVerdict.mockImplementation((_id: string, outcome: 'won' | 'lost') => ({
    ok: true,
    fitnessBefore: 1,
    fitnessAfter: outcome === 'lost' ? 0.95 : 1,
  }));
  mocks.getRuntime.mockResolvedValue({
    clock: { now: () => 1 },
    bootstrapped: {
      memory: store,
      log: { append, flushPersistence },
    },
  });
});

describe('POST /api/memory/verdict', () => {
  it('正常裁决：winner 计成功、loser 降权、落审计', async () => {
    const r = await POST(req({ winnerId: 'winner', loserId: 'loser' }));
    expect(r.status).toBe(200);
    expect(store.recordVerdict).toHaveBeenNthCalledWith(1, 'winner', 'won');
    expect(store.recordVerdict).toHaveBeenNthCalledWith(2, 'loser', 'lost');
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: 'conflict.resolved' }));
    expect(flushPersistence).toHaveBeenCalled();
  });

  it('拒绝敏感域', async () => {
    const r = await POST(req({ winnerId: 'secret', loserId: 'loser' }));
    expect(r.status).toBe(409);
    expect(store.recordVerdict).not.toHaveBeenCalled();
  });

  it('拒绝全局硬约束', async () => {
    const r = await POST(req({ winnerId: 'winner', loserId: 'global' }));
    expect(r.status).toBe(409);
    expect(store.recordVerdict).not.toHaveBeenCalled();
  });

  it('拒绝相同 id', async () => {
    const r = await POST(req({ winnerId: 'winner', loserId: 'winner' }));
    expect(r.status).toBe(400);
  });

  it('找不到记忆返回 404', async () => {
    const r = await POST(req({ winnerId: 'winner', loserId: 'missing' }));
    expect(r.status).toBe(404);
  });
});
