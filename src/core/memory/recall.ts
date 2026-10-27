/**
 * 记忆召回
 *
 * 设计依据：方案 § 8.3 第二层（种群选择）、§ 8.5（防退化）、第十四章「RAG」
 *
 * 一次召回要同时满足五件事，缺一件就不是"演化式记忆"：
 *   ① **分权过滤** —— 只在该角色的可见集合里检索（M1—M3）
 *   ② **相关性打分** —— 与本次目标有多相关
 *   ③ **适应度加权** —— 同样相关的两条记忆，适应度高者优先
 *   ④ **探索性召回** —— 保留 ε 比例给低适应度记忆（防局部最优）
 *   ⑤ **多样性保护** —— 同类至少保留 N 条（防过度剪枝）
 *
 * ⚠️ 确定性：不使用向量库、不调用模型。打分是纯函数，
 *    随机走注入的 RandomPort，因此同一次召回可重放。
 */

import type { RandomPort } from '../ports/clock.js';
import type { DomainId } from '../domain/types.js';
import { isRelevant } from '../text/keywords.js';
import { adaptThreshold, DEFAULT_PARAMS, type EvolutionParams } from './fitness.js';
import { DIARY_EVIDENCE_PREFIX, type MemoryEntry, type MemoryKind } from './types.js';
import { retrievalConfig } from '../config/env.js';

// ═══════════════════════════════════════════════════════════
// 打分权重
// ═══════════════════════════════════════════════════════════

export const RECALL_WEIGHTS = {
  /** 与目标的相关性 —— 最重要，不相关就不该被召回 */
  relevance: 0.5,
  /** 适应度 —— "越用越准"的体现 */
  fitness: 0.3,
  /** 置信度 —— 用户审核过的记忆更可信 */
  confidence: 0.2,
} as const;

/**
 * 语义扩展的保守门槛。
 *
 * ★ 2026-10-25 复测（30 条跨场景查询 + 5 条负例）：
 *   · 0.40：27/30 命中，负例误召回 1/5
 *   · 0.35：29/30 命中，负例误召回 1/5
 *   · 0.30：30/30 命中，但负例误召回 5/5（太多）
 *
 * 当前选 **0.35**：比 0.40 多救回 2 条相关记忆，误召回没有增加。
 * 仍漏“火锅→减脂”（该 query 语义分约 0.327），
 * 不为了这一条把阈值降到 0.30；那是用噪声换指标。
 *
 * 这只是 35 条小样本，不能宣称普适；需要持续扩充评测集。
 */
export const SEMANTIC_RELEVANCE_THRESHOLD = 0.35;

/**
 * 语义补充通道的候选下限。
 *
 * ★ 与 `SEMANTIC_RELEVANCE_THRESHOLD` 分开：
 *   0.35 是“单靠语义分就足以直接进入召回”的门槛；
 *   0.30 是“允许进入 top-k 补充池、再由精排决定去留”的候选下限。
 *
 *   分开的原因：把 0.35 直接降到 0.30 会让负例一起进入最终结果
 *   （实测 0.30 时 5/5 负例误召回）；而 top-k 只补充少量候选，
 *   后面还有精排过滤，风险面不同。两者不能共用一个数字。
 */
export const SEMANTIC_CANDIDATE_FLOOR = 0.30;
/** 试行记忆参与召回，但只按这个权重参与竞争。 */
export const TRIAL_SCORE_WEIGHT = 0.55;

/** 只有日记产生的候选才是“试行”；旧的待审候选仍不参与召回。 */
export function isDiaryTrial(memory: MemoryEntry): boolean {
  return (
    memory.lifecycle === 'candidate' &&
    memory.evidence.some((e) => e.startsWith(DIARY_EVIDENCE_PREFIX))
  );
}

export interface ScoredMemory {
  readonly memory: MemoryEntry;
  readonly score: number;
  readonly relevance: number;
  readonly fitness: number;
  readonly confidence: number;
  /** 是否来自探索性召回（低适应度但被有意注入） */
  readonly exploratory: boolean;
  /** 为什么被选中（可解释性） */
  readonly why: string;
}

