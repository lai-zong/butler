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
    /**
     * ★ v7：领域标签。
     *
     * ⚠️ 这个字段是"A1 加了 `MemoryEntry.domain` 却忘了加这里"的补救 ——
     *    症状正是本节开头警告的那种：**不报错，但重放后字段悄悄丢失**。
     *    当时没有任何测试依赖"重启后 domain 还在"，所以测试全绿。
     *
     *    教训：**给持久化实体加字段，必须同时改 snapshot + replay + 加一条
     *    「重启后该字段还在」的测试**。三件事缺一不可，否则缺口是静默的。
     */
    domain: e.domain ?? null,
    /**
     * ★ 敏感域授权与凭证标记。
     *
     * ⚠️ 与 `domain` 同型的事故：`MemoryEntry` 早就有这两个字段，
     *    `replay.ts` 也一直在解析它们，唯独 `snapshotOf` 没写 ——
     *    于是
     *      · 敏感域授权在任意一次状态事件（如演化日跑）后**丢失**；
     *      · 凭证类记忆的「可用不可见」标记丢失，`hasCredential` 变 false。
     *    和前一条一样：不报错、不告警，重放后字段静静消失。
     *
     *    维护约定不变：给 `MemoryEntry` 加可影响状态的字段时，
     *    `snapshotOf` + `replay.parseEntry` + 「重启后还在」的测试，三件一起做。
     */
    grants: e.grants ?? null,
    capability: e.capability ?? null,
  };
}
