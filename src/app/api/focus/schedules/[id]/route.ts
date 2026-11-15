/**
 * 专注空间 · 单条日程的修改与删除。
 *
 * ★ 删除当前安排时，服务端会同时把 currentId 清空；
 *   界面不需要再补发一次「取消当前」。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import type { FocusScheduleUpdateInput } from '@/core/focus/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function statusFor(message: string): number {
  return message.includes('找不到') ? 404 : 400;
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = record(await req.json());
  } catch {
    return fail('请求体不是合法 JSON');
  }

  const patch: {
    title?: string;
    note?: string;
    startAt?: number;
    endAt?: number;
    remind?: boolean;
  } = {};
  if (body['title'] !== undefined) {
    if (typeof body['title'] !== 'string') return fail('标题必须是文本');
    patch.title = body['title'];
  }
  if (body['note'] !== undefined) {
    if (typeof body['note'] !== 'string') return fail('备注必须是文本');
    patch.note = body['note'];
  }
  if (body['startAt'] !== undefined) {
    if (typeof body['startAt'] !== 'number' || !Number.isFinite(body['startAt'])) {
      return fail('开始时间不合法');
    }
    patch.startAt = body['startAt'];
  }
  if (body['endAt'] !== undefined) {
    if (typeof body['endAt'] !== 'number' || !Number.isFinite(body['endAt'])) {
      return fail('结束时间不合法');
    }
    patch.endAt = body['endAt'];
  }
  if (body['remind'] !== undefined) {
    if (typeof body['remind'] !== 'boolean') return fail('提醒开关必须是布尔值');
    patch.remind = body['remind'];
  }

  const rt = await getRuntime();
  try {
    const state = await rt.focusSchedules.update(
      id,
      patch as FocusScheduleUpdateInput,
    );
    return NextResponse.json({
      ok: true,
      now: rt.clock.now(),
      currentId: state.currentId,
      schedules: state.schedules,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, statusFor(message));
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const rt = await getRuntime();
  try {
    const state = await rt.focusSchedules.remove(id);
    return NextResponse.json({
      ok: true,
      now: rt.clock.now(),
      currentId: state.currentId,
      schedules: state.schedules,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, statusFor(message));
  }
}
