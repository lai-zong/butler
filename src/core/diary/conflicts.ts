/**
 * 试行记忆的模糊冲突自动裁决。
 *
 * 只处理“可能冲突”的对：同 kind、同 memClass、文本有交集，且由固定
 * 记忆模型判断为 conflict。规则：
 *   · 硬约束永不参与；
 *   · 稳定 active 优先于试行；
 *   · 两条试行之间比较独立日期证据数和置信度；
 *   · 模型失败/unknown 不猜，保留原样并留事件。
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { ModelPort } from '../ports/model.js';
import type { MemoryStore } from '../memory/store.js';
import type { MemoryEntry } from '../memory/types.js';
import { DIARY_EVIDENCE_PREFIX } from '../memory/types.js';
import { similarity } from '../memory/sink.js';
import { judgeConflictWithModel } from '../memory/conflict.js';
import type { MemoryCandidate } from '../reflection/reflect.js';

export interface TrialConflictReviewResult {
  readonly checked: number;
  readonly conflicts: number;
  readonly resolved: number;
  readonly failed: number;
}

function diaryDays(entry: MemoryEntry): number {
  return new Set(
    entry.evidence
      .filter((e) => e.startsWith(DIARY_EVIDENCE_PREFIX))
      .map((e) => e.slice(DIARY_EVIDENCE_PREFIX.length)),
  ).size;
}

function asCandidate(entry: MemoryEntry): MemoryCandidate {
  return {
    id: entry.id,
    kind: entry.kind,
    content: entry.content,
    confidence: entry.confidence,
    evidence: entry.evidence,
    scope: { memClass: entry.memClass },
    rationale: '每日日记试行记忆',
    layer: 'butler',
    by: 'butler',
    createdAt: entry.createdAt,
  };
}

export async function reviewTrialConflicts(args: {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly store: MemoryStore;
  readonly userId: string;
  readonly maxPairs?: number;
}): Promise<TrialConflictReviewResult> {
  const maxPairs = args.maxPairs ?? 4;
  const trials = args.store
    .all()
    .filter(
      (e) =>
        e.lifecycle === 'candidate' &&
        e.memClass === 'global_shared' &&
        e.evidence.some((x) => x.startsWith(DIARY_EVIDENCE_PREFIX)),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  let checked = 0;
  let conflicts = 0;
  let resolved = 0;
  let failed = 0;

  for (const trial of trials) {
    if (checked >= maxPairs) break;
    const existing = args.store
      .all()
      .filter(
        (e) =>
          e.id !== trial.id &&
          e.memClass === 'global_shared' &&
          e.kind === trial.kind &&
          (e.lifecycle === 'active' || e.lifecycle === 'candidate') &&
          similarity(e.content, trial.content) >= 0.2,
      )
      .sort((a, b) => (a.lifecycle === 'active' ? -1 : 1) - (b.lifecycle === 'active' ? -1 : 1))
      .slice(0, 2)
      .find((e) => e.id !== trial.id);

    if (existing === undefined) continue;
    checked += 1;

    try {
      const judgement = await judgeConflictWithModel({
        model: args.model,
        candidate: asCandidate(trial),
        existing,
      });
      if (judgement.kind !== 'conflict') continue;
      conflicts += 1;

      const trialDays = diaryDays(trial);
      const existingDays = diaryDays(existing);
      const trialWins =
        existing.lifecycle !== 'active' &&
        (trialDays > existingDays ||
          (trialDays === existingDays && trial.confidence > existing.confidence));
      const winner = trialWins ? trial : existing;
      const loser = trialWins ? existing : trial;

      args.log.append({
        type: 'conflict.detected',
        actor: 'system',
        payload: {
          detector: 'model',
          source: 'dailyDiary',
          candidateId: trial.id,
          memoryId: trial.id,
          memoryIds: [existing.id],
          reason: judgement.reason,
          candidateContent: trial.content,
          existingContent: existing.content,
        },
        createdAt: args.clock.now(),
      });

      if (loser.memClass !== 'global_constraint') {
        args.store.archive(loser.id, `模糊冲突裁决：保留「${winner.content.slice(0, 40)}」`);
      }
      args.log.append({
        type: 'conflict.resolved',
        actor: 'system',
        payload: {
          source: 'dailyDiary',
          action: 'autoModel',
          candidateId: trial.id,
          memoryId: existing.id,
          winner: trialWins ? 'new' : 'existing',
          winnerId: winner.id,
          loserId: loser.id,
          reason: judgement.reason,
        },
        createdAt: args.clock.now(),
      });
      resolved += 1;
    } catch (err) {
      failed += 1;
      args.log.append({
        type: 'conflict.judgeFailed',
        actor: 'system',
        payload: {
          candidateId: trial.id,
          memoryId: existing.id,
          reason: err instanceof Error ? err.message.slice(0, 300) : '未知错误',
        },
        createdAt: args.clock.now(),
      });
    }
  }

  return { checked, conflicts, resolved, failed };
}
