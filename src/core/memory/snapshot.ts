/**
 * 记忆状态快照 —— 供事件携带"可重建的完整状态"
 *
 * 设计依据：方案 § 4.1（事件是唯一真相源）
 *
 * ★ 为什么单独成文件：
 *   `store.ts` 与 `evolution.ts` 都需要它 ——
 *   放进任一个都会让另一个产生依赖（evolution 依赖 store，反向依赖成环）。
 *
 * ★ 为什么事件里要带**完整状态**而不只是"变了什么"：
 *   重放器必须精确恢复到那一刻。只记 delta 时，任何一次漏记都会让
 *   重放出的状态与真实状态**悄悄分叉** —— 而分叉是查不出来的
 *   （没有任何地方会报错，`stateHashOf` 能验出分叉，但前提是事件里
 *    有足够信息重建）。
 *
 * ⚠️ 维护约定：`MemoryEntry` 新增任何**可影响状态**的字段时，
 *    这里与 `memory.created` 的 entry 都要同步加。
 *    漏加的后果不是报错，而是重放后字段悄悄丢失。
 */

import type { MemoryEntry } from './types.js';

/**
 * 把一条记忆压成可重建的完整状态。
 *
 * ⚠️ 与 `MemoryEntry` 的字段集保持一致。
 *    可选字段统一用 `null` 而不是省略 —— 让"没有这个字段"
 *    与"这个字段是 undefined"在 JSON 往返后仍可区分。
 */
export function snapshotOf(e: MemoryEntry | undefined): Record<string, unknown> | null {
  if (!e) return null;
  return {
    id: e.id,
    memClass: e.memClass,
    kind: e.kind,
    content: e.content,
    subject: e.subject ?? null,
    confidence: e.confidence,
    evidence: e.evidence,
    owner: e.owner,
    lifecycle: e.lifecycle,
    fitness: e.fitness,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    version: e.version,
    dormantSince: e.dormantSince ?? null,
    archivedAt: e.archivedAt ?? null,
    revivedCount: e.revivedCount ?? null,
    mergedFrom: e.mergedFrom ?? null,
    effectiveness: e.effectiveness ?? null,
    principle: e.principle ?? null,
    lastHitAt: e.lastHitAt ?? null,
    hitCount: e.hitCount ?? 0,
    useCount: e.useCount ?? 0,
    scope: e.scope,
  };
}
