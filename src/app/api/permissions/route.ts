/** C5 三档权限 + 确认开关：读取与切换；每次切换立即持久化。 */

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
    confirmActions: rt.permissionPolicy.confirmActions,
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

  const record =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const modeRaw = record['mode'];
  const confirmRaw = record['confirmActions'];

  if (modeRaw === undefined && confirmRaw === undefined) {
    return NextResponse.json(
      { error: '至少提供 mode 或 confirmActions' },
      { status: 400 },
    );
  }
  if (modeRaw !== undefined && !isPermissionMode(modeRaw)) {
    return NextResponse.json(
      { error: 'mode 只能是 view / workspace / full' },
      { status: 400 },
    );
  }
  if (confirmRaw !== undefined && typeof confirmRaw !== 'boolean') {
    return NextResponse.json(
      { error: 'confirmActions 必须是布尔值' },
      { status: 400 },
    );
  }

  const rt = await getRuntime();
  await rt.setPermissionSettings({
    ...(modeRaw !== undefined ? { mode: modeRaw } : {}),
    ...(confirmRaw !== undefined ? { confirmActions: confirmRaw } : {}),
  });

  return NextResponse.json({
    ok: true,
    mode: rt.permissionPolicy.mode ?? null,
    confirmActions: rt.permissionPolicy.confirmActions,
  });
}
