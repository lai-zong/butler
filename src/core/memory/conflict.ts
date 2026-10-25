/**
 * 记忆冲突检测 —— 只发现，不裁决
 *
 * 设计依据：docs/design/conflict-detection-design-2026-10-25.md
 *
 * ★★ 三条不可退让的纪律：
 *
 *   ① **相似不是矛盾**
 *      “喜欢安静”和“喜欢热闹”可以在不同场景同时成立；
 *      任何“相似度 > 阈值 → 冲突”都不是证据。
 *
 *   ② **只做 review**
 *      检测器只把候选标记为 needsReview；谁对谁错由用户裁决。
 *
 *   ③ **不确定 ≠ 没有冲突**
 *      模型失败/返回 unknown 时不能自动放行；保留原准入策略并留审计。
 *
 * 本模块只产生冲突关系；`sinkAndAdmit` 负责把关系喂给
 * `decideAdmission()` 并记录 `conflict.detected`。
 */

import { z } from 'zod';

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { ModelPort } from '../ports/model.js';
import { msg } from '../ports/model.js';
import type { MemoryCandidate } from '../reflection/reflect.js';
import { decideAdmission, inferSource } from './admission.js';
import type { MemoryStore } from './store.js';
import type { MemoryEntry } from './types.js';

export type ConflictDetectionMode = 'off' | 'review';

export interface DetectedConflict {
  readonly memoryId: string;
  readonly reason: string;
  readonly detector: 'explicit' | 'model';
}

export interface ConflictDetectionResult {
  readonly byCandidate: ReadonlyMap<string, readonly DetectedConflict[]>;
  /** 实际比较过的候选×既有记忆对数 */
  readonly checked: number;
  readonly modelCalls: number;
  readonly modelErrors: number;
}

const MAX_EXISTING = 8;
const MAX_MODEL_CALLS = 24;

/**
 * 显式否定冲突（确定性、可解释）。
 *
 * 只处理“同一句话，其中一句带否定”的可证明形态：
 *   “对花生过敏” / “对花生不过敏”
 *   “喜欢安静” / “不喜欢安静”
 *
 * ⚠️ 刻意**不**处理“安静 vs 热闹”这类反义词：
 *    它们可能在不同场景同时成立，不能证明矛盾。
 */
export function explicitNegationConflict(
  a: string,
  b: string,
): { readonly reason: string } | null {
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[\s，。！？、,.!?;；:："'“”‘’()（）]/g, '');
  const skipCompound = (s: string): boolean =>
    /不同|不错|不少|不断|不仅|不论|不管|不得不|未来|非常/.test(s);
  const hasNegation = (s: string): boolean => /没有|不|没|未|not\b|no\b/.test(s);
  const stripNegation = (s: string): string => s.replace(/没有|不|没|未|not|no/g, '');

  if (skipCompound(a) || skipCompound(b)) return null;
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 || nb.length === 0 || na === nb) return null;
  if (hasNegation(na) === hasNegation(nb)) return null;
  if (stripNegation(na) !== stripNegation(nb)) return null;

  return {
    reason: '显式否定：两条陈述除否定词外相同，不能同时为真。',
  };
}

/**
 * 只比较同类别、同类型、同领域的活跃记忆。
 *
 * 跳过 sensitive / global_constraint：
 *   - 敏感域涉及授权，不应被自动比较；
 *   - 硬约束不允许被“投票降权”。
 */
export function conflictPool(
  candidate: MemoryCandidate,
  store: MemoryStore,
): readonly MemoryEntry[] {
  if (candidate.kind === 'summary') return [];
  if (candidate.scope.memClass === 'sensitive' || candidate.scope.memClass === 'global_constraint') {
    return [];
  }
  return store
    .all()
    .filter(
      (e) =>
        e.lifecycle === 'active' &&
        e.memClass === candidate.scope.memClass &&
        e.kind === candidate.kind &&
        e.memClass !== 'sensitive' &&
        e.memClass !== 'global_constraint' &&
        e.domain === candidate.scope.domain,
    )
    .sort((x, y) => y.updatedAt - x.updatedAt || y.hitCount - x.hitCount)
    .slice(0, MAX_EXISTING);
}

const conflictSchema = z
  .object({
    kind: z.enum(['conflict', 'noConflict', 'unknown']),
    reason: z.string().min(1).max(600),
    candidateQuote: z.string().min(1).max(300).optional(),
    existingQuote: z.string().min(1).max(300).optional(),
  })
  .refine(
    (v) =>
      v.kind !== 'conflict' ||
      (v.candidateQuote !== undefined && v.existingQuote !== undefined),
    { message: '判定为 conflict 时必须同时引用两条陈述的具体片段' },
  );

