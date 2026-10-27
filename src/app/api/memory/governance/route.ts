/**
 * 自主记忆治理概览 —— 只读。
 *
 * 给审计/演化页面提供：日记数量、试行/稳定分布、转正/归档/冲突/墓碑
 * 以及最近治理事件。不是新的真相源，全部从记忆库和事件流汇总。
 */

import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { DIARY_EVIDENCE_PREFIX } from '@/core/memory/types.js';
import { EVENT_FAMILY_LABEL, eventLabel } from '@/app/server/uiData.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const GOVERNANCE_TYPES = new Set([
  'diary.created',
  'diary.failed',
  'memory.candidate',
  'memory.approved',
  'memory.archived',
  'memory.revised',
  'conflict.detected',
  'conflict.resolved',
  'intervention.forgotten',
  'memory.merged',
]);

interface GovernanceEvent {
  readonly seq: number;
  readonly at: number;
  readonly type: string;
  readonly label: string;
  readonly familyLabel: string;
  readonly actor: string;
  readonly summary: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const store = rt.bootstrapped.memory;
  const entries = store.all();
  const diaries = rt.diary.all();

  let trial = 0;
  let legacyPending = 0;
  for (const e of entries) {
    if (e.lifecycle !== 'candidate') continue;
    if (e.evidence.some((x) => x.startsWith(DIARY_EVIDENCE_PREFIX))) trial += 1;
    else legacyPending += 1;
  }

  let promoted = 0;
  let trialArchived = 0;
  let conflicts = 0;
  let resolved = 0;
  let tombstones = 0;
  let diaryFailed = 0;
  const recent: GovernanceEvent[] = [];

  for (const event of rt.bootstrapped.log.all()) {
    if (!GOVERNANCE_TYPES.has(event.type)) continue;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === 'memory.approved') {
      const audit = str(p['audit']);
      if (audit === 'probationPromotion') promoted += 1;
    } else if (event.type === 'memory.archived') {
      if (str(p['reason']).includes('试行')) trialArchived += 1;
    } else if (event.type === 'conflict.detected') {
      conflicts += 1;
    } else if (event.type === 'conflict.resolved') {
      resolved += 1;
    } else if (event.type === 'intervention.forgotten') {
      if (p['hardConstraint'] === true) tombstones += 1;
    } else if (event.type === 'diary.failed') {
      diaryFailed += 1;
    }

    if (
      event.type === 'diary.created' ||
      event.type === 'memory.approved' ||
      event.type === 'memory.archived' ||
      event.type === 'conflict.resolved' ||
      event.type === 'intervention.forgotten'
    ) {
      recent.push({
        seq: event.seq,
        at: event.createdAt,
        type: event.type,
        label: eventLabel(event.type),
        familyLabel: EVENT_FAMILY_LABEL[event.type === 'diary.created' ? 'diary' : 'memoryLifecycle'] ?? '',
        actor: event.actor,
        summary:
          event.type === 'diary.created'
            ? str((p['diary'] as Record<string, unknown> | undefined)?.['dayKey'])
            : str(p['reason']) || str(p['memoryId']),
      });
    }
  }

  recent.sort((a, b) => b.at - a.at || b.seq - a.seq);

  return NextResponse.json({
    ok: true,
    counts: {
      diaries: diaries.length,
      diaryFailed,
      trial,
      legacyPending,
      active: entries.filter((e) => e.lifecycle === 'active').length,
      dormant: entries.filter((e) => e.lifecycle === 'dormant').length,
      archived: entries.filter((e) => e.lifecycle === 'archived').length,
      promoted,
      trialArchived,
      conflicts,
      resolved,
      tombstones,
    },
    recent: recent.slice(0, 20),
  });
}
