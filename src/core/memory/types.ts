/**
 * 记忆模型 —— 三元结构 + 分权 + 演化
 *
 * 设计依据：参赛方案 v6.5 § 2.2⑥、§ 3.1、§ 4.2、§ 8
 *
 * 三件事在类型层面被强制：
 *   1. 三元结构：fact / preference / principle
 *   2. 分权：memClass 决定可见范围与写入权
 *   3. 演化：fitness + lifecycle，淘汰只降权不删除
 */

import type { DomainId } from '../domain/types.js';

// ═══════════════════════════════════════════════════════════
// 三元结构
// ═══════════════════════════════════════════════════════════

/**
 * - fact       客观信息        「你对花生过敏」
 * - preference 倾向与习惯      「先给结论再给细节」
 * - principle  反思产物         「推荐餐厅前先确认同行人饮食禁忌」
 */
export type MemoryKind = 'fact' | 'preference' | 'principle';

// ═══════════════════════════════════════════════════════════
// 分权（§ 2.2⑥）
// ═══════════════════════════════════════════════════════════

/**
 * 四类记忆。可见范围与写入权由权限矩阵决定：
 *
 * | 类别              | 管家 | 所属仆人   | 其它仆人            |
 * |-------------------|------|-----------|---------------------|
 * | global_constraint | 读写 | 强制可见   | 强制可见            |
 * | global_shared     | 读写 | 可检索     | 可检索（记审计）     |
 * | sensitive         | 读写 | 读写       | 默认不可见，需授权   |
 * | domain            | 只读 | 读写       | 不可见              |
 *
 * 关键约束：**全局层只能管家写入**，仆人无写权限（保证真相源唯一）。
 */
export type MemoryClass = 'global_constraint' | 'global_shared' | 'sensitive' | 'domain';

export const MEMORY_CLASS_LABEL: Record<MemoryClass, string> = {
  global_constraint: '全局硬约束',
  global_shared: '全局共享事实',
  sensitive: '敏感域信息',
  domain: '领域记忆',
};

/** 该类别是否强制对全部仆人可见（只读）。 */
export function isForceVisible(cls: MemoryClass): boolean {
  return cls === 'global_constraint';
}

/** 该类别是否按需可检索（只读，记审计）。 */
export function isSearchableByAll(cls: MemoryClass): boolean {
  return cls === 'global_constraint' || cls === 'global_shared';
}

/** 该类别是否只能由管家写入。 */
export function isButlerWriteOnly(cls: MemoryClass): boolean {
  return cls === 'global_constraint' || cls === 'global_shared' || cls === 'sensitive';
}

/** 该类别是否参与演化淘汰。硬约束永不衰减、永不淘汰。 */
export function participatesInEvolution(cls: MemoryClass): boolean {
  return cls !== 'global_constraint';
}

// ═══════════════════════════════════════════════════════════
// 演化（§ 8）
// ═══════════════════════════════════════════════════════════

/**
 * 四态生命周期。**淘汰 ≠ 删除**：
 * dormant / archived 的记忆数据保留，被再次命中时可自动唤醒。
 */
export type MemoryLifecycle = 'candidate' | 'active' | 'dormant' | 'archived';

export const LIFECYCLE_LABEL: Record<MemoryLifecycle, string> = {
  candidate: '候选',
  active: '活跃',
  dormant: '休眠',
  archived: '归档',
};

/** 适应度变化的归因，用于 FitnessSample 与可视化。 */
export type FitnessReason =
  | 'hit' // 被召回
  | 'success' // 应用后奏效
  | 'conflict' // 与其它记忆矛盾
  | 'misuse' // 应用后导致用户纠正
  | 'decay' // 时间衰减
  | 'merge' // 相似合并
  | 'revive'; // 被唤醒

/** 适应度历史采样，驱动衰减曲线可视化（§ 8.6）。 */
export interface FitnessSample {
  readonly memoryId: string;
  readonly at: number;
  readonly fitness: number;
  readonly reason: FitnessReason;
}