export interface RecallResult {
  readonly selected: readonly ScoredMemory[];
  /** 本次使用的召回阈值（第三层参数演化的输出） */
  readonly threshold: number;
  /** 候选总数（可见集合大小） */
  readonly candidateCount: number;
  /** 被阈值挡掉的数量 */
  readonly filteredOut: number;
  /**
   * 本次通过语义 top-k 通道补充进来的 memoryId。
   *
   * ★ 只做可解释性用途：调用方可以据此说明“这条不是字面命中，
   *   而是语义补充 + 精排后留下的”。不参与状态。
   */
  readonly supplemented?: readonly string[];
}

export interface RecallArgs {
  /** 用户目标 / 本次查询 */
  readonly query: string;
  /** 可见集合（调用方已用 MemoryStore.visibleTo 过滤）*/
  readonly candidates: readonly MemoryEntry[];
  readonly limit: number;
  readonly now: number;
  readonly random: RandomPort;
  readonly params?: EvolutionParams;
  /** 偏向某个仆人的领域记忆（路由结果）*/
  readonly favoredDomain?: DomainId;
  /**
   * 语义相似度（memoryId → cosine）。
   * 由调用方在适配器层算好后传入；核心层不加载模型。
   */
  readonly semantic?: ReadonlyMap<string, number>;
  /** 语义阈值；缺省读 MEMORY_SEMANTIC_THRESHOLD（默认 0.35） */
  readonly semanticThreshold?: number;
  /**
   * 语义 top-k 补充通道的候选数。0 表示关闭（保持旧的“过阈值才补充”行为）。
   *
   * ★ 只由调用方显式开启；默认关闭，避免无精排时把低分候选直接放进结果。
   */
  readonly semanticTopK?: number;
  /** top-k 补充通道的相似度下限，默认 0.30。 */
  readonly semanticFloor?: number;
}

// ═══════════════════════════════════════════════════════════
// 打分
// ═══════════════════════════════════════════════════════════

/**
 * 计算一条记忆与查询的相关性。
 *
 * 用关键词重合度（复用 core/text 的判定），不引入向量库 ——
 * 项目规模（几百条记忆）下关键词匹配足够，且**确定性可重放**，
 * 而向量检索需要外部服务，会破坏 ADR 0004 的确定性要求。
 *
 * 硬约束特殊处理：**恒为 1.0**。安全不能靠匹配分数，
 * 用户的过敏史必须在任何相关场景下都被召回。
 */
export function relevanceOf(memory: MemoryEntry, query: string): number {
  if (memory.memClass === 'global_constraint') return 1;

  if (!isRelevant(query, memory.content)) return 0;

  // 命中即给基础分，长度接近时略加分（避免极短记忆靠 2-gram 蹭分）
  const core = memory.content.length;
  const q = query.length;
  const lengthRatio = Math.min(core, q) / Math.max(core, q);
  return Math.min(1, 0.7 + 0.3 * lengthRatio);
}

/** 综合打分（方案 § 8.3 第二层"注入机会竞争"） */
export function scoreMemory(
  memory: MemoryEntry,
  query: string,
  favoredDomain?: DomainId,
  semantic?: ReadonlyMap<string, number>,
  semanticThreshold: number = SEMANTIC_RELEVANCE_THRESHOLD,
): Omit<ScoredMemory, 'exploratory' | 'why'> {
  let relevance = relevanceOf(memory, query);

  // 语义只补字面漏掉的候选；低于门槛的相似度不参与（避免无关记忆被放进来）。
  const semanticScore = semantic?.get(memory.id);
  if (
    memory.memClass !== 'global_constraint' &&
    semanticScore !== undefined &&
    semanticScore >= semanticThreshold &&
    semanticScore > relevance
  ) {
    relevance = semanticScore;
  }

  // 路由已确定主责仆人时，该仆人的领域记忆获得相关性加成 ——
  // 但**不加成硬约束**（它已经是 1.0，且不该被领域偏好挤掉）
  if (
    favoredDomain !== undefined &&
    memory.memClass === 'domain' &&
    memory.domain === favoredDomain
  ) {
    relevance = Math.min(1, relevance + 0.15);
  }

  const rawScore =
    RECALL_WEIGHTS.relevance * relevance +
    RECALL_WEIGHTS.fitness * memory.fitness +
    RECALL_WEIGHTS.confidence * memory.confidence;
  const score = isDiaryTrial(memory) ? rawScore * TRIAL_SCORE_WEIGHT : rawScore;

  return { memory, score, relevance, fitness: memory.fitness, confidence: memory.confidence };
}

