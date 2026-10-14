/**
 * 产出物重放 —— 从事件流重建产出物与版本历史
 *
 * 设计依据：方案 § 5.2（产出物必须与对话、任务状态一同快照并同步回退）
 *
 * ★ 为什么产出物必须能重建：
 *   方案原文："**产出物必须与对话、任务状态一同快照并同步回退，
 *   否则回退只做了一半。**"
 *
 *   回退预览里那句「清单 v2 —— 将标记为「已取代」，仍可查看与对比」
 *   要能成立，产出物与它的版本历史都必须**跨重启存活**。
 *
 * ⚠️ 与记忆重放同一套约定：
 *   · 纯函数，不碰 store、不发事件
 *   · 状态以事件里的 `snapshot` 为准，不做推断
 *   · 拒绝注入到非空 store
 */

import type { SessionEvent } from '../events/types.js';
import type { Artifact, ArtifactRevision, ArtifactStore } from './types.js';

export interface ReplayArtifactResult {
  readonly artifacts: readonly { readonly artifact: Artifact; readonly revisions: readonly ArtifactRevision[] }[];
  readonly consumedEvents: number;
  readonly skippedEvents: readonly { readonly seq: number; readonly type: string; readonly why: string }[];
}

/** 与产出物状态相关的事件类型。 */
export const ARTIFACT_STATE_EVENTS: readonly string[] = [
  'artifact.created',
  'artifact.revised',
  'artifact.superseded',
];

/**
 * 从事件流重建产出物。
 *
 * ★ 后写的事件覆盖先写的 —— 因为每个事件里的 `snapshot` 都是
 *   **那一刻的完整状态**，所以"最后一条即最新"。
 *   这比"逐条应用 delta"简单得多，且天然抗漏记。
 */
export function replayArtifacts(events: readonly SessionEvent[]): ReplayArtifactResult {
  const byId = new Map<string, { artifact: Artifact; revisions: ArtifactRevision[] }>();
  const skipped: { seq: number; type: string; why: string }[] = [];
  let consumed = 0;

  for (const e of events) {
    if (!ARTIFACT_STATE_EVENTS.includes(e.type)) continue;
    consumed += 1;

    const p = (e.payload ?? {}) as Record<string, unknown>;
    const snapshot = p['snapshot'];

    if (typeof snapshot !== 'object' || snapshot === null) {
      // ⚠️ 老事件没有 snapshot（本字段是后加的）——
      //    如实记为"信息不足"，而不是猜一个出来。
      skipped.push({
        seq: e.seq,
        type: e.type,
        why: '事件里没有 snapshot 字段（可能是加字段之前写入的历史事件）',
      });
      continue;
    }

    const parsed = parseSnapshot(snapshot as Record<string, unknown>);
    if (parsed === null) {
      skipped.push({ seq: e.seq, type: e.type, why: 'snapshot 形状不合规' });
      continue;
    }

    byId.set(parsed.artifact.id, parsed);
  }

  return {
    artifacts: [...byId.values()].map((v) => ({ artifact: v.artifact, revisions: v.revisions })),
    consumedEvents: consumed,
    skippedEvents: skipped,
  };
}

/**
 * 把重放结果注入一个空的 ArtifactStore。
 *
 * ⚠️ 必须注入到**空 store** —— 混入已有状态会产生无法排查的差异。
 */
export function hydrateArtifactStore(args: {
  /**
   * ⚠️ 收窄为 InMemoryArtifactStore 而不是接口 ——
   *    estoreArtifact 是重放专用的注入方法，**不该**出现在业务接口上
   *    （它绕过所有校验与事件）。放在具体类上，业务代码就看不到它。
   */
  readonly store: ArtifactStore & { restoreArtifact(a: Artifact, r: readonly ArtifactRevision[]): void };
  readonly result: ReplayArtifactResult;
}): { readonly ok: boolean; readonly reason?: string; readonly hydrated: number } {
  const existing = args.store.all();
  if (existing.length > 0) {
    return {
      ok: false,
      reason: `目标 store 非空（已有 ${existing.length} 个产出物）—— 重放必须注入到空 store`,
      hydrated: 0,
    };
  }

  for (const { artifact, revisions } of args.result.artifacts) {
    args.store.restoreArtifact(artifact, revisions);
  }

  return { ok: true, hydrated: args.result.artifacts.length };
}

// ═══════════════════════════════════════════════════════════
// 解析
// ═══════════════════════════════════════════════════════════

function parseSnapshot(raw: Record<string, unknown>): {
  artifact: Artifact;
  revisions: ArtifactRevision[];
} | null {
  const a = raw['artifact'];
  if (typeof a !== 'object' || a === null) return null;
  const o = a as Record<string, unknown>;

  const id = typeof o['id'] === 'string' ? o['id'] : null;
  if (id === null) return null;

  const artifact: Artifact = {
    id,
    label: typeof o['label'] === 'string' ? o['label'] : '',
    kind: (typeof o['kind'] === 'string' ? o['kind'] : 'text') as Artifact['kind'],
    status: (typeof o['status'] === 'string' ? o['status'] : 'active') as Artifact['status'],
    currentVersion: num(o['currentVersion'], 1),
    producedByStep: typeof o['producedByStep'] === 'string' ? o['producedByStep'] : '',
    createdAt: num(o['createdAt'], 0),
    updatedAt: num(o['updatedAt'], 0),
    ...(typeof o['supersededBy'] === 'string' ? { supersededBy: o['supersededBy'] } : {}),
    ...(typeof o['supersededByRollback'] === 'string'
      ? { supersededByRollback: o['supersededByRollback'] }
      : {}),
  };

  const revisions: ArtifactRevision[] = [];
  const rawRevs = raw['revisions'];
  if (Array.isArray(rawRevs)) {
    for (const r of rawRevs) {
      if (typeof r !== 'object' || r === null) continue;
      const ro = r as Record<string, unknown>;
      revisions.push({
        artifactId: typeof ro['artifactId'] === 'string' ? ro['artifactId'] : id,
        version: num(ro['version'], 1),
        content: typeof ro['content'] === 'string' ? ro['content'] : '',
        ...(Array.isArray(ro['items']) ? { items: ro['items'] as string[] } : {}),
        author: (typeof ro['author'] === 'string' ? ro['author'] : 'butler') as ArtifactRevision['author'],
        ...(typeof ro['authorId'] === 'string' ? { authorId: ro['authorId'] } : {}),
        reason: typeof ro['reason'] === 'string' ? ro['reason'] : '',
        producedBy: Array.isArray(ro['producedBy']) ? (ro['producedBy'] as string[]) : [],
        createdAt: num(ro['createdAt'], 0),
      });
    }
  }

  return { artifact, revisions };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 比较两份产出物状态（重放正确性的验收标准）。 */
export function diffArtifacts(
  a: readonly Artifact[],
  b: readonly Artifact[],
): { readonly identical: boolean; readonly differing: readonly string[] } {
  const mapB = new Map(b.map((x) => [x.id, x]));
  const differing: string[] = [];

  if (a.length !== b.length) return { identical: false, differing: ['(数量不同)'] };

  for (const ea of a) {
    const eb = mapB.get(ea.id);
    if (!eb || JSON.stringify(ea) !== JSON.stringify(eb)) differing.push(ea.id);
  }

  return { identical: differing.length === 0, differing };
}
