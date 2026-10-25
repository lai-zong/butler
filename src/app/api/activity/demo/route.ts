/**
 * 行为观察 · 演示数据入口（后端 + 设置页已接入）
 *
 * POST /api/activity/demo
 *   { profile: 'office-dev' | 'student', days?: number }
 *
 * 设计依据：方案 §7.5
 *   · 只生成 ActivityRecord（source='demo'），不伪造结论；
 *   · 之后的聚合 / 规律 / 画像全部走真实代码路径；
 *   · 必须已有显式同意 + 采集开启，否则拒绝；
 *   · 设置页明确标注“模拟数据”，并展示 disclaimer。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime, DEFAULT_USER_ID } from '@/app/runtime';
import {
  DEMO_DISCLAIMER,
  DEMO_OFFICE_DEV,
  DEMO_STUDENT,
  generateDemoRecords,
} from '@/core/activity/demo.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_DAYS = 90;

interface Body {
  readonly profile?: unknown;
  readonly days?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const profileKey = typeof body.profile === 'string' ? body.profile.trim() : '';
  const profile = profileKey === 'office-dev'
    ? DEMO_OFFICE_DEV
    : profileKey === 'student'
      ? DEMO_STUDENT
      : null;
  if (profile === null) {
    return NextResponse.json(
      { error: "profile 只能是 'office-dev' 或 'student'" },
      { status: 400 },
    );
  }

  const daysRaw = body.days === undefined ? 30 : body.days;
  if (
    typeof daysRaw !== 'number' ||
    !Number.isFinite(daysRaw) ||
    !Number.isInteger(daysRaw) ||
    daysRaw < 1 ||
    daysRaw > MAX_DAYS
  ) {
    return NextResponse.json(
      { error: `days 必须是 1–${MAX_DAYS} 的整数` },
      { status: 400 },
    );
  }

  const rt = await getRuntime();
  const consent = rt.activityObserver.getConsent();
  if (!consent.granted) {
    return NextResponse.json(
      { error: '未同意采集，不能导入演示数据' },
      { status: 409 },
    );
  }
  if (!consent.enabled) {
    return NextResponse.json(
      { error: '采集已关闭，不能导入演示数据' },
      { status: 409 },
    );
  }

  const now = rt.clock.now();
  const records = generateDemoRecords({
    profile,
    userId: DEFAULT_USER_ID,
    days: daysRaw,
    endAt: now,
  });

  let recorded = 0;
  const byDay = new Map<number, (typeof records)[number][]>();
  for (const record of records) {
    const dayStart = new Date(record.startedAt);
    dayStart.setHours(0, 0, 0, 0);
    const key = dayStart.getTime();
    const bucket = byDay.get(key) ?? [];
    bucket.push(record);
    byDay.set(key, bucket);
  }

  /**
   * ★ 必须先按天聚合，再让 7 天原始保留期清掉旧记录。
   *
   * 若直接 observe 30 天再 aggregate(now)，purgeExpired 会先删掉 7 天前的
   * 原始记录，演示数据只剩最近 7 天 —— 这不是“加速”，是丢历史。
   * 这里逐日 observe → 聚合，把聚合结果先落到事件流；原始记录仍按
   * 正常保留期清理，长期留下的是聚合与规律。
   */
  for (const dayStart of [...byDay.keys()].sort((a, b) => a - b)) {
    for (const record of byDay.get(dayStart) ?? []) {
      const r = rt.activityObserver.observe({
        app: record.app,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        hadInput: record.hadInput,
        source: 'demo',
      });
      if (r.recorded) recorded += 1;
    }
    rt.activityObserver.aggregate(dayStart + 24 * 60 * 60 * 1000 - 1);
  }
  rt.activityObserver.aggregate(now);
  await rt.bootstrapped.log.flushPersistence();

  return NextResponse.json({
    ok: true,
    profile: profileKey,
    days: daysRaw,
    generated: records.length,
    recorded,
    disclaimer: DEMO_DISCLAIMER,
    source: 'demo',
  });
}
