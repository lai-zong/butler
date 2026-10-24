/**
 * 行为观察明细（设置 → 隐私与行为观察）。
 *
 * GET  : 原始记录 / 聚合 / 规律 / 同意状态
 * POST : { id } 删除单条原始记录；{} 清空原始 + 聚合 + 规律
 *
 * ★ 数据来自事件回放后的 ActivityObserver，不是另存一份。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { invalidatePattern } from '@/core/activity/patterns.js';
import { CATEGORY_LABEL, type TemporalPattern } from '@/core/activity/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface DeleteBody {
  readonly id?: unknown;
}

function activePatterns(log: { all: () => readonly { type: string; payload: unknown; createdAt: number }[] }): TemporalPattern[] {
  const patterns = new Map<string, TemporalPattern>();
  for (const e of log.all()) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === 'pattern.derived') {
      if (
        typeof p['patternId'] !== 'string' ||
        typeof p['kind'] !== 'string' ||
        typeof p['pattern'] !== 'string' ||
        typeof p['confidence'] !== 'number' ||
        typeof p['observedDays'] !== 'number' ||
        typeof p['appliesTo'] !== 'string'
      ) {
        continue;
      }
      patterns.set(p['patternId'], {
        id: p['patternId'],
        userId: 'local',
        kind: p['kind'] as TemporalPattern['kind'],
        pattern: p['pattern'],
        confidence: p['confidence'],
        observedDays: p['observedDays'],
        appliesTo: p['appliesTo'] as TemporalPattern['appliesTo'],
        evidence: [],
        createdAt: e.createdAt,
      });
    } else if (e.type === 'pattern.invalidated' && typeof p['patternId'] === 'string') {
      patterns.delete(p['patternId']);
    }
  }
  return [...patterns.values()];
}

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const now = rt.clock.now();
  const observer = rt.activityObserver;
  const consent = observer.getConsent();

  return NextResponse.json({
    ok: true,
    now,
    consent: {
      granted: consent.granted,
      enabled: consent.enabled,
      grantedAt: consent.grantedAt ?? null,
      retentionDays: consent.retentionDays,
    },
    raw: observer.rawRecords(now).map((r) => ({
      id: r.id,
      app: r.app,
      category: r.category,
      categoryLabel: CATEGORY_LABEL[r.category],
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationMs: r.durationMs,
      hadInput: r.hadInput,
      source: r.source,
    })),
    aggregates: observer.allAggregates(),
    patterns: activePatterns(rt.bootstrapped.log),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: DeleteBody = {};
  try {
    const parsed = (await req.json()) as unknown;
    if (typeof parsed === 'object' && parsed !== null) body = parsed as DeleteBody;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const rt = await getRuntime();
  const observer = rt.activityObserver;
  const id = typeof body.id === 'string' ? body.id.trim() : '';

  if (id.length > 0) {
    const ok = observer.deleteRecord(id);
    return NextResponse.json(
      { ok, deletedRecords: ok ? 1 : 0 },
      { status: ok ? 200 : 404 },
    );
  }

  const patterns = activePatterns(rt.bootstrapped.log);
  for (const pattern of patterns) {
    invalidatePattern({
      log: rt.bootstrapped.log,
      clock: rt.clock,
      pattern,
      reason: '用户清空行为观察数据',
    });
  }
  const r = observer.deleteAll(rt.clock.now());
  return NextResponse.json({
    ok: true,
    deletedRecords: r.records,
    deletedAggregates: r.aggregates,
    deletedPatterns: patterns.length,
  });
}
