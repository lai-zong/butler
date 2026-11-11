/** 使用节奏开关：只控制本程序内的使用心跳，不影响对话与工具权限。 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { loadUsageSettings, saveUsageSettings } from '@/app/server/usageStore.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const settings = await loadUsageSettings();
  return NextResponse.json({ ok: true, ...settings });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const enabled =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['enabled']
      : undefined;
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled 必须是布尔值' }, { status: 400 });
  }
  await saveUsageSettings({ enabled });
  return NextResponse.json({ ok: true, enabled });
}
