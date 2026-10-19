/**
 * 行为观察的开关（界面入口）
 *
 * `GET  /api/observation` → 当前同意状态
 * `POST /api/observation` `{ granted?: boolean, enabled?: boolean }`
 *
 * ★★ 这个端点是 A10 唯一缺的**用户入口**：
 *   在此之前只能改 `.env.local` 再重启，而"同意"是法律意义上的**用户显式动作**，
 *   不该由改配置文件来冒充。
 *
 * ⚠️ 三条纪律：
 *   ① **默认关闭**，且没有任何"帮你打开"的路径
 *   ② 撤回同意会**同时清除已采集数据**（`revokeConsent` 的语义）
 *   ③ 状态落事件（`activity.sampled` 的 `action`），重启后由 `replayConsent` 重建
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { RETENTION_OPTIONS } from '@/core/activity/observe.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ObservationBody {
  readonly granted?: unknown;
  readonly enabled?: unknown;
  /** 原始记录保留天数（7 / 14 / 30 / 0） */
  readonly retentionDays?: unknown;
}

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const c = rt.activityObserver.getConsent();
  return NextResponse.json({
    granted: c.granted,
    enabled: c.enabled,
    grantedAt: c.grantedAt ?? null,
    retentionDays: c.retentionDays,
    recordedBlocks: rt.activityObserver.rawRecords().length,
    aggregates: rt.activityObserver.allAggregates().length,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: ObservationBody;
  try {
    body = (await req.json()) as ObservationBody;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const rt = await getRuntime();
  const observer = rt.activityObserver;

  let touched = false;

  if (typeof body.granted === 'boolean') {
    if (body.granted) observer.grantConsent();
    else observer.revokeConsent();
    touched = true;
  } else if (typeof body.enabled === 'boolean') {
    // 只有已经同意过才谈得上"开关采集"
    if (!observer.getConsent().granted) {
      return NextResponse.json(
        { error: '还没有同意采集，无法单独开关' },
        { status: 409 },
      );
    }
    if (body.enabled) observer.enable();
    else observer.disable();
    touched = true;
  }

  if (body.retentionDays !== undefined) {
    const days = body.retentionDays;
    if (
      typeof days !== 'number' ||
      !(RETENTION_OPTIONS as readonly number[]).includes(days)
    ) {
      return NextResponse.json(
        { error: `retentionDays 只能是 ${RETENTION_OPTIONS.join(' / ')}` },
        { status: 400 },
      );
    }
    observer.setRetentionDays(days);
    touched = true;
  }

  if (!touched) {
    return NextResponse.json(
      { error: '需要 granted / enabled（布尔值）或 retentionDays' },
      { status: 400 },
    );
  }

  const c = observer.getConsent();
  return NextResponse.json({
    ok: true,
    granted: c.granted,
    enabled: c.enabled,
    grantedAt: c.grantedAt ?? null,
    retentionDays: c.retentionDays,
    recordedBlocks: observer.rawRecords().length,
    aggregates: observer.allAggregates().length,
  });
}
