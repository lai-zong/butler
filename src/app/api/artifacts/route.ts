/**
 * 产出物列表 —— 只读（方案 § 5.2）
 *
 * GET /api/artifacts
 *   → { ok, artifacts: [...] }
 *
 * ★ 列表只给元数据，不给正文：
 *   产出物可能很长，也可能含用户内容；列表页只需要知道"有哪些、第几版"。
 *   正文与版本历史在 `GET /api/artifacts/[id]`。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import type { ArtifactStatus } from '@/core/artifact/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUSES: readonly ArtifactStatus[] = ['draft', 'active', 'superseded', 'discarded'];

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const store = rt.bootstrapped.artifacts;

  const statusParam = (req.nextUrl.searchParams.get('status') ?? '').trim();
  if (statusParam.length > 0 && !(STATUSES as readonly string[]).includes(statusParam)) {
    return NextResponse.json(
      { error: `status 只能是 ${STATUSES.join(' / ')}` },
      { status: 400 },
    );
  }

  const artifacts = store
    .all()
    .filter((a) => statusParam.length === 0 || a.status === statusParam)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((a) => {
      const current = store.currentRevision(a.id);
      return {
        id: a.id,
        label: a.label,
        kind: a.kind,
        status: a.status,
        currentVersion: a.currentVersion,
        producedByStep: a.producedByStep,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        ...(a.supersededBy !== undefined ? { supersededBy: a.supersededBy } : {}),
        ...(a.supersededByRollback !== undefined
          ? { supersededByRollback: a.supersededByRollback }
          : {}),
        revisionCount: store.revisions(a.id).length,
        size: current === undefined ? 0 : current.items ? current.items.length : current.content.length,
      };
    });

  return NextResponse.json({ ok: true, artifacts });
}
