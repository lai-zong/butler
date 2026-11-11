/**
 * 文档存档区 —— 列表
 *
 * `GET /api/documents/archive`
 *
 * ★ 文档有**自己的**存档区，不与记忆存档区合并。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getDocumentStore } from '@/app/server/documents.js';
import { getKnowledgeService } from '@/app/server/knowledge.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const items = await getDocumentStore().listArchived();
    return NextResponse.json({
      ok: true,
      total: items.length,
      items,
      note: '存档区里的文档不参与检索；恢复后重新进入知识库，彻底删除才会移除原文。',
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '读取存档失败' },
      { status: 503 },
    );
  }
}


/** 清空文档存档区（显式确认后）。 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { action?: unknown; confirm?: unknown };
  try {
    body = (await req.json()) as { action?: unknown; confirm?: unknown };
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  if (body.action !== 'purge-all') {
    return NextResponse.json({ error: '只支持 action=purge-all' }, { status: 400 });
  }
  if (body.confirm !== 'confirmed') {
    return NextResponse.json({ error: '清空存档需要显式确认（confirm="confirmed"）' }, { status: 400 });
  }

  try {
    const store = getDocumentStore();
    const items = await store.listArchived();
    for (const item of items) {
      await store.purgeArchived(item.archiveId);
      try {
        await getKnowledgeService().removeDocument(item.id);
      } catch {
        // 索引清理失败不影响"已彻底删除"
      }
    }
    return NextResponse.json({ ok: true, purged: items.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '清空失败' },
      { status: 503 },
    );
  }
}
