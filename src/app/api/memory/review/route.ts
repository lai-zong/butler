/**
 * 手动审核已停用。
 *
 * 试行记忆由系统按独立证据自动转正；用户只保留查看和删除。
 * 保留这个端点是为了让旧的调用方得到明确失败，而不是静默改状态。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: '手动审核已停用：试行记忆由系统自动验证，用户只保留删除权。',
      code: 'manual_review_disabled',
    },
    { status: 410 },
  );
}
