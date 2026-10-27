/**
 * 手动冲突裁决已停用。
 *
 * 冲突由系统按来源优先级和独立证据自动裁决；用户只保留查看和删除。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: '手动裁决已停用：冲突由系统自动裁决，用户只保留删除权。',
      code: 'manual_verdict_disabled',
    },
    { status: 410 },
  );
}
