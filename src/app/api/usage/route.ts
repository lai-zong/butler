/**
 * 使用节奏：读取与清除。
 *
 * 只统计本程序页面的节奏；不读取任务、工具、消息、记忆或审查内容。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { aggregateUsage, clampUsageDays } from '@/core/usage/aggregate.js';
import {
  clearUsage,
  loadUsagePings,
  loadUsageSettings,
} from '@/app/server/usageStore.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const days = clampUsageDays(Number(req.nextUrl.searchParams.get('days') ?? '7'));
  const [pings, settings] = await Promise.all([loadUsagePings(), loadUsageSettings()]);
  return NextResponse.json({
    ok: true,
    ...aggregateUsage(pings, {
      now: Date.now(),
      days,
      enabled: settings.enabled,
    }),
  });
}

/** 清除使用节奏统计；不删除会话、记忆、审查或其它事件。 */
export async function DELETE(): Promise<NextResponse> {
  await clearUsage();
  return NextResponse.json({ ok: true });
}
