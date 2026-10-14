/**
 * 产出物模型 —— 版本化与三方同步回退
 *
 * 设计依据：方案 § 5.2（产出物版本化与三方同步回退）
 *
 * "三方同步回退"指回退时**对话、任务状态、产出物**三者必须一起回到同一个点。
 * 前两者已经由事件流与检查点覆盖；这个模块补上第三者的实体。
 *
 * ★ 关键纪律：**被取代的产出物不删除**（方案 § 5.2 明确要求"可对比"）。
 *   "取代"是版本关系，不是删除动作 —— 用户随时能翻出旧版本看差别。
 */

// ═══════════════════════════════════════════════════════════
// 产出物
// ═══════════════════════════════════════════════════════════

export type ArtifactKind = 'text' | 'list' | 'plan' | 'file' | 'code';

export type ArtifactStatus =
  | 'draft' // 产生中
  | 'active' // 当前有效
  | 'superseded' // 被新版本取代（**不删除**）
  | 'discarded'; // 用户明确丢弃

/** 一个产出物的某个版本。内容本身不可变 —— 改内容产生新版本。 */
export interface ArtifactRevision {
  readonly artifactId: string;
  readonly version: number;
  readonly content: string;
  /** 可选的条目化内容（清单类产出物用） */
  readonly items?: readonly string[];
  /** 这次修订是谁做的、为什么 */
  readonly author: 'servant' | 'butler' | 'user';
  readonly authorId?: string;
  readonly reason: string;
  /** 该版本由哪些事件产出（证据链） */
  readonly producedBy: readonly string[];
  readonly createdAt: number;
}

/** 产出物的当前状态（指向某个版本）。 */
export interface Artifact {
  readonly id: string;
  readonly label: string;
  readonly kind: ArtifactKind;
  readonly status: ArtifactStatus;
  /** 当前版本号。历史版本在 revisions 里。 */
  readonly currentVersion: number;
  /** 产出它的步骤 */
  readonly producedByStep: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 被取代时指向取代它的产出物（便于"新旧对比"） */
  readonly supersededBy?: string;
  /** 被哪个检查点回退所取代 */
  readonly supersededByRollback?: string;
}

// ═══════════════════════════════════════════════════════════
// 版本对比
// ═══════════════════════════════════════════════════════════

export interface RevisionDiff {
  readonly artifactId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly addedLines: readonly string[];
  readonly removedLines: readonly string[];
  readonly unchangedCount: number;
}

/**
 * 比较两个版本。
 *
 * 用**行级集合差**而不是最长公共子序列：
 * 产出物多是清单与方案，用户关心的是"加了什么、去掉了什么"，
 * 而不是行序变化。集合差更直观，且实现确定、无依赖。
 */
export function diffRevisions(
  a: ArtifactRevision,
  b: ArtifactRevision,
): RevisionDiff {
  const linesOf = (r: ArtifactRevision): string[] =>
    r.items ? [...r.items] : r.content.split('\n').filter((l) => l.trim().length > 0);

  const before = new Set(linesOf(a));
  const after = new Set(linesOf(b));

  const addedLines = [...after].filter((l) => !before.has(l));
  const removedLines = [...before].filter((l) => !after.has(l));
  const unchangedCount = [...after].filter((l) => before.has(l)).length;

  return {
    artifactId: a.artifactId,
    fromVersion: a.version,
    toVersion: b.version,
    addedLines,
    removedLines,
    unchangedCount,
  };
}

// ═══════════════════════════════════════════════════════════
// 仓储接口
// ═══════════════════════════════════════════════════════════

export interface CreateArtifactInput {
  readonly id?: string;
  readonly label: string;
  readonly kind: ArtifactKind;
  readonly content: string;
  readonly items?: readonly string[];
  readonly producedByStep: string;
  readonly author: 'servant' | 'butler' | 'user';
  readonly authorId?: string;
  readonly reason?: string;
  readonly producedBy?: readonly string[];
}

export interface ReviseArtifactInput {
  readonly artifactId: string;
  readonly content: string;
  readonly items?: readonly string[];
  readonly author: 'servant' | 'butler' | 'user';
  readonly authorId?: string;
  readonly reason: string;
  readonly producedBy?: readonly string[];
}

export interface ArtifactStore {
  create(input: CreateArtifactInput): Artifact;
  /** 产生新版本（不覆盖历史）。 */
  revise(input: ReviseArtifactInput): Artifact;
  get(id: string): Artifact | undefined;
  currentRevision(id: string): ArtifactRevision | undefined;
  revision(id: string, version: number): ArtifactRevision | undefined;
  revisions(id: string): readonly ArtifactRevision[];
  all(): readonly Artifact[];
  listByStatus(status: ArtifactStatus): readonly Artifact[];
  /**
   * 标记为已取代 —— **不删除**。
   *
   * @param byRollback 若是回退导致的取代，记录检查点 id（用户能追溯"为什么被取代"）
   */
  supersede(id: string, options?: { readonly by?: string; readonly byRollback?: string }): boolean;
  /** 用户明确丢弃。 */
  discard(id: string): boolean;
}
