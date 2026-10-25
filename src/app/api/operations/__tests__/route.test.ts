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
  return new NextRequest('http://localhost/api/operations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const recordPreference = vi.fn();
const recordEnvironment = vi.fn();
const flushPersistence = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  recordPreference.mockReturnValue({
    id: 'op_1',
    kind: 'preference',
    content: '喜欢简短回复',
    taskLabel: '写邮件',
    evidence: [],
    createdAt: 1,
  });
  recordEnvironment.mockReturnValue({
    id: 'op_2',
    kind: 'environment',
    content: 'Python 在 D 盘',
    taskLabel: '运行脚本',
    evidence: [],
    createdAt: 1,
  });
  mocks.getRuntime.mockResolvedValue({
    bootstrapped: {
      operations: { recordPreference, recordEnvironment },
      log: { flushPersistence },
    },
  });
});

describe('POST /api/operations', () => {
  it('拒绝非法 kind', async () => {
    const r = await POST(req({ kind: 'method', content: 'x', taskLabel: 'y' }));
    expect(r.status).toBe(400);
  });

  it('拒绝凭证内容，且不调用写入', async () => {
    const r = await POST(req({
      kind: 'preference',
      content: 'api_key=sk-123456789012345678901234567890',
      taskLabel: '测试',
    }));
    expect(r.status).toBe(400);
    expect(recordPreference).not.toHaveBeenCalled();
  });

  it('用户显式偏好写入并落盘', async () => {
    const r = await POST(req({
      kind: 'preference',
      content: '喜欢简短回复',
      taskLabel: '写邮件',
      evidence: '用户原话',
    }));
    expect(r.status).toBe(200);
    expect(recordPreference).toHaveBeenCalledWith({
      content: '喜欢简短回复',
      taskLabel: '写邮件',
      evidence: '用户原话',
    });
    expect(flushPersistence).toHaveBeenCalled();
  });

  it('环境记忆走 recordEnvironment', async () => {
    const r = await POST(req({
      kind: 'environment',
      content: 'Python 在 D 盘',
      taskLabel: '运行脚本',
    }));
    expect(r.status).toBe(200);
    expect(recordEnvironment).toHaveBeenCalled();
  });
});
