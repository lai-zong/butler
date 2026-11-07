/** 用户定时任务：更新与删除。 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import type {
  UserTaskModelChoice,
  UserTaskPermission,
  UserTaskSchedule,
  UserTaskStatus,
} from '@/core/tasks/types.js';
import { assertWorkspaceDirectory } from '@/app/server/taskWorkspace.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function scheduleFrom(value: unknown): UserTaskSchedule | null {
  const v = record(value);
  const repeat = v['repeat'];
  if (repeat !== 'once' && repeat !== 'daily' && repeat !== 'weekly') return null;
  return {
    repeat,
    dueAt: typeof v['dueAt'] === 'number' && Number.isFinite(v['dueAt']) ? v['dueAt'] : null,
    timeOfDay: typeof v['timeOfDay'] === 'string' ? v['timeOfDay'] : null,
    weekday: typeof v['weekday'] === 'number' ? Math.round(v['weekday']) : null,
  };
}

function modelFrom(value: unknown): UserTaskModelChoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['profileId'] !== 'string' || typeof v['modelId'] !== 'string') return null;
  return {
    profileId: v['profileId'],
    modelId: v['modelId'],
    label: typeof v['label'] === 'string' ? v['label'] : v['modelId'],
  };
}

export async function PATCH(
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

  const rt = await getRuntime();
  const existing = await rt.userTasks.get(id);
  if (existing === null) return NextResponse.json({ error: '找不到定时任务' }, { status: 404 });

  const schedule = body['schedule'] !== undefined ? scheduleFrom(body['schedule']) : undefined;
  if (schedule === null) return NextResponse.json({ error: '定时规则不合法' }, { status: 400 });

  let workspace: string | null | undefined;
  if (existing.kind === 'work' && body['workspace'] !== undefined) {
    const raw = typeof body['workspace'] === 'string' ? body['workspace'].trim() : '';
    if (raw.length === 0) workspace = null;
    else {
      try {
        workspace = await assertWorkspaceDirectory(raw);
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }
  }

  const status = body['status'];
  const permission = body['permission'];
  try {
    const task = await rt.userTasks.update(id, {
      ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
      ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
      ...(schedule !== undefined ? { schedule } : {}),
      ...(status === 'active' || status === 'paused' || status === 'completed'
        ? { status: status as UserTaskStatus }
        : {}),
      ...(existing.kind === 'work' && typeof body['instruction'] === 'string'
        ? { instruction: body['instruction'] }
        : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(existing.kind === 'work'
        && (permission === 'read-only' || permission === 'workspace' || permission === 'full')
        ? { permission: permission as UserTaskPermission }
        : {}),
      ...(existing.kind === 'work' && body['model'] !== undefined
        ? { model: modelFrom(body['model']) }
        : {}),
      ...(existing.kind === 'work' && Array.isArray(body['files'])
        ? { files: body['files'].filter((v): v is string => typeof v === 'string') }
        : {}),
    });
    return NextResponse.json({ ok: true, task });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const rt = await getRuntime();
  try {
    await rt.userTasks.remove(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: message.includes('找不到') ? 404 : 400 });
  }
}
