/**
 * 文档存档区 —— 单条操作
 *
 * `POST   /api/documents/archive/[id]  { action: 'restore' }`  恢复到知识库
 * `DELETE /api/documents/archive/[id]`                         彻底删除
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getDocumentStore } from '@/app/server/documents.js';
import { getKnowledgeService } from '@/app/server/knowledge.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;

  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  if (body.action !== 'restore') {
    return NextResponse.json({ error: '只支持 action=restore' }, { status: 400 });
  }

  try {
    const store = getDocumentStore();
    const record = await store.readArchived(id);
    if (record === null) {
      return NextResponse.json({ error: '存档里找不到这个文档' }, { status: 404 });
    }

    const restored = await store.restoreArchived(id);
    if (!restored) {
      return NextResponse.json(
        { error: '恢复失败：文档库里已存在同 id 的文档（可能已恢复过）' },
        { status: 409 },
      );
    }

    // 恢复后让检索层重新同步文档集合；失败不应回滚恢复本身
    try {
      await getKnowledgeService().onDocumentsChanged();
    } catch {
      // 索引可以下次重建
    }

    return NextResponse.json({ ok: true, documentId: record.doc.id, restored: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '恢复失败' },
      { status: 503 },
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    const store = getDocumentStore();
    const record = await store.readArchived(id);
    if (record === null) {
      return NextResponse.json({ error: '存档里找不到这个文档' }, { status: 404 });
    }

    await store.purgeArchived(id);
    // 兜底：确保检索索引里也没有它（删的时候通常已经移除）
    try {
      await getKnowledgeService().removeDocument(record.doc.id);
    } catch {
      // 索引清理失败不影响"已彻底删除"的事实
    }

    return NextResponse.json({ ok: true, documentId: record.doc.id, purged: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '彻底删除失败' },
      { status: 503 },
    );
  }
}
