/**
 * 记忆演化 · 第一层与第三层：适应度与生命周期
 *
 * 设计依据：方案 § 8.3（三层演化模型）、§ 8.4（适应度函数）、§ 8.5（防退化）
 *
 * ⚠️ **确定性要求（ADR 0004）**：这里的计算必须是纯函数 ——
 *    时间从参数传入，不读 Date.now()；随机走注入的 RandomPort。
 *    否则"同一段事件流重放两次结果一致"就不成立，
 *    而回退可信度正是本项目的核心卖点。
 *
 * ⚠️ **行为从事件流读出，不由模型判断**：
 *    "这条记忆是否奏效"来自用户的显式反馈事件（采纳/纠正），
 *    不是让 LLM 事后评判。这样适应度可复算、可审计、可重放。
 */

import type { EvolutionEvent, MemoryEntry, MemoryLifecycle } from './types.js';

// ═══════════════════════════════════════════════════════════
// 可调参数（第三层"参数演化"的落点）
// ═══════════════════════════════════════════════════════════

export interface EvolutionParams {
  /** EMA 平滑系数 α。方案 § 8.4 建议 0.1—0.2 —— 越小越"渐变" */
  readonly emaAlpha: number;
  /** 连续未命中多少天后进入休眠 */
  readonly dormantAfterMs: number;
  /** 休眠中适应度低于此值则归档 */
  readonly archiveBelowFitness: number;
  /** 召回阈值基准（第三层：随库规模自适应，见 adaptAdaptiveThreshold） */
  readonly recallThresholdBase: number;
  /** 多样性保护：同类记忆至少保留多少条 */
  readonly diversityMinPerKind: number;
  /** 探索性召回比例（防局部最优，§ 8.5）*/
  readonly exploratoryRatio: number;
  /** 单条记忆权重上限（防单一主导，§ 8.5）*/
  readonly maxFitness: number;
}

export const DEFAULT_PARAMS: EvolutionParams = {
  emaAlpha: 0.15,
  dormantAfterMs: 60 * 24 * 60 * 60 * 1000, // 60 天
  archiveBelowFitness: 0.25,
  recallThresholdBase: 0.35,
  diversityMinPerKind: 2,
  exploratoryRatio: 0.1,
  maxFitness: 0.98,
};

/** 适应度公式权重（方案 § 8.4）。和为正项总和 1.0，惩罚项单独扣。 */
export const FITNESS_WEIGHTS = {
  w1_usage: 0.3,
  w2_effectiveness: 0.3,
  w3_evidence: 0.15,
  w4_recency: 0.25,
  w5_conflict: 0.15,
  w6_misuse: 0.25,
} as const;

/** 命中次数达到该值时"使用频率"分量饱和 */
const USAGE_SATURATION = 12;
/** 证据条数达到该值时"证据强度"分量饱和 */
const EVIDENCE_SATURATION = 3;

// ═══════════════════════════════════════════════════════════
// 时间衰减（第三层：按记忆类型区分速率）
// ═══════════════════════════════════════════════════════════

/** 衰减档位。方案的例子：过敏原几乎不衰减、口味偏好衰减较快、环境记忆随环境重置。 */
export type DecayClass = 'none' | 'slow' | 'medium' | 'fast';

/** 各档位的半衰期（毫秒）。none 表示不衰减。 */
export const HALF_LIFE_MS: Record<DecayClass, number | null> = {
  none: null, // 硬约束：永不衰减
  slow: 365 * 24 * 60 * 60 * 1000, // 事实类
  medium: 120 * 24 * 60 * 60 * 1000, // 偏好类
  fast: 30 * 24 * 60 * 60 * 1000, // 环境类
};

/**
 * 判定一条记忆的衰减档位。
 *
 * 规则来源：方案 § 8.3 第三层表格 + § 8.5「休眠/归档阈值按记忆类型区分」。
 */
export function decayClassOf(entry: {
  readonly memClass: MemoryEntry['memClass'];
  readonly kind: MemoryEntry['kind'];
}): DecayClass {
  // 硬约束永不衰减 —— 否则会出现"把过敏史衰减掉"
  if (entry.memClass === 'global_constraint') return 'none';
  if (entry.kind === 'fact') return 'slow';
  if (entry.kind === 'principle') return 'medium';
  return 'medium'; // preference
}

/** 环境记忆（见效于特定软件版本/机器配置）衰减最快。 */
export const ENVIRONMENT_DECAY: DecayClass = 'fast';

