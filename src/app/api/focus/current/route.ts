/**
 * 专注空间 · 设置当前安排。
 *
 * `{ "id": null }` 表示取消当前安排；id 必须是已存在的日程。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';

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

  const raw = body['id'];
  if (raw !== null && typeof raw !== 'string') {
    return NextResponse.json({ error: 'id 必须是日程 id 或 null' }, { status: 400 });
  }
  const id = raw === null ? null : raw.trim();
  if (id !== null && id.length === 0) {
    return NextResponse.json({ error: 'id 不能为空字符串' }, { status: 400 });
  }

  const rt = await getRuntime();
  try {
    const state = await rt.focusSchedules.setCurrent(id);
    return NextResponse.json({
      ok: true,
      now: rt.clock.now(),
      currentId: state.currentId,
      schedules: state.schedules,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: message.includes('找不到') ? 404 : 400 },
    );
  }
}
