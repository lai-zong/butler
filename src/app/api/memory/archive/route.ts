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

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { hashContent } from '@/core/events/scrub.js';
import { toMemoryDto } from '@/app/server/uiData.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const records = await rt.memoryArchive.list();
  const stats = await rt.memoryArchive.stats();

  return NextResponse.json({
    ok: true,
    total: records.length,
    bytes: stats.bytes,
    items: records.map((r) => ({
      archiveId: r.archiveId,
      reason: r.reason,
      archivedAt: r.archivedAt,
      memory: toMemoryDto(r.memory),
    })),
    note: '存档区里的记忆不参与召回；恢复后回到活跃状态，彻底删除才会抹除原文。',
  });
}


/**
 * 清空存档区（用户显式确认后）。
 *
 * ★ 不做自动过期（用户确认的规则），所以必须给一个"一次清干净"的出口；
 *   但每一条都要按"彻底删除"处理：抹原文 + 落墓碑，然后再清空文件。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();

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

  const records = await rt.memoryArchive.list();
  const log = rt.bootstrapped.log;
  for (const record of records) {
    log.scrubForMemory(record.memory.id, record.memory.content);
    log.append({
      type: 'intervention.forgotten',
      actor: 'user',
      payload: {
        memoryId: record.memory.id,
        memClass: record.memory.memClass,
        hardConstraint: false,
        erased: true,
        contentHash: hashContent(record.memory.content),
        archiveId: record.archiveId,
        note: '清空存档区：原文已抹除',
      },
      createdAt: rt.clock.now(),
    });
  }
  await log.flushPersistence().catch(() => undefined);

  const purged = await rt.memoryArchive.clear();
  return NextResponse.json({ ok: true, purged });
}