/** 指数衰减：距今 elapsed 毫秒后的保留系数 ∈ (0, 1]。 */
export function decayFactor(decayClass: DecayClass, elapsedMs: number): number {
  const halfLife = HALF_LIFE_MS[decayClass];
  if (halfLife === null) return 1;
  if (elapsedMs <= 0) return 1;
  return Math.pow(0.5, elapsedMs / halfLife);
}

// ═══════════════════════════════════════════════════════════
// 适应度输入与计算
// ═══════════════════════════════════════════════════════════

/**
 * 一条记忆的行为统计。
 *
 * 全部来自事件流的累计，**没有任何字段需要模型判断**。
 * 这样适应度可以随时从事件重算，结果必然一致。
 */
export interface OutcomeStats {
  /** 被召回次数 */
  readonly hits: number;
  /** 被应用后奏效次数（用户采纳 / 未纠正）*/
  readonly successes: number;
  /** 被应用后失效次数（用户纠正 / 撤销）*/
  readonly misuses: number;
  /** 与其它记忆的冲突次数 */
  readonly conflicts: number;
  /** 上次被命中的时刻 */
  readonly lastHitAt: number | null;
  readonly createdAt: number;
  /** 支撑证据条数 */
  readonly evidenceCount: number;
}

export interface FitnessComponents {
  readonly usage: number;
  readonly effectiveness: number;
  readonly evidence: number;
  readonly recency: number;
  readonly conflictPenalty: number;
  readonly misusePenalty: number;
}

