import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '../route.js';

function request(file: File): NextRequest {
  const form = new FormData();
  form.append('file', file);
  return new NextRequest('http://localhost/api/attachments/extract', {
    method: 'POST',
    body: form,
  });
}

describe('POST /api/attachments/extract', () => {
  it('提取纯文本并标注文件名', async () => {
    const r = await POST(request(new File(['你好，文档测试'], 'a.txt', { type: 'text/plain' })));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; kind: string; fileName: string; text: string };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('txt');
    expect(body.fileName).toBe('a.txt');
    expect(body.text).toContain('你好，文档测试');
  });

  it('拒绝不支持的扩展名', async () => {
    const r = await POST(request(new File(['x'], 'a.exe', { type: 'application/octet-stream' })));
    expect(r.status).toBe(400);
  });
});
