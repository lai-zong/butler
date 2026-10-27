/**
 * 日记条目 → 记忆试行节点。
 *
 * ★ 日记本身不是记忆节点；只有通过来源校验的条目才会进入记忆库。
 * ★ 新条目一律先落为 candidate（试行），不等待人工审核。
 * ★ 同一内容在不同日期再次出现 → 补证据；两个独立日期后自动转正。
 * ★ 旧的人工待审候选没有 diary: 证据标记，不会被这里“顺手”转正。
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import { containsCredential } from '../tools/redact.js';
import type { MemoryStore } from '../memory/store.js';
import { isDuplicate } from '../memory/sink.js';
import {
  DIARY_EVIDENCE_PREFIX,
  DIARY_PROMOTION_CONFIDENCE,
  DIARY_PROMOTION_DAYS,
} from '../memory/types.js';
import type { DiaryEntry, DiaryExtractedItem } from './types.js';

export { DIARY_EVIDENCE_PREFIX };

export interface DiaryIngestResult {
  readonly created: readonly string[];
  readonly reinforced: readonly string[];
  readonly promoted: readonly string[];
  readonly skipped: number;
}

interface CandidateLike {
  readonly kind: string;
  readonly content: string;
  readonly scope: { readonly memClass: 'global_shared' };
}

function diaryDays(evidence: readonly string[]): Set<string> {
  const days = new Set<string>();
  for (const e of evidence) {
    if (e.startsWith(DIARY_EVIDENCE_PREFIX)) days.add(e.slice(DIARY_EVIDENCE_PREFIX.length));
  }
  return days;
}

function itemAsCandidate(item: DiaryExtractedItem): CandidateLike {
  return { kind: item.kind, content: item.content, scope: { memClass: 'global_shared' } };
}

function shouldPromote(evidence: readonly string[], confidence: number): boolean {
  return (
    confidence >= DIARY_PROMOTION_CONFIDENCE &&
    diaryDays(evidence).size >= DIARY_PROMOTION_DAYS
  );
}

export function ingestDiary(args: {
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly store: MemoryStore;
  readonly diary: DiaryEntry;
}): DiaryIngestResult {
  const created: string[] = [];
  const reinforced: string[] = [];
  const promoted: string[] = [];
  let skipped = 0;

  for (const item of args.diary.items) {
    if (
      [item.content, item.rationale, ...item.evidence, item.principle?.condition, item.principle?.action]
        .filter((s): s is string => typeof s === 'string')
        .some((s) => containsCredential(s))
    ) {
      args.log.append({
        type: 'memory.writeAttempted',
        actor: 'system',
        payload: {
          rejected: true,
          reason: 'credential_content',
          source: 'dailyDiary',
          diaryId: args.diary.id,
          itemId: item.id,
        },
        createdAt: args.clock.now(),
      });
      skipped += 1;
      continue;
    }

    const evidence = [...new Set([...item.evidence, `${DIARY_EVIDENCE_PREFIX}${args.diary.dayKey}`])];
    const existing = args.store
      .all()
      .find((entry) => isDuplicate(entry, itemAsCandidate(item)));

    if (existing) {
      // 硬约束不参与日记强化/合并。
      if (existing.memClass === 'global_constraint') {
        skipped += 1;
        continue;
      }
      // 旧的人工待审候选（没有 diary: 证据）不在这里自动转正。
      if (
        existing.lifecycle === 'candidate' &&
        !existing.evidence.some((e) => e.startsWith(DIARY_EVIDENCE_PREFIX))
      ) {
        skipped += 1;
        continue;
      }
      if (existing.lifecycle === 'dormant' || existing.lifecycle === 'archived') {
        skipped += 1;
        continue;
      }

      const r = args.store.reinforce(
        existing.id,
        evidence,
        item.confidence,
        `日记 ${args.diary.dayKey} 补充证据`,
      );
      if (!r.ok) {
        skipped += 1;
        continue;
      }
      reinforced.push(existing.id);

      const latest = args.store.get(existing.id);
      if (
        latest &&
        latest.lifecycle === 'candidate' &&
        shouldPromote(latest.evidence, latest.confidence)
      ) {
        const approved = args.store.review(
          { kind: 'butler', userId: args.diary.userId },
          latest.id,
          'approve',
          `试行期间获得 ${diaryDays(latest.evidence).size} 个独立日期的证据，自动转正`,
          {
            decidedBy: 'system',
            source: 'dailyDiary',
            sourceLabel: '每日日记',
            audit: 'probationPromotion',
          },
        );
        if (approved.ok) promoted.push(latest.id);
      }
      continue;
    }

    const res = args.store.create(
      { kind: 'butler', userId: args.diary.userId },
      {
        memClass: 'global_shared',
        kind: item.kind,
        content: item.content,
        confidence: item.confidence,
        evidence,
        lifecycle: 'candidate',
      },
    );
    if (!res.ok) {
      skipped += 1;
      continue;
    }
    created.push(res.entry.id);
    if (item.principle) {
      args.store.setPrincipleDetail(res.entry.id, item.principle);
    }
    args.log.append({
      type: 'principle.derived',
      actor: 'system',
      payload: {
        memoryId: res.entry.id,
        fromReflection: 'dailyDiary',
        rationale: item.rationale,
        diaryId: args.diary.id,
        itemId: item.id,
        audit: 'diaryCandidate',
      },
      createdAt: args.clock.now(),
    });
  }

  return { created, reinforced, promoted, skipped };
}