export interface FitnessResult {
  /** 观测到的适应度（未平滑）*/
  readonly observed: number;
  /** 平滑后的适应度 —— 实际写入的那个 */
  readonly smoothed: number;
  readonly components: FitnessComponents;
  readonly decayClass: DecayClass;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * 计算适应度（方案 § 8.4 公式）。
 *
 *   fitness = w1·使用频率 + w2·效果验证 + w3·证据强度 + w4·时效
 *             − w5·冲突惩罚 − w6·误用惩罚
 *
 * 随后用 EMA 平滑：
 *   fitness_next = α · observed + (1 − α) · prev
 *
 * @param prev 上一次的适应度。传 undefined 表示首次计算（不平滑）。
 */
export function computeFitness(args: {
  readonly entry: Pick<MemoryEntry, 'memClass' | 'kind' | 'fitness'>;
  readonly stats: OutcomeStats;
  readonly now: number;
  readonly params?: EvolutionParams;
  /** 记忆类型权重修正（第三层"适应度权重"演化的落点）*/
  readonly weightTuning?: Partial<typeof FITNESS_WEIGHTS>;
  /** 用于测试与显式重置 */
  readonly previousFitness?: number;
}): FitnessResult {
  const p = args.params ?? DEFAULT_PARAMS;
  const w = { ...FITNESS_WEIGHTS, ...(args.weightTuning ?? {}) };
  const s = args.stats;

  // ① 使用频率：饱和归一，避免"命中越多越无限高"
  const usage = clamp01(s.hits / USAGE_SATURATION);

  // ② 效果验证：(成功 − 失效) / 总反馈。无反馈时给中性值 0.5
  const feedback = s.successes + s.misuses;
  const effectiveness = feedback === 0 ? 0.5 : clamp01(s.successes / feedback);

  // ③ 证据强度：条数饱和归一
  const evidence = clamp01(s.evidenceCount / EVIDENCE_SATURATION);

  // ④ 时效：从上次命中（无命中则建档）起算的指数衰减
  const decayClass = decayClassOf(args.entry);
  const since = args.now - (s.lastHitAt ?? s.createdAt);
  const recency = decayFactor(decayClass, since);

  // ⑤⑥ 惩罚项：按比例计，且各自饱和，避免少量冲突就归零
  const conflictPenalty = clamp01(s.conflicts / 3);
  const misusePenalty = feedback === 0 ? 0 : clamp01(s.misuses / Math.max(1, feedback));

  const raw =
    w.w1_usage * usage +
    w.w2_effectiveness * effectiveness +
    w.w3_evidence * evidence +
    w.w4_recency * recency -
    w.w5_conflict * conflictPenalty -
    w.w6_misuse * misusePenalty;

  const observed = clamp01(raw);

  // EMA 平滑 —— "渐变"的实现。硬约束不参与演化，直接返回观测值。
  const prev = args.previousFitness ?? args.entry.fitness;
  const smoothed =
    decayClass === 'none'
      ? observed
      : clamp01(p.emaAlpha * observed + (1 - p.emaAlpha) * prev);

  return {
    observed,
    smoothed: Math.min(smoothed, p.maxFitness),
    components: { usage, effectiveness, evidence, recency, conflictPenalty, misusePenalty },
    decayClass,
  };
}

// ═══════════════════════════════════════════════════════════
// 第一层 · 生命周期状态机
// ═══════════════════════════════════════════════════════════

export type LifecycleTransition =
  | { readonly kind: 'none' }
  | { readonly kind: 'dormant'; readonly reason: string }
  | { readonly kind: 'archived'; readonly reason: string }
  | { readonly kind: 'revived'; readonly reason: string };

/**
 * 根据适应度与时间推导生命周期迁移。
 *
 * 状态图：
 *   候选 ──审核通过──> 活跃
 *   活跃 ──连续 N 天未命中──> 休眠
 *   休眠 ──适应度低于阈值──> 归档
 *   休眠/归档 ──被再次命中──> 活跃（唤醒）
 *
 * ⚠️ 硬约束（global_constraint）**永不迁移** —— 不参与演化淘汰。
 */
export function nextLifecycle(args: {
  readonly entry: MemoryEntry;
  readonly stats: OutcomeStats;
  readonly now: number;
  readonly params?: EvolutionParams;
}): LifecycleTransition {
  const p = args.params ?? DEFAULT_PARAMS;
  const e = args.entry;

  // 硬约束与候选不参与自动迁移
  if (e.memClass === 'global_constraint') return { kind: 'none' };
  if (e.lifecycle === 'candidate') return { kind: 'none' };

  const idleSince = args.now - (args.stats.lastHitAt ?? args.stats.createdAt);

  // 唤醒：休眠/归档状态下被再次命中
  if ((e.lifecycle === 'dormant' || e.lifecycle === 'archived') && args.stats.lastHitAt !== null) {
    const hitAfterDormancy = args.stats.lastHitAt > (e.dormantSince ?? e.archivedAt ?? 0);
    if (hitAfterDormancy) {
      return { kind: 'revived', reason: '在对的场景被再次命中，自动回升权重' };
    }
  }

  // 活跃 → 休眠
  if (e.lifecycle === 'active' && idleSince >= p.dormantAfterMs) {
    return {
      kind: 'dormant',
      reason: `连续 ${Math.floor(idleSince / 86_400_000)} 天未被命中`,
    };
  }

  // 休眠 → 归档
  if (e.lifecycle === 'dormant' && e.fitness < p.archiveBelowFitness) {
    return {
      kind: 'archived',
      reason: `休眠中适应度 ${e.fitness.toFixed(2)} 低于阈值 ${p.archiveBelowFitness}`,
    };
  }

  return { kind: 'none' };
}

// ═══════════════════════════════════════════════════════════
// 第三层 · 参数演化
// ═══════════════════════════════════════════════════════════

/**
 * 召回阈值随记忆库规模自适应（方案 § 8.3 第三层）。
 *
 * 库越大 → 阈值越高，保证精度；否则噪声会挤满上下文。
 * 用对数增长，避免阈值随规模线性飙升导致几乎无记忆可召回。
 */
export function adaptThreshold(librarySize: number, base = DEFAULT_PARAMS.recallThresholdBase): number {
  if (librarySize <= 20) return base;
  // 每翻 10 倍规模，阈值 +0.08；上限 0.7
  const growth = 0.08 * Math.log10(librarySize / 20);
  return Math.min(0.7, base + growth);
}

// ═══════════════════════════════════════════════════════════
// 演化事件构造
// ═══════════════════════════════════════════════════════════

/** 把生命周期迁移转成演化日志条目（供界面"本月 3 条休眠"展示）。 */
export function transitionToEvolutionEvent(args: {
  readonly id: string;
  readonly userId: string;
  readonly memoryId: string;
  readonly transition: LifecycleTransition;
  readonly now: number;
  readonly actor?: 'system' | 'user';
}): EvolutionEvent | null {
  const t = args.transition;
  if (t.kind === 'none') return null;

  const type = t.kind === 'dormant' ? 'dormant' : t.kind === 'archived' ? 'archived' : 'revived';

  return {
    id: args.id,
    userId: args.userId,
    at: args.now,
    type,
    memoryIds: [args.memoryId],
    detail: t.reason,
    actor: args.actor ?? 'system',
  };
}

/** 生命周期标签（界面用）。 */
export const LIFECYCLE_ORDER: readonly MemoryLifecycle[] = [
  'candidate',
  'active',
  'dormant',
  'archived',
];