/**
 * 演化事件日志 —— "本月 3 条休眠、1 条唤醒" 的来源（§ 8.6）。
 */
export type EvolutionEventType =
  | 'dormant'
  | 'archived'
  | 'revived'
  | 'merged'
  | 'weightAdjusted'
  | 'thresholdAdapted';

export interface EvolutionEvent {
  readonly id: string;
  readonly userId: string;
  readonly at: number;
  readonly type: EvolutionEventType;
  readonly memoryIds: readonly string[];
  readonly detail: string;
  /** 'user' 表示这是用户手动干预（可观测 + 可干预，§ 8.6） */
  readonly actor: 'system' | 'user';
}

// ═══════════════════════════════════════════════════════════
// 记忆条目
// ═══════════════════════════════════════════════════════════

/**
 * 记忆归属 —— **谁写的这条记忆**。
 *
 * ⚠️ **当前仍保留 `kind: 'servant'`**，但它在 v7 目标架构里是**待删除**的
 *    （「管家+仆人」→「管家+监督员」的 A2 步，见 `docs/refactor-plan.md`）。
 *
 * ═══ 为什么这一步单独做，不塞进别的提交 ═══
 *
 *   实测：把 `servant` 从这个联合里去掉，会引发 **38 处类型错误、分布在 10 个文件**。
 *   其中 `store.ts` 的 `canRead` / `canWrite` 是**安全核心**。
 *
 *   那不是"改一个类型"，是**一整块权限模型的替换**：
 *     · `domain_not_owner` 拒绝原因要消失
 *     · 领域记忆不再有权限边界（单执行者，管家读写全部）
 *     · 敏感域授权要重写（`grantedTo` 没有主体了）
 *
 *   ★ 这类改动**必须单独一次做完并单独验证** ——
 *     塞进别的提交里，出问题时无法归因。
 *
 * ═══ 目标形态（已定，等 A2 执行）═══
 *
 *   ```ts
 *   export type MemoryOwner = { readonly kind: 'butler'; readonly userId: string };
 *   ```
 *
 *   ★ 关键区分：`owner`（谁写的）与 `domain`（关于哪个领域）是**两件正交的事**。
 *     旧模型把它们挤在 `owner` 里，因为旧架构假设"领域 = 某个执行者的地盘"。
 *     目标形态拆开：`domain` 已成为 `MemoryEntry` 的独立字段（本步已加）。
 */
export type MemoryOwner = { readonly kind: 'butler'; readonly userId: string };

/**
 * 敏感域跨域授权。
 *
 * **逐次授权 + 按任务失效**：不做长期免授权（§ 2.2⑥）。
 * 每次授权与读取都写审计事件（grant.used）。
 *
 * ⚠️ `grantedTo` 在目标架构里也应删除（单执行者下"授权给谁"只有一个答案），
 *    与 `MemoryOwner` 一起归入 A2 步。
 */
export interface MemoryGrant {
  readonly taskId: string;
  readonly grantedTo: DomainId;
  readonly at: number;
  /** 任务结束后自动失效；到期后不再可见 */
  readonly expiresAt: number;
  /** 授权用途，供审计展示 */
  readonly purpose: string;
}


/** 凭证类记忆："可用不可见"。 */
export interface CredentialCapability {
  readonly canUse: true;
  readonly canRead: false;
  readonly requiresApproval: true;
}

/** 原则的效果跟踪（创新点 ②）。 */
export interface Effectiveness {
  /**
   * 被注入给仆人的次数。
   *
   * ⚠️ 语义是"**这次任务用到了它**"，不是"这条原则存在"。
   *    只有真的注入进 prompt 才 +1 —— 否则这个数字没有意义。
   */
  readonly applied: number;
  /** 应用后奏效的次数（用户未纠正 / 监督未判违背） */
  readonly succeeded: number;
  readonly lastAppliedAt: number;
}

