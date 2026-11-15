/**
 * 专注空间 · 日程列表与新建。
 *
 * ★ 这是独立 API：读写 `focus-schedules.json`，
 *   不经过 `/api/tasks` 的 UserTaskService，也不触发任何 AI 执行。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import type { FocusScheduleCreateInput } from '@/core/focus/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const state = await rt.focusSchedules.snapshot();
  return NextResponse.json({
    ok: true,
    now: rt.clock.now(),
    currentId: state.currentId,
    schedules: state.schedules,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = record(await req.json());
  } catch {
    return fail('请求体不是合法 JSON');
  }

  if (typeof body['title'] !== 'string') return fail('标题必须是文本');
  if (typeof body['startAt'] !== 'number' || !Number.isFinite(body['startAt'])) {
    return fail('开始时间不合法');
  }
  if (typeof body['endAt'] !== 'number' || !Number.isFinite(body['endAt'])) {
    return fail('结束时间不合法');
  }

  const input: FocusScheduleCreateInput = {
    title: body['title'],
    startAt: body['startAt'],
    endAt: body['endAt'],
    ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
    ...(typeof body['remind'] === 'boolean' ? { remind: body['remind'] } : {}),
  };

  const rt = await getRuntime();
  try {
    const state = await rt.focusSchedules.create(input);
    return NextResponse.json({
      ok: true,
      now: rt.clock.now(),
      currentId: state.currentId,
      schedules: state.schedules,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
