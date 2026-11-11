/**
 * 使用节奏心跳。
 *
 * 前端只在页面可见时上报；服务端只保存页面、时间与 active 标记。
 * `at` 由服务端生成，避免客户端伪造时间线。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isUsagePage, type UsagePage } from '@/core/usage/aggregate.js';
import {
  appendUsagePing,
  loadUsageSettings,
} from '@/app/server/usageStore.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = record(await req.json());
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const pageRaw = body['page'];
  if (!isUsagePage(pageRaw)) {
    return NextResponse.json(
      { error: 'page 只能是 chat / tasks / settings / memory / growth' },
      { status: 400 },
    );
  }

  const settings = await loadUsageSettings();
  if (!settings.enabled) {
    return NextResponse.json({ ok: true, recorded: false, reason: '使用记录已关闭' });
  }

  const page: UsagePage = pageRaw;
  const active = body['active'] !== false;
  const sessionId =
    typeof body['sessionId'] === 'string' && body['sessionId'].trim().length > 0
      ? body['sessionId'].trim().slice(0, 120)
      : undefined;

  await appendUsagePing({
    at: Date.now(),
    page,
    active,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });

  return NextResponse.json({ ok: true, recorded: true });
}
