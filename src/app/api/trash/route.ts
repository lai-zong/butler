/**
 * 文件回收站 —— 列表 / 清空
 *
 * `GET  /api/trash`  列出被删除的文件（模型替用户删的）
 * `POST /api/trash`  { action: 'purge-all', confirm: 'confirmed' } 清空
 *
 * ★ 与记忆存档区、文档存档区互相独立：这是磁盘上的真实文件，
 *   不进导出、不参与迁移。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const [items, stats] = await Promise.all([rt.trash.list(), rt.trash.stats()]);
  return NextResponse.json({
    ok: true,
    total: items.length,
    bytes: stats.bytes,
    items,
    note: '这里存放被删除的工作区文件；恢复会放回原路径，彻底删除不可恢复。',
  });
}

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
    return NextResponse.json({ error: '清空回收站需要显式确认（confirm="confirmed"）' }, { status: 400 });
  }

  const purged = await rt.trash.purgeAll();
  return NextResponse.json({ ok: true, purged });
}
