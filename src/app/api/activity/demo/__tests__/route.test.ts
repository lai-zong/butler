import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
}));

vi.mock('@/app/runtime', () => ({
  getRuntime: mocks.getRuntime,
  DEFAULT_USER_ID: 'local',
}));

import { POST } from '../route.js';

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/activity/demo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const getConsent = vi.fn();
const observe = vi.fn();
const aggregate = vi.fn();
const flushPersistence = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getConsent.mockReturnValue({ granted: true, enabled: true, retentionDays: 7 });
  observe.mockReturnValue({ recorded: true });
  mocks.getRuntime.mockResolvedValue({
    clock: { now: () => 1_760_000_000_000 },
    activityObserver: { getConsent, observe, aggregate },
    bootstrapped: { log: { flushPersistence } },
  });
});

describe('POST /api/activity/demo', () => {
  it('未同意时拒绝，不写任何记录', async () => {
    getConsent.mockReturnValue({ granted: false, enabled: true, retentionDays: 7 });
    const r = await POST(req({ profile: 'office-dev', days: 2 }));
    expect(r.status).toBe(409);
    expect(observe).not.toHaveBeenCalled();
  });

  it('非法 profile 返回 400', async () => {
    const r = await POST(req({ profile: 'unknown', days: 2 }));
    expect(r.status).toBe(400);
  });

  it('同意后导入演示记录，并逐日聚合', async () => {
    const r = await POST(req({ profile: 'office-dev', days: 2 }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { generated: number; recorded: number; source: string };
    expect(body.source).toBe('demo');
    expect(body.generated).toBeGreaterThan(0);
    expect(body.recorded).toBe(body.generated);
    expect(observe).toHaveBeenCalledTimes(body.generated);
    // 两天各一次 + 末尾一次
    expect(aggregate.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(flushPersistence).toHaveBeenCalled();
  });
});
