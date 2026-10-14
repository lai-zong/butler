/**
 * 检查点与回退 —— 数据模型
 *
 * 设计依据：方案 § 5.1（检查点回退）、§ 5.2（产出物版本化与三方同步回退）
 *
 * ★ 关键架构决策：**检查点不存内容，只存 seq 与引用**。
 *
 *   理由（方案 § 4.1「事件是唯一真相源」）：
 *     如果检查点把状态快照拷一份，快照就会与事件流**漂移** ——
 *     用户改了记忆、删了产出物，旧快照里还留着。
 *     于是"回到某个检查点"可能恢复出一个**从未存在过的状态**。
 *
 *   做法：检查点 = 一个 seq + 一组引用（哪些产出物、哪些记忆）。
 *     恢复状态 = 把事件流重放到那个 seq。
 *     引用完整性 = 比对引用对象是否仍存在（级联失效检测）。
 *
 *   这样"回退结果可信"不是靠约定，而是靠**结构**保证。
 */

// ═══════════════════════════════════════════════════════════
// 检查点
// ═══════════════════════════════════════════════════════════

/**
 * 检查点的类型 —— 决定它是否值得出现在时间轴上。
 *
 * ⚠️ **不是每条事件都是检查点**：一次会话可能有几百条事件，
 *    全标出来用户没法选。只有"关键决策点"才成为检查点。
 */
export type CheckpointKind =
  | 'goal' // 理解目标
  | 'recall' // 记忆召回完成
  | 'route' // 路由决策
  | 'plan' // 任务分解
  | 'stepStart' // 某步骤开始
  | 'stepDone' // 某步骤完成（产出物产生点）
  | 'conflict' // 检出冲突
  | 'verdict' // 裁决完成
  | 'deliver' // 汇总交付
  | 'manual'; // 用户手动打点

/** 检查点引用的产出物（只存 id 与版本，不存内容）。 */
export interface ArtifactRef {
  readonly artifactId: string;
  readonly version: number;
}

/** 检查点引用的记忆状态（只存 id 与版本，不存内容）。 */
export interface MemoryRef {
  readonly memoryId: string;
  readonly version: number;
}

/**
 * 恢复所需的最小状态。
 *
 * 刻意**不存**记忆内容、不存产出物内容 —— 那些由事件重放得到。
 * 这里只存"索引"，所以永远不会与真相源漂移。
 */
export interface CheckpointSnapshot {
  /** 已完成的步骤 */
  readonly completedSteps: readonly string[];
  /** 待执行的步骤 */
  readonly pendingSteps: readonly string[];
  /** 失败被跳过的步骤 */
  readonly failedSteps: readonly string[];
  /** 此刻存在的产出物引用 */
  readonly artifacts: readonly ArtifactRef[];
  /** 此刻存在的记忆引用 */
  readonly memories: readonly MemoryRef[];
  /** 检查点形成时的记忆库规模（用于展示"记忆从多少条变成多少条"） */
  readonly memoryCount: number;
  /** 累加用量，便于展示"这一步花了多少" */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface Checkpoint {
  readonly id: string;
  readonly sessionId: string;
  /** 时刻：回退目标就是这个 seq */
  readonly seq: number;
  readonly kind: CheckpointKind;
  /** 展示在时间轴上的标签，"理解目标""清单 v1""冲突 CF-007" */
  readonly label: string;
  /** 一行说明，用户拖动时看得到 */
  readonly detail: string;
  readonly snapshot: CheckpointSnapshot;
  readonly createdAt: number;
  /**
   * 失效原因。非空表示这个检查点**已不可恢复** ——
   * 通常是它引用的记忆或产出物被删除了。
   * 时间轴上显示为灰色，悬停解释原因。
   */
  readonly invalidatedBy?: string;
}

// ═══════════════════════════════════════════════════════════
// 回退计划（预览）
// ═══════════════════════════════════════════════════════════

/** 产出物在回退后的去向。 */
export interface ArtifactImpact {
  readonly artifactId: string;
  readonly label: string;
  /** keep = 在检查点内，保留；supersede = 之后产生，标记为已取代 */
  readonly action: 'keep' | 'supersede';
}

/**
 * 回退预览 —— 用户按下"回退"之前看到的东西。
 *
 * 方案 § 5.2 要求"回退预览列出受影响产出物"，
 * 且"被取代产出物不删除，可对比"。
 */
export interface RollbackPlan {
  readonly target: Checkpoint;
  toSeq: number;
  /** 保留的步骤 */
  readonly keepSteps: readonly string[];
  /** 需要重做的步骤 */
  readonly redoSteps: readonly string[];
  /** 产出物影响 */
  readonly artifactImpact: readonly ArtifactImpact[];
  /** 将被丢弃的事件数 */
  readonly discardedEvents: number;
  /** 记忆层面的影响：回退后新增的记忆会被标记待复核 */
  readonly memoryImpact: readonly { readonly memoryId: string; readonly action: 'keep' | 'review' }[];
  /** 能否执行；不能则给出原因 */
  readonly executable: boolean;
  readonly blockedReason?: string;
}

// ═══════════════════════════════════════════════════════════
// 回退结果
// ═══════════════════════════════════════════════════════════

export interface RollbackResult {
  readonly target: Checkpoint;
  readonly fromSeq: number;
  readonly toSeq: number;
  /** 被丢弃的事件（**归档而非删除** —— 供对比） */
  readonly discarded: readonly { readonly seq: number; readonly type: string }[];
  /** 被标记为已取代的产出物 */
  readonly superseded: readonly string[];
  /** 回退后需要复核的记忆 */
  readonly memoriesToReview: readonly string[];
  readonly rolledBackAt: number;
  /** 回退后的状态哈希，用于验证重放一致性 */
  readonly stateHash: string;
}

/** 回退被拒绝的原因。 */
export type RollbackDenyReason =
  | 'checkpoint_not_found'
  | 'checkpoint_invalidated'
  | 'not_a_checkpoint_seq'
  | 'nothing_to_rollback'
  | 'cross_session';

export class RollbackError extends Error {
  constructor(
    message: string,
    readonly reason: RollbackDenyReason,
  ) {
    super(message);
    this.name = 'RollbackError';
  }
}
