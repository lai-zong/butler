/** 用户定时任务动作：完成、稍后、立即运行、暂停/恢复。 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function POST(
  req: NextRequest,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = record(await req.json());
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const action = body['action'];
  const rt = await getRuntime();
  const task = await rt.userTasks.get(id);
  if (task === null) return NextResponse.json({ error: '找不到定时任务' }, { status: 404 });

  try {
    if (action === 'complete') {
      return NextResponse.json({ ok: true, task: await rt.userTasks.complete(id) });
    }
    if (action === 'snooze') {
      const minutes = typeof body['minutes'] === 'number' ? body['minutes'] : 10;
      return NextResponse.json({ ok: true, task: await rt.userTasks.snooze(id, minutes) });
    }
    if (action === 'pause') {
      return NextResponse.json({ ok: true, task: await rt.userTasks.setStatus(id, 'paused') });
    }
    if (action === 'resume') {
      return NextResponse.json({ ok: true, task: await rt.userTasks.setStatus(id, 'active') });
    }
    if (action === 'run') {
      if (task.kind !== 'work') {
        return NextResponse.json({ error: '提醒不能立即运行' }, { status: 400 });
      }
      const result = await rt.userTasks.runNow(id);
      return NextResponse.json({ ok: result.outcome === 'succeeded', result });
    }
    return NextResponse.json({ error: '未知动作' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