// ═══════════════════════════════════════════════════════════
// 召回主流程
// ═══════════════════════════════════════════════════════════

export function recall(args: RecallArgs): RecallResult {
  const params = args.params ?? DEFAULT_PARAMS;
  const semanticThreshold = args.semanticThreshold ?? retrievalConfig.semanticThreshold;
  const semanticTopK = Math.max(0, Math.floor(args.semanticTopK ?? 0));
  const semanticFloor = args.semanticFloor ?? SEMANTIC_CANDIDATE_FLOOR;

  /**
   * ── ① 活跃 / 休眠 / 归档，以及日记产生的试行候选 ──
   *
   * ⚠️ 硬约束**不需要在这里特判** —— `relevanceOf` 已经对
   *    `global_constraint` 恒返回 1.0，所以它永远不会被
   *    `relevance > 0` 或阈值挡掉。
   *
   *    （我曾在这里加过一段"强制带回硬约束"的代码，读 `relevanceOf`
   *      后发现是冗余的 —— 纪律：**读清楚已有的判定再动手**，
   *      多加一层特判会让"谁在保证安全"变得没人说得清。）
   */
  const eligible = args.candidates.filter(
    (m) =>
      m.lifecycle === 'active' ||
      m.lifecycle === 'dormant' ||
      m.lifecycle === 'archived' ||
      isDiaryTrial(m),
  );

  /**
   * ── ①b ★ 语义 top-k 补充通道 ──
   *
   * ⚠️ 这不是把阈值降到 0.30。它只挑**语义最靠前的少量候选**，
   *    低于 0.35 的候选只有进入这个通道后才允许参与打分；
   *    最终是否留下由精排（调用方）决定。没有精排时不要开启
   *    （`semanticTopK` 默认 0），否则负例会直接进结果。
   */
  const supplemented = new Set<string>();
  if (semanticTopK > 0 && args.semantic !== undefined) {
    const ranked = eligible
      .filter((m) => m.memClass !== 'global_constraint')
      .map((m) => ({ memory: m, score: args.semantic?.get(m.id) ?? 0 }))
      .filter((x) => Number.isFinite(x.score) && x.score >= semanticFloor)
      .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
      .slice(0, semanticTopK);
    for (const x of ranked) supplemented.add(x.memory.id);
  }

  // ── ② 打分并按分数降序（同分时按 id 保证确定性）──
  const scored = eligible
    .map((m) => ({
      ...scoreMemory(
        m,
        args.query,
        args.favoredDomain,
        args.semantic,
        supplemented.has(m.id) ? semanticFloor : semanticThreshold,
      ),
      exploratory: false,
      why: '',
    }))
    .filter((s) => s.relevance > 0)
    .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));

  // ── ③ 阈值筛选：库越大阈值越高（第三层参数演化）──
  const threshold = adaptThreshold(args.candidates.length, params.recallThresholdBase);
  const above = scored.filter((s) => s.score >= threshold);
  const filteredOut = scored.length - above.length;

  // ── ④ 多样性保护：同类至少保留 N 条（§ 8.5 防过度剪枝）──
  const selected = enforceDiversity(above, scored, params);

  const result: ScoredMemory[] = selected.map((s) => ({
    memory: s.memory,
    score: s.score,
    relevance: s.relevance,
    fitness: s.fitness,
    confidence: s.confidence,
    exploratory: false,
    why: explain(
      s,
      threshold,
      supplemented.has(s.memory.id) && s.relevance < semanticThreshold,
    ),
  }));

  // ── ⑤ 探索性召回：留 ε 名额给"分数不够但可能是对的"记忆（§ 8.5 防局部最优）──
  const exploreSlots = Math.max(
    result.length > 0 || args.limit > 0
      ? Math.floor(args.limit * params.exploratoryRatio)
      : 0,
    0,
  );
  if (exploreSlots > 0) {
    const chosen = new Set(result.map((s) => s.memory.id));
    const pool = scored.filter((s) => !chosen.has(s.memory.id));
    const picks = pickExploratory(pool, exploreSlots, args.random);

    for (const p of picks) {
      result.push({
        memory: p.memory,
        score: p.score,
        relevance: p.relevance,
        fitness: p.fitness,
        confidence: p.confidence,
        exploratory: true,
        why: `探索性召回：适应度 ${p.fitness.toFixed(2)} 偏低，按 ${Math.round(
          params.exploratoryRatio * 100,
        )}% 探索比例注入以验证是否仍适用`,
      });
    }
  }

  // ── ⑥ 截断到名额 ──
  const finalList = result
    .sort((a, b) => {
      // 非探索项优先；再按分数
      if (a.exploratory !== b.exploratory) return a.exploratory ? 1 : -1;
      return b.score - a.score || a.memory.id.localeCompare(b.memory.id);
    })
    .slice(0, args.limit);

  return {
    selected: finalList,
    threshold,
    candidateCount: args.candidates.length,
    filteredOut,
    ...(supplemented.size > 0 ? { supplemented: [...supplemented] } : {}),
  };
}

