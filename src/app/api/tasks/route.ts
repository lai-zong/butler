/** 用户定时任务：列表与创建。 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import type {
  UserTask,
  UserTaskCreateInput,
  UserTaskModelChoice,
  UserTaskPermission,
  UserTaskSchedule,
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

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const tasks = await rt.userTasks.list();
  return NextResponse.json({ ok: true, now: rt.clock.now(), tasks });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = record(await req.json());
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const kind = body['kind'];
  if (kind !== 'reminder' && kind !== 'work') {
    return NextResponse.json({ error: 'kind 只能是 reminder / work' }, { status: 400 });
  }
  const schedule = scheduleFrom(body['schedule']);
  if (schedule === null) return NextResponse.json({ error: '定时规则不合法' }, { status: 400 });

  const workspaceRaw = typeof body['workspace'] === 'string' ? body['workspace'].trim() : '';
  let workspace: string | null = null;
  if (kind === 'work' && workspaceRaw.length > 0) {
    try {
      workspace = await assertWorkspaceDirectory(workspaceRaw);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  }

  const permission = body['permission'];
  const input: UserTaskCreateInput = {
    kind,
    title: typeof body['title'] === 'string' ? body['title'] : '',
    note: typeof body['note'] === 'string' ? body['note'] : '',
    schedule,
    ...(body['status'] === 'paused' ? { status: 'paused' as const } : {}),
    ...(kind === 'work'
      ? {
          instruction: typeof body['instruction'] === 'string' ? body['instruction'] : '',
          workspace,
          ...(permission === 'read-only' || permission === 'workspace' || permission === 'full'
            ? { permission: permission as UserTaskPermission }
            : {}),
          model: modelFrom(body['model']),
          files: Array.isArray(body['files'])
            ? body['files'].filter((v): v is string => typeof v === 'string')
            : [],
        }
      : {}),
  };

  const rt = await getRuntime();
  try {
    const task = await rt.userTasks.create(input);
    return NextResponse.json({ ok: true, task }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

export type { UserTask };
