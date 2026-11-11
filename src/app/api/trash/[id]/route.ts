/**
 * 文件回收站 —— 单条操作
 *
 * `POST   /api/trash/[id]  { action: 'restore' }`  恢复到原路径
 * `DELETE /api/trash/[id]`                        彻底删除
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

const REASON: Record<string, string> = {
  not_found: '回收站里找不到这条记录',
  outside_root: '原路径不在当时的工作区内，拒绝恢复（安全考虑）',
  target_exists: '原路径上已经有同名文件，先处理它再恢复',
  payload_missing: '回收站里的文件已丢失，无法恢复',
};

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const rt = await getRuntime();

  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  if (body.action !== 'restore') {
    return NextResponse.json({ error: '只支持 action=restore' }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof rt.trash.restore>>;
  try {
    result = await rt.trash.restore(id);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '恢复失败' },
      { status: 400 },
    );
  }

  if (!result.ok) {
    const reason = result.reason ?? 'unknown';
    return NextResponse.json(
      { error: REASON[reason] ?? '恢复失败', reason },
      { status: reason === 'not_found' ? 404 : 409 },
    );
  }
  return NextResponse.json({ ok: true, path: result.path, restored: true });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const rt = await getRuntime();
  const purged = await rt.trash.purge(id);
  if (!purged) {
    return NextResponse.json({ error: '回收站里找不到这条记录' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, purged: true });
}