/** 解释为什么这条被召回（可解释性 —— 用户能问"你为什么想起这件事"）。 */
function explain(
  s: { relevance: number; fitness: number; confidence: number },
  threshold: number,
  semanticSupplement = false,
): string {
  const parts: string[] = [];
  if (s.relevance >= 0.99) parts.push('硬约束，无条件召回');
  else if (semanticSupplement) parts.push(`语义 top-k 补充（${s.relevance.toFixed(2)}）`);
  else if (s.relevance > 0) parts.push(`与目标相关（${s.relevance.toFixed(2)}）`);
  parts.push(`适应度 ${s.fitness.toFixed(2)}`);
  parts.push(`置信度 ${s.confidence.toFixed(2)}`);
  parts.push(`综合 ${(s.relevance * RECALL_WEIGHTS.relevance + s.fitness * RECALL_WEIGHTS.fitness + s.confidence * RECALL_WEIGHTS.confidence).toFixed(2)} ${threshold > 0 ? `≥ 阈值 ${threshold.toFixed(2)}` : ''}`);
  return parts.join(' · ');
}

/**
 * 多样性保护：同一 kind 至少保留 N 条。
 *
 * 即使它们的分数低于后来者 —— 否则少数高分记忆会把同类全部挤掉，
 * 系统逐渐只会说同一件事（§ 8.5"过度剪枝"）。
 * **硬约束不参与多样性竞争**（它本来就全都会被召回）。
 */
function enforceDiversity(
  above: readonly ScoredMemory[],
  all: readonly ScoredMemory[],
  params: EvolutionParams,
): ScoredMemory[] {
  const byKind = new Map<MemoryKind, ScoredMemory[]>();
  for (const s of all) {
    if (s.memory.memClass === 'global_constraint') continue;
    const list = byKind.get(s.memory.kind) ?? [];
    list.push(s);
    byKind.set(s.memory.kind, list);
  }

  const out = [...above];
  const has = new Set(out.map((s) => s.memory.id));

  for (const [, list] of byKind) {
    const kept = list.filter((s) => has.has(s.memory.id)).length;
    for (let i = kept; i < params.diversityMinPerKind; i++) {
      const cand = list[i];
      if (!cand) break;
      if (has.has(cand.memory.id)) continue;
      out.push(cand);
      has.add(cand.memory.id);
    }
  }

  return out;
}

/**
 * 挑探索项。
 *
 * 刻意**偏向休眠与归档的记忆** —— 它们才是"可能过时、需要验证"的对象。
 * 一直活跃的高分记忆不需要探索。
 */
function pickExploratory(
  pool: readonly ScoredMemory[],
  slots: number,
  random: RandomPort,
): ScoredMemory[] {
  const interesting = pool.filter(
    (s) => s.memory.lifecycle === 'dormant' || s.memory.lifecycle === 'archived',
  );
  const source = interesting.length > 0 ? interesting : pool;
  if (source.length === 0) return [];

  const picked: ScoredMemory[] = [];
  const used = new Set<number>();
  for (let i = 0; i < slots && used.size < source.length; i++) {
    const idx = Math.floor(random.next() * source.length);
    if (used.has(idx)) continue;
    used.add(idx);
    const s = source[idx];
    if (s) picked.push(s);
  }
  return picked;
}
