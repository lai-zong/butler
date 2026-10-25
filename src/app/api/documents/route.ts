/**
 * 通用文档库 API
 *
 * GET  /api/documents                → 文档列表（不含正文）
 * POST /api/documents                → {name,text,mime?,size?} 入库
 * GET  /api/documents/search?q=...   → 带出处的检索片段
 *
 * ⚠️ 文档正文默认只用于检索，不自动写入记忆。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getDocumentStore } from '@/app/server/documents.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  try {
    const store = getDocumentStore();
    if (q.length > 0) {
      const hits = await store.search(q, 8);
      return NextResponse.json({ ok: true, query: q, hits });
    }
    return NextResponse.json({ ok: true, documents: await store.list() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '文档库不可用' },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const rec = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const name = typeof rec['name'] === 'string' ? rec['name'] : '';
  const text = typeof rec['text'] === 'string' ? rec['text'] : '';
  if (name.trim().length === 0 || text.trim().length === 0) {
    return NextResponse.json({ error: 'name 和 text 都不能为空' }, { status: 400 });
  }
  try {
    const store = getDocumentStore();
    const result = await store.ingest({
      name,
      text,
      ...(typeof rec['mime'] === 'string' ? { mime: rec['mime'] } : {}),
      ...(typeof rec['size'] === 'number' ? { size: rec['size'] } : {}),
    });
    return NextResponse.json(
      { ok: true, document: result.document, duplicate: result.duplicate },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '文档入库失败' },
      { status: 400 },
    );
  }
}
