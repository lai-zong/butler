/**
 * 定时任务只读视图。
 *
 * 数据来自两处，口径必须一致：
 *   · 调度器：到期判断、注册的任务、上次执行时间（启动时已从事件回放）；
 *   · 事件流：最近结果与历史（`schedule.triggered` 是唯一真相源，重启不丢）。
 *
 * 手动触发在 `/api/schedules/run`；本端点只提供只读视图。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import {
  DEFAULT_SCHEDULES,
  TASK_LABEL,
  type RunOutcome,
  type ScheduledTaskKind,
  type TaskSchedule,
} from '@/core/schedule/scheduler.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface TaskView {
  readonly kind: ScheduledTaskKind;
  readonly label: string;
  readonly schedule: string;
  readonly nextRunAt: number;
  readonly lastRunAt: number;
  readonly lastOutcome: RunOutcome | 'retrying' | null;
  readonly lastSummary: string | null;
  readonly lastError: string | null;
  readonly totalRuns: number;
  readonly failedRuns: number;
  readonly due: boolean;
  readonly costsTokens: boolean;
  readonly lastUsage: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

function scheduleLabel(s: TaskSchedule): string {
  if (s.hour < 0) return '每小时整点';
  const hh = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  if (s.weekday === undefined) return `每天 ${hh}`;
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `每${names[s.weekday] ?? `星期${s.weekday}`} ${hh}`;
}

function nextRunAt(s: TaskSchedule, now: number): number {
  if (s.hour < 0) {
    const d = new Date(now);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  const d = new Date(now);
  d.setHours(s.hour, s.minute, 0, 0);
  if (s.weekday === undefined) {
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  let diff = s.weekday - d.getDay();
  if (diff < 0) diff += 7;
  if (diff === 0 && d.getTime() <= now) diff = 7;
  d.setDate(d.getDate() + diff);
  return d.getTime();
}

function payloadOf(e: { readonly payload: unknown }): Record<string, unknown> {
  return typeof e.payload === 'object' && e.payload !== null
    ? (e.payload as Record<string, unknown>)
    : {};
}

function outcomeOf(e: { readonly payload: unknown }): RunOutcome | 'retrying' | null {
  const p = payloadOf(e);
  const o = p['outcome'];
  return o === 'succeeded' || o === 'failed' || o === 'skipped' || o === 'retrying' ? o : null;
}

function usageOf(p: Record<string, unknown>): { readonly inputTokens: number; readonly outputTokens: number } | null {
  const u = p['usage'];
  if (typeof u !== 'object' || u === null) return null;
  const r = u as Record<string, unknown>;
  const inputTokens = r['inputTokens'];
  const outputTokens = r['outputTokens'];
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null;
  return { inputTokens, outputTokens };
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const now = rt.clock.now();
  const scheduler = rt.activityRuntime.scheduler;
  const overview = scheduler.overview(now);
  const events = rt.bootstrapped.log.byType('schedule.triggered');

  const tasks: TaskView[] = overview.map((o) => {
    const mine = events.filter((e) => payloadOf(e)['kind'] === o.kind);
    const last = mine[mine.length - 1];
    const lastPayload = last !== undefined ? payloadOf(last) : {};
    const lastOutcome = last !== undefined ? outcomeOf(last) : null;
    const succeeded = mine.filter((e) => outcomeOf(e) === 'succeeded').length;
    const failed = mine.filter((e) => outcomeOf(e) === 'failed').length;
    const skipped = mine.filter((e) => outcomeOf(e) === 'skipped').length;
    return {
      kind: o.kind,
      label: o.label,
      schedule: scheduleLabel(DEFAULT_SCHEDULES[o.kind]),
      nextRunAt: nextRunAt(DEFAULT_SCHEDULES[o.kind], now),
      lastRunAt: last?.createdAt ?? o.lastRunAt,
      lastOutcome,
      lastSummary: typeof lastPayload['summary'] === 'string' ? lastPayload['summary'] : null,
      lastError:
        typeof lastPayload['error'] === 'string'
          ? lastPayload['error']
          : typeof lastPayload['detail'] === 'string'
            ? lastPayload['detail']
            : null,
      totalRuns: succeeded + failed + skipped,
      failedRuns: failed,
      due: o.due,
      costsTokens: o.costsTokens,
      lastUsage: usageOf(lastPayload),
    };
  });

  const recent = events
    .slice(-12)
    .reverse()
    .map((e) => {
      const p = payloadOf(e);
      const kind = typeof p['kind'] === 'string' ? (p['kind'] as ScheduledTaskKind) : null;
      return {
        seq: e.seq,
        at: e.createdAt,
        kind,
        label: kind !== null ? TASK_LABEL[kind] : '未知任务',
        outcome: outcomeOf(e),
        manual: p['manual'] === true,
        attempt: typeof p['attempt'] === 'number' ? p['attempt'] : null,
        summary:
          typeof p['summary'] === 'string'
            ? p['summary']
            : typeof p['error'] === 'string'
              ? p['error']
              : typeof p['detail'] === 'string'
                ? p['detail']
                : null,
        usage: usageOf(p),
      };
    });

  return NextResponse.json({ ok: true, now, running: scheduler.isRunning(), tasks, recent });
}
