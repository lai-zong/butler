/**
 * 记忆存档区 —— 列表
 *
 * `GET /api/memory/archive`
 *
 * ★ 存档区是**记忆功能自己的**，不是全局归档中心。
 *   文档有文档的存档区、工作区文件将来有自己的回收站，互不合并。
 *
 * 返回内容的排序：最近删除的在前。敏感域的原文照常返回（本机单用户，
 * 界面侧默认打码；不在这里做遮蔽，避免"恢复"拿不到原文）。
 */

import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { toMemoryDto } from '@/app/server/uiData.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const records = await rt.memoryArchive.list();

  return NextResponse.json({
    ok: true,
    total: records.length,
    items: records.map((r) => ({
      archiveId: r.archiveId,
      reason: r.reason,
      archivedAt: r.archivedAt,
      memory: toMemoryDto(r.memory),
    })),
    note: '存档区里的记忆不参与召回；恢复后回到活跃状态，彻底删除才会抹除原文。',
  });
}