export type ConflictJudgement = z.infer<typeof conflictSchema>;

const CONFLICT_SYSTEM = `你是记忆冲突复核器，只做一件事：判断两条记忆是否“不能同时为真”。

规则（必须严格执行）：
1. 只有两条陈述在**同一时间、同一场景、同一对象**下不能同时为真，才返回 conflict。
2. 仅仅内容相似、主题相近，不构成冲突；不能因为相似就判冲突。
3. 如果一条陈述带有时间、场景、同行人、条件限定，而另一条没有，返回 unknown。
4. 如果两条可以同时成立（例如不同场合的偏好），返回 noConflict 或 unknown。
5. 判定为 conflict 时，必须在 candidateQuote 和 existingQuote 中分别引用两条原文的具体片段。
6. 不判断应该保留哪一条；不输出裁决建议。

只输出 JSON，不要输出其它文字。`;

/** 单次模型判断；失败由调用方记录，不在这里吞掉。 */
export async function judgeConflictWithModel(args: {
  readonly model: ModelPort;
  readonly candidate: MemoryCandidate;
  readonly existing: MemoryEntry;
}): Promise<ConflictJudgement> {
  const result = await args.model.completeStructured({
    purpose: 'conflict',
    schema: conflictSchema,
    schemaName: 'ConflictJudgement',
    temperature: 0,
    thinking: 'disabled',
    maxOutputTokens: 600,
    messages: [
      msg.system(CONFLICT_SYSTEM),
      msg.user(
        JSON.stringify(
          {
            candidate: {
              kind: args.candidate.kind,
              memClass: args.candidate.scope.memClass,
              domain: args.candidate.scope.domain ?? null,
              content: args.candidate.content,
            },
            existing: {
              kind: args.existing.kind,
              memClass: args.existing.memClass,
              domain: args.existing.domain ?? null,
              content: args.existing.content,
            },
          },
          null,
          2,
        ),
      ),
    ],
  });
  return result.value;
}

/**
 * 检测一批候选中“本来会自主生效”的冲突。
 *
 * 只对 `decideAdmission` 原本会 autoApproved 的候选跑检测；
 * 已经 needsReview 的候选不需要再花成本。
 */
export async function detectConflicts(args: {
  readonly mode: ConflictDetectionMode;
  readonly store: MemoryStore;
  readonly candidates: readonly MemoryCandidate[];
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly model?: ModelPort;
}): Promise<ConflictDetectionResult> {
  const empty: ConflictDetectionResult = {
    byCandidate: new Map(),
    checked: 0,
    modelCalls: 0,
    modelErrors: 0,
  };
  if (args.mode === 'off' || args.candidates.length === 0) return empty;

  const byCandidate = new Map<string, readonly DetectedConflict[]>();
  let checked = 0;
  let modelCalls = 0;
  let modelErrors = 0;

  for (const candidate of args.candidates) {
    const source = inferSource(candidate);
    const base = decideAdmission({ candidate, source });
    if (base.admission !== 'autoApproved') continue;

    const pool = conflictPool(candidate, args.store);
    if (pool.length === 0) continue;

    const found: DetectedConflict[] = [];
    for (const existing of pool) {
      checked += 1;

      const explicit = explicitNegationConflict(candidate.content, existing.content);
      if (explicit !== null) {
        found.push({
          memoryId: existing.id,
          reason: explicit.reason,
          detector: 'explicit',
        });
        break;
      }

      if (args.model === undefined || modelCalls >= MAX_MODEL_CALLS) continue;
      modelCalls += 1;
      try {
        const judgement = await judgeConflictWithModel({
          model: args.model,
          candidate,
          existing,
        });
        if (judgement.kind === 'conflict') {
          found.push({
            memoryId: existing.id,
            reason: judgement.reason,
            detector: 'model',
          });
          break;
        }
      } catch (err) {
        modelErrors += 1;
        args.log.append({
          type: 'conflict.judgeFailed',
          actor: 'system',
          payload: {
            candidateId: candidate.id,
            memoryId: existing.id,
            reason: err instanceof Error ? err.message.slice(0, 300) : '未知错误',
          },
          createdAt: args.clock.now(),
        });
      }
    }

    if (found.length > 0) byCandidate.set(candidate.id, found);
  }

  return { byCandidate, checked, modelCalls, modelErrors };
}
