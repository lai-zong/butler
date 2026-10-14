/**
 * 产出物状态快照 —— 供事件携带「可重建的完整状态」
 *
 * 设计依据：方案 § 5.2（产出物版本化与三方同步回退）
 *
 * ★ 关于「内容该不该进事件」的权衡（这是一个有意的决定）：
 *
 *   原实现的注释写着"内容不进事件（体积大且不属于状态）"——
 *   这个判断在**只看审计**时是对的：审计关心"谁在什么时候改了哪个产出物"，
 *   不关心里面写了什么。
 *
 *   ⚠️ 但重放**需要内容**。没有内容的产出物恢复出来是空壳，
 *      而"回退后能看到当时的清单长什么样"正是方案 § 5.2 的演示点。
 *
 *   体量实测估算：
 *     一份清单类产出 500 字、方案类 2000 字
 *     一次会话 3—8 个产出物 × 平均 2 版本 ≈ 5—30 KB
 *     100 次会话累计 ≈ 0.5—3 MB
 *
 *   在这个量级下，**把内容放进事件是可接受的**，换来的是
 *   "事件即完整真相源"这一性质的成立 —— 而那是整个架构的地基。
 *
 *   ⚠️ 生产环境的做法应当是**内容寻址存储**（内容存文件、事件只存哈希），
 *      这样既能重建又能去重。当前规模下引入它属于过度设计；
 *      真要接的时候，改这一个文件即可。
 */

import type { Artifact, ArtifactRevision } from './types.js';

/**
 * 把产出物压成可重建的完整状态。
 *
 * ⚠️ `revisions` 必须一并带上 —— 产出物的价值一半在版本历史里
 *    （"清单 v1 保留、v2 标记为已取代、仍可查看与对比"）。
 */
export function artifactSnapshotOf(
  artifact: Artifact | undefined,
  revisions: readonly ArtifactRevision[],
): Record<string, unknown> | null {
  if (!artifact) return null;
  return {
    artifact: {
      id: artifact.id,
      label: artifact.label,
      kind: artifact.kind,
      status: artifact.status,
      currentVersion: artifact.currentVersion,
      producedByStep: artifact.producedByStep,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      supersededBy: artifact.supersededBy ?? null,
      supersededByRollback: artifact.supersededByRollback ?? null,
    },
    revisions: revisions.map((r) => ({
      artifactId: r.artifactId,
      version: r.version,
      content: r.content,
      items: r.items ?? null,
      author: r.author,
      authorId: r.authorId ?? null,
      reason: r.reason,
      producedBy: r.producedBy,
      createdAt: r.createdAt,
    })),
  };
}
