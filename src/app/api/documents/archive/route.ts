/**
 * 文档存档区 —— 列表
 *
 * `GET /api/documents/archive`
 *
 * ★ 文档有**自己的**存档区，不与记忆存档区合并。
 */

import { NextResponse } from 'next/server';

import { getDocumentStore } from '@/app/server/documents.js';

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
