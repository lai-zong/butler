import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '../route.js';

function req(): NextRequest {
  return new NextRequest('http://localhost/api/memory/verdict', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ winnerId: 'any', loserId: 'other' }),
  });
}

describe('POST /api/memory/verdict', () => {
  it('手动裁决已停用，返回 410 且不伪装成功', async () => {
    const r = await POST(req());
    expect(r.status).toBe(410);
    const body = (await r.json()) as { code?: string };
    expect(body.code).toBe('manual_verdict_disabled');
  });
});