/**
 * 原则的结构化表达。
 *
 * 为什么需要它：只有一句自然语言的"推荐餐厅前先确认同行人忌口"，
 * 系统无法判断**什么时候该注入它**、也无法判断**产出是否违背了它**。
 * 拆成 condition + action 之后两件事都能做：
 *   · 注入：拿 condition 与本次任务指令做相关性匹配
 *   · 违背检测：拿 action 检查仆人产出是否遵守
 */
export interface PrincipleDetail {
  /** 适用条件（什么时候该用它） */
  readonly condition: string;
  /** 行为要求（该怎么做事） */
  readonly action: string;
  /** 由用户的冲突裁决固化的原则（区别于反思产出的） */
  readonly fromVerdict?: string;
}

/** 记忆版本历史，支持回滚与"遗忘权"。 */
export interface MemoryRevision {
  readonly id: string;
  readonly memoryId: string;
  readonly version: number;
  readonly patch: {
    readonly before: Partial<MemoryEntry>;
    readonly after: Partial<MemoryEntry>;
  };
  readonly reason: string;
  readonly actor: 'reflection' | 'butler' | 'user' | 'verification';
  readonly createdAt: number;
}

export interface MemoryEntry {
  readonly id: string;
  readonly owner: MemoryOwner;
  /** 分权类别，决定可见范围与写入权 */
  readonly memClass: MemoryClass;
  readonly kind: MemoryKind;
  readonly content: string;
  /** 事实的主体：'self' | 'contact:小李' | ... */
  readonly subject?: string;

  /** 置信度 0—1，由用户审核与反思共同决定 */
  readonly confidence: number;
  /** 来源事件 id —— 证据链，用户可追问"你凭什么这么认为" */
  readonly evidence: readonly string[];

  // ── 演化状态（§ 8）──
  /** 适应度 0—1，由 § 8.4 公式计算，EMA 平滑。硬约束不使用此字段。 */
  readonly fitness: number;
  readonly lifecycle: MemoryLifecycle;
  readonly lastHitAt: number | null;
  readonly hitCount: number;
  readonly dormantSince?: number;
  readonly archivedAt?: number;
  /** 由哪些记忆合并而来 */
  readonly mergedFrom?: readonly string[];
  /** 被唤醒次数（休眠 → 活跃），体现"淘汰可逆" */
  readonly revivedCount: number;

  readonly scope: 'global' | 'domain' | 'session';

  /**
   * 领域标签 —— **这条记忆关于哪个领域**（v7 新增）。
   *
   * ★ 它替代了旧模型里「`owner.kind: 'servant'` 的 servant 字段」，
   *   但语义完全不同：
   *     · 旧：这条记忆**属于某个仆人**（权限边界 —— 别的仆人看不到）
   *     · 新：这条记忆**关于某个领域**（标签 —— 用于反思作用域与召回过滤）
   *
   * ⚠️ 为什么还需要它（不能干脆删掉领域概念）：
   *   ① 创新点①（分层反思）的隔离靠它 —— 每份领域反思只喂本领域记忆
   *   ② 监督员的"领域视角"复核要知道该用哪套纪律（`DOMAIN_DISCIPLINE`）
   *   ③ 召回时可按领域过滤（"这次是做饭的事，优先看健康与生活"）
   *
   * `undefined` 表示"不特定于某个领域"（如全局事实）。
   */
  readonly domain?: DomainId;

  readonly version: number;

  /** 原则专属：效果跟踪 */
  readonly effectiveness?: Effectiveness;
  /** 原则专属：条件与动作的结构化表达（决定「何时注入」与「是否违背」） */
  readonly principle?: PrincipleDetail;
  /** 敏感域专属：谁被授权读取过 */
  readonly grants?: readonly MemoryGrant[];
  /** 凭证专属：可用不可见 */
  readonly capability?: CredentialCapability;

  readonly createdAt: number;
  readonly updatedAt: number;
  readonly useCount: number;
}
