import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
}));

vi.mock('@/app/runtime', () => ({ getRuntime: mocks.getRuntime }));

import { GET } from '../route.js';

const entries = new Map<string, unknown>();
const all = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  entries.clear();
  all.mockReturnValue([]);
  mocks.getRuntime.mockResolvedValue({
    bootstrapped: {
      log: { all },
      memory: { get: (id: string) => entries.get(id) },
    },
  });
});

function memory(id: string, content: string): unknown {
  return { id, content, memClass: 'global_shared', kind: 'preference' };
}

describe('GET /api/memory/conflicts', () => {
  it('没有事件时返回空列表', async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    const body = (await r.json()) as { conflicts: unknown[] };
    expect(body.conflicts).toHaveLength(0);
  });

  it('读取 conflict.detected 并补全另一条记忆', async () => {
    entries.set('m1', memory('m1', '喜欢安静'));
    entries.set('m2', memory('m2', '喜欢热闹'));
    all.mockReturnValue([
      {
        type: 'conflict.detected',
        createdAt: 123,
        payload: {
          memoryId: 'm1',
          memoryIds: ['m2'],
          reason: '模型判断可能冲突',
          detector: 'model',
        },
      },
    ]);
    const r = await GET();
    const body = (await r.json()) as {
      conflicts: { memoryId: string; otherMemoryId: string; other: { content: string } }[];
    };
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0]).toMatchObject({
      memoryId: 'm1',
      otherMemoryId: 'm2',
      reason: '模型判断可能冲突',
      detector: 'model',
      other: { content: '喜欢热闹' },
    });
  });

  it('两端记忆不存在时跳过，不返回悬空冲突', async () => {
    entries.set('m1', memory('m1', '喜欢安静'));
    all.mockReturnValue([
      {
        type: 'conflict.detected',
        createdAt: 123,
        payload: { memoryId: 'm1', memoryIds: ['missing'], reason: 'x' },
      },
    ]);
    const r = await GET();
    const body = (await r.json()) as { conflicts: unknown[] };
    expect(body.conflicts).toHaveLength(0);
  });
});
