/**
 * 手动执行一个内置定时任务。
 *
 * D-44 已提供单飞与超时；本端点只负责参数校验与把结果如实返回。
 * 手动触发按方案不占每日额度，但仍会真实调用任务处理器。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import {
  DEFAULT_SCHEDULES,
  TASK_LABEL,
  type ScheduledTaskKind,
} from '@/core/schedule/scheduler.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const KINDS: readonly ScheduledTaskKind[] = [
  'dailyDiary',
  'dailyReflection',
  'weeklyReview',
  'proactiveCheck',
  'activityAggregate',
];

interface Body {
  readonly kind?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const kind = body.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind as ScheduledTaskKind)) {
    return NextResponse.json(
      { error: `kind 只能是 ${KINDS.join(' / ')}` },
      { status: 400 },
    );
  }

  const rt = await getRuntime();
  const scheduler = rt.activityRuntime.scheduler;
  if (scheduler.isRunning()) {
    return NextResponse.json(
      { error: '已有定时任务在运行；单飞期间不启动第二份' },
      { status: 409 },
    );
  }

  const run = await scheduler.runNow(kind as ScheduledTaskKind);
  if (run === null) {
    return NextResponse.json(
      { error: '任务未注册或当前不可运行' },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: run.outcome === 'succeeded',
    kind,
    label: TASK_LABEL[kind as ScheduledTaskKind],
    schedule: DEFAULT_SCHEDULES[kind as ScheduledTaskKind],
    run: {
      id: run.id,
      outcome: run.outcome,
      manual: run.manual,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      note: run.note ?? null,
      summary: run.summary ?? null,
    },
  });
}
