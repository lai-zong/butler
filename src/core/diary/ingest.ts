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
import { similarity } from '../memory/sink.js';
import { explicitNegationConflict } from '../memory/conflict.js';
import {
  DIARY_EVIDENCE_PREFIX,
  DIARY_PROMOTION_CONFIDENCE,
  DIARY_PROMOTION_DAYS,
} from '../memory/types.js';
import type { DiaryEntry } from './types.js';

export { DIARY_EVIDENCE_PREFIX };

export interface DiaryIngestResult {
  readonly created: readonly string[];
  readonly reinforced: readonly string[];
  readonly promoted: readonly string[];
  readonly skipped: number;
}

function diaryDays(evidence: readonly string[]): Set<string> {
  const days = new Set<string>();
  for (const e of evidence) {
    if (e.startsWith(DIARY_EVIDENCE_PREFIX)) days.add(e.slice(DIARY_EVIDENCE_PREFIX.length));
  }
  return days;
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

    // 先处理可证明的矛盾（显式否定），再走去重。
    // 其它“主题相近但可同时成立”的情况不在这里硬判冲突。
    const conflict = args.store
      .all()
      .filter(
        (entry) =>
          (entry.memClass === 'global_shared' || entry.memClass === 'global_constraint') &&
          entry.kind === item.kind &&
          entry.lifecycle !== 'archived' &&
          entry.content !== item.content,
      )
      .find((entry) => explicitNegationConflict(item.content, entry.content) !== null);
    if (conflict) {
      const newDays = diaryDays(evidence).size;
      const oldDays = diaryDays(conflict.evidence).size;
      const oldWins =
        conflict.memClass === 'global_constraint' ||
        conflict.lifecycle === 'active' ||
        (conflict.lifecycle === 'candidate' &&
          !conflict.evidence.some((e) => e.startsWith(DIARY_EVIDENCE_PREFIX))) ||
        oldDays > newDays ||
        (oldDays === newDays && conflict.confidence >= item.confidence);
      args.log.append({
        type: 'conflict.detected',
        actor: 'system',
        payload: {
          detector: 'explicit',
          source: 'dailyDiary',
          candidateId: item.id,
          memoryId: conflict.id,
          candidateContent: item.content,
          existingContent: conflict.content,
          reason: '显式否定：两条陈述除否定词外相同',
        },
        createdAt: args.clock.now(),
      });
      if (oldWins) {
        args.log.append({
          type: 'conflict.resolved',
          actor: 'system',
          payload: {
            source: 'dailyDiary',
            candidateId: item.id,
            memoryId: conflict.id,
            winner: 'existing',
            reason: '既有记忆优先级更高（硬约束/稳定记忆/更多独立证据）',
          },
          createdAt: args.clock.now(),
        });
        skipped += 1;
        continue;
      }
      if (conflict.lifecycle === 'candidate') {
        args.store.archive(conflict.id, '被更新的试行证据取代，归档保留');
      }
      args.log.append({
        type: 'conflict.resolved',
        actor: 'system',
        payload: {
          source: 'dailyDiary',
          candidateId: item.id,
          memoryId: conflict.id,
          winner: 'new',
          reason: '新试行条目拥有更多独立证据或更高置信度',
        },
        createdAt: args.clock.now(),
      });
    }

    const existing = args.store
      .all()
      .find(
        (entry) =>
          entry.id !== conflict?.id &&
          entry.kind === item.kind &&
          (entry.lifecycle === 'active' ||
            entry.lifecycle === 'candidate' ||
            entry.lifecycle === 'dormant') &&
          // 日记是自然语言复述，同一条记忆换一种说法很常见；
          // 这里比普通候选去重略宽松，但仍要求同 kind。
          similarity(entry.content, item.content) >= 0.62,
      );

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
      if (existing.lifecycle === 'dormant') {
        args.store.revive(existing.id, `日记 ${args.diary.dayKey} 再次出现，唤回休眠记忆`);
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
