import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getDocumentStore } from '@/app/server/documents.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    const doc = await getDocumentStore().get(id);
    if (doc === null) return NextResponse.json({ error: '找不到这个文档' }, { status: 404 });
    return NextResponse.json({ ok: true, document: doc });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '读取失败' },
      { status: 503 },
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    const removed = await getDocumentStore().remove(id);
    if (!removed) return NextResponse.json({ error: '找不到这个文档' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 503 },
    );
  }
}
