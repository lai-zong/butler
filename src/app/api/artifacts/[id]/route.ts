/**
 * 单个产出物 + 版本历史 —— 只读（方案 § 5.2）
 *
 * GET /api/artifacts/[id]
 *   → { ok, artifact, revisions, currentVersion, diff? }
 *
 * `?from=1&to=3` 返回两个版本的集合差，便于界面做"加了什么/去掉了什么"。
 * 被取代的旧版本**保留**，不删除。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { diffRevisions } from '@/core/artifact/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const rt = await getRuntime();
  const store = rt.bootstrapped.artifacts;
  const artifact = store.get(id);

  if (artifact === undefined) {
    return NextResponse.json({ error: '找不到这个产出物' }, { status: 404 });
  }

  const revisions = [...store.revisions(id)].sort((a, b) => a.version - b.version);

  const fromRaw = req.nextUrl.searchParams.get('from');
  const toRaw = req.nextUrl.searchParams.get('to');
  let diff: ReturnType<typeof diffRevisions> | null = null;

  if (fromRaw !== null || toRaw !== null) {
    if (fromRaw === null || toRaw === null) {
      return NextResponse.json({ error: 'from 与 to 必须同时给出' }, { status: 400 });
    }
    const from = Number.parseInt(fromRaw, 10);
    const to = Number.parseInt(toRaw, 10);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return NextResponse.json({ error: 'from / to 必须是版本号' }, { status: 400 });
    }
    const a = revisions.find((r) => r.version === from);
    const b = revisions.find((r) => r.version === to);
    if (a === undefined || b === undefined) {
      return NextResponse.json(
        {
          error: '找不到指定的版本',
          available: revisions.map((r) => r.version),
        },
        { status: 404 },
      );
    }
    diff = diffRevisions(a, b);
  }

  return NextResponse.json({
    ok: true,
    artifact,
    revisions,
    currentVersion: artifact.currentVersion,
    diff,
  });
}
