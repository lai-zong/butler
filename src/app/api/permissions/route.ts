/** C5 三档权限设置：读取与切换；切换立即持久化。 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { isPermissionMode } from '@/app/server/permissionStore.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  return NextResponse.json({
    ok: true,
    mode: rt.permissionPolicy.mode ?? null,
    legacy: rt.permissionPolicy.mode === undefined,
  });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const mode = (body as { mode?: unknown } | null)?.mode;
  if (!isPermissionMode(mode)) {
    return NextResponse.json(
      { error: 'mode 只能是 view / workspace / full' },
      { status: 400 },
    );
  }
  const rt = await getRuntime();
  await rt.setPermissionMode(mode);
  return NextResponse.json({ ok: true, mode });
}
