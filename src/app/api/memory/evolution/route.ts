/**
 * 手动调权 / 唤醒 / 归档已停用。
 *
 * 生命周期由适应度和每日演化自动决定；用户只保留查看和删除。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: '手动演化已停用：生命周期由系统自动演化，用户只保留删除权。',
      code: 'manual_evolution_disabled',
    },
    { status: 410 },
  );
}
