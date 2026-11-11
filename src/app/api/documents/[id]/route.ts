import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getDocumentStore } from '@/app/server/documents.js';
import { getKnowledgeService } from '@/app/server/knowledge.js';

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

/**
 * 删除文档 —— 第一步：移入「文档存档区」（可恢复）。
 *
 * ★ 与记忆同一套两步制：这里删除后原文还在存档区，检索索引**立刻**移除；
 *   在存档区再点「彻底删除」才会真正删掉原文。
 * ⚠️ 文档的存档区独立于记忆存档区（各功能区域分开，不做统一归档中心）。
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    const archiveId = await getDocumentStore().archiveOut(id, '用户删除');
    if (archiveId === null) {
      return NextResponse.json({ error: '找不到这个文档' }, { status: 404 });
    }
    try {
      await getKnowledgeService().removeDocument(id);
    } catch {
      // 文档已经移入存档区；索引清理失败不能把删除操作回滚成失败。
    }
    return NextResponse.json({
      ok: true,
      archived: true,
      archiveId,
      note: '已移入文档存档区；在存档区再次删除才会彻底删除',
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 503 },
    );
  }
}
