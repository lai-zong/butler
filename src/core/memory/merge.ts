/**
 * 相似合并 —— 演化第二层「种群选择」的最后一个机制
 *
 * 设计依据：方案 § 8.3 第二层
 *
 * ★ 为什么必须合并：
 *   反思会反复产出近义候选 —— 用户说十次"想吃清淡的"，
 *   就可能出现十条意思差不多的偏好。记忆总量持续增长，
 *   而召回名额固定，**冗余会挤掉真正有用的记忆**。
 *
 *   方案原文："语义相近的多条记忆合并为一条（如'喜欢清淡'与'不爱油腻'），
 *              减少冗余"
 *
 * ⚠️ 三条纪律：
 *   ① **合并是可追溯的**：新条目记录 `mergedFrom`，旧条目标记被合并而非删除
 *   ② **证据与效果要累加**：合并后证据链变长、适应度取加权值，不能丢历史
 *   ③ **硬约束永不合并**：把"花生过敏"与"坚果过敏"合并成一条是危险的 ——
 *      即使它们语义相近，安全约束必须逐条独立
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { MemoryStore } from './store.js';
import { similarity } from './sink.js';
import type { MemoryEntry } from './types.js';

// ═══════════════════════════════════════════════════════════
// 合并判据
// ═══════════════════════════════════════════════════════════

/** 相似度阈值：达到即视为"同一件事的不同说法"。 */
export const MERGE_SIMILARITY = 0.72;

/**
 * 相似但不完全等同的区间 —— 这一区间**不自动合并**，只提示。
 *
 * 为什么不自动：0.72—0.85 之间可能是"同一件事"，也可能是"两件相近的事"。
 * 自动合并会把后者错误地压成一条（信息丢失且不可逆）。
 * 提示用户由人判断，是更稳的做法 —— 与"候选审核制"同一立场。
 */
export const MERGE_SUGGEST_FLOOR = 0.55;

export interface MergeCandidate {
  readonly keep: MemoryEntry;
  readonly absorb: MemoryEntry;
  readonly similarity: number;
  /** 合并后的内容（选信息量更大的那条为主体） */
  readonly mergedContent: string;
  readonly reason: string;
}

export interface MergeSuggestion {
  readonly a: MemoryEntry;
  readonly b: MemoryEntry;
  readonly similarity: number;
  readonly reason: string;
}

// ═══════════════════════════════════════════════════════════
// 扫描
// ═══════════════════════════════════════════════════════════

/**
 * 扫描出可以自动合并的组合。
 *
 * ⚠️ 硬约束被完全排除在合并之外 —— 见文件头的纪律 ③。
 */
export function findMergeCandidates(store: MemoryStore): readonly MergeCandidate[] {
  const out: MergeCandidate[] = [];
  for (const p of scanPairs(store)) {
    if (p.similarity < MERGE_SIMILARITY) continue;
    out.push({
      keep: p.keep,
      absorb: p.absorb,
      similarity: p.similarity,
      mergedContent: pickContent(p.keep, p.absorb),
      reason:
        `语义相似度 ${(p.similarity * 100).toFixed(0)}%：` +
        `「${p.absorb.content}」并入「${p.keep.content}」`,
    });
  }
  return out;
}

/**
 * 找出**建议**合并但不确定的组合（交给用户判断）。
 *
 * ⚠️ 与自动合并**互斥**：同一对记忆只会出现在一个列表里。
 *    我第一版用"两条都在自动集合里才排除"，于是"一条能被自动合并、
 *    另一条不能"的组合会**同时**出现在两个列表 —— 用户被重复打扰。
 *    改为按相似度分区，天然互斥。
 */
export function findMergeSuggestions(store: MemoryStore): readonly MergeSuggestion[] {
  const out: MergeSuggestion[] = [];
  for (const p of scanPairs(store)) {
    if (p.similarity < MERGE_SUGGEST_FLOOR) continue;
    if (p.similarity >= MERGE_SIMILARITY) continue; // 归自动合并
    out.push({
      a: p.keep,
      b: p.absorb,
      similarity: p.similarity,
      reason:
        `相似度 ${(p.similarity * 100).toFixed(0)}% —— 可能是同一件事，也可能是两件相近的事。` +
        '交给你判断是否合并。',
    });
  }
  return out;
}

/**
 * 统一枚举"值得考虑的配对"。
 *
 * ★ 两个入口共用同一套枚举逻辑，保证判定口径一致 ——
 *   否则两个列表的边界会漂移（第一版就是这么错的）。
 *
 * 每个条目只参与一次配对（`consumed`），且结果按相似度降序 ——
 * 让最该合并的先被处理，也保证同一批输入产出同一份计划（可重放）。
 */
function scanPairs(
  store: MemoryStore,
): readonly { keep: MemoryEntry; absorb: MemoryEntry; similarity: number }[] {
  const pool = store.all().filter(canMerge);
  const pairs: { keep: MemoryEntry; absorb: MemoryEntry; similarity: number }[] = [];

  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (!a) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j];
      if (!b) continue;
      if (!compatible(a, b)) continue;

      const sim = similarity(a.content, b.content);
      if (sim < MERGE_SUGGEST_FLOOR) continue;

      pairs.push({ keep: betterOf(a, b), absorb: betterOf(a, b).id === a.id ? b : a, similarity: sim });
    }
  }

  // 相似度降序 → 同一批输入结果稳定；再按 id 打破平手，避免顺序依赖
  pairs.sort((x, y) => {
    if (y.similarity !== x.similarity) return y.similarity - x.similarity;
    return x.keep.id.localeCompare(y.keep.id) || x.absorb.id.localeCompare(y.absorb.id);
  });

  // 每条记忆只参与一次配对
  const consumed = new Set<string>();
  const out: typeof pairs = [];
  for (const p of pairs) {
    if (consumed.has(p.keep.id) || consumed.has(p.absorb.id)) continue;
    consumed.add(p.keep.id);
    consumed.add(p.absorb.id);
    out.push(p);
  }

  return out;
}

// ═══════════════════════════════════════════════════════════
// 执行合并
// ═══════════════════════════════════════════════════════════

export interface MergeOutcome {
  readonly merged: MemoryEntry;
  readonly absorbedIds: readonly string[];
  /** 合并后的证据条数（应当 > 合并前任一条） */
  readonly evidenceCount: number;
  readonly fitnessBefore: { readonly keep: number; readonly absorb: number };
  readonly fitnessAfter: number;
}

/**
 * 执行合并。
 *
 * ★ 三条纪律的落实：
 *   ① 新条目记录 `mergedFrom`；旧条目**归档而非删除**（可追溯、可回滚）
 *   ② 证据链累加去重；适应度取**加权平均**（按证据数加权，不是简单平均）
 *   ③ 硬约束在 `canMerge` 里已被排除，这里再断言一次（双保险）
 */
export function mergeMemories(args: {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  readonly candidate: MergeCandidate;
}): MergeOutcome | null {
  const { keep, absorb } = args.candidate;

  // 双保险：即便调用方绕过 findMergeCandidates，这里也拦住
  if (!canMerge(keep) || !canMerge(absorb)) return null;

  const now = args.clock.now();

  // 合并后的内容：以 keep 为主体（findMergeCandidates 已选好）
  const merged = args.store.create(
    { kind: 'butler', userId: ownerUserId(keep) },
    {
      memClass: keep.memClass,
      kind: keep.kind,
      content: args.candidate.mergedContent,
      confidence: weightedConfidence(keep, absorb),
      // 证据链累加（去重）
      evidence: [...new Set([...keep.evidence, ...absorb.evidence])],
      lifecycle: 'active',
      ...(keep.owner.kind === 'servant' ? { domainOwner: keep.owner.servant } : {}),
      ...(keep.subject !== undefined ? { subject: keep.subject } : {}),
    },
  );

  if (!merged.ok) return null;

  const id = merged.entry.id;

  // 适应度：按证据数加权平均 —— 证据多的那条更有发言权
  const wk = Math.max(1, keep.evidence.length);
  const wa = Math.max(1, absorb.evidence.length);
  const fitnessAfter = (keep.fitness * wk + absorb.fitness * wa) / (wk + wa);

  args.store.setFitness(id, fitnessAfter);
  args.store.setMergedFrom(id, [keep.id, absorb.id]);

  // 原则的条件/动作一并继承（否则合并后的原则无法被注入）
  if (keep.principle !== undefined) args.store.setPrincipleDetail(id, keep.principle);
  else if (absorb.principle !== undefined) args.store.setPrincipleDetail(id, absorb.principle);

  // 效果跟踪累加
  const ek = keep.effectiveness;
  const ea = absorb.effectiveness;
  if (ek || ea) {
    args.store.setEffectiveness(id, {
      applied: (ek?.applied ?? 0) + (ea?.applied ?? 0),
      succeeded: (ek?.succeeded ?? 0) + (ea?.succeeded ?? 0),
      lastAppliedAt: Math.max(ek?.lastAppliedAt ?? 0, ea?.lastAppliedAt ?? 0),
    });
  }

  // ★ 旧条目归档而非删除 —— 可追溯、可回滚（与"淘汰≠删除"同一立场）
  args.store.setLifecycle(keep.id, 'archived', { archivedAt: now });
  args.store.setLifecycle(absorb.id, 'archived', { archivedAt: now });

  args.log.append({
    type: 'memory.merged',
    actor: 'butler',
    payload: {
      mergedId: id,
      mergedContent: args.candidate.mergedContent,
      from: [keep.id, absorb.id],
      fromContents: [keep.content, absorb.content],
      similarity: Number(args.candidate.similarity.toFixed(3)),
      evidenceCount: merged.entry.evidence.length,
      fitnessAfter: Number(fitnessAfter.toFixed(3)),
      // 明确记录旧条目仍可查，不是删除
      absorbedRetained: true,
    },
    createdAt: now,
  });

  return {
    merged: args.store.get(id) ?? merged.entry,
    absorbedIds: [keep.id, absorb.id],
    evidenceCount: merged.entry.evidence.length,
    fitnessBefore: { keep: keep.fitness, absorb: absorb.fitness },
    fitnessAfter,
  };
}

/**
 * 批量合并。
 *
 * 返回每组的合并结果；任何一组失败不影响其它组 ——
 * 合并是**优化**而非**必需**，不该因为一条出问题就全盘停下。
 */
export function mergeAll(args: {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
}): readonly MergeOutcome[] {
  const candidates = findMergeCandidates(args.store);
  const out: MergeOutcome[] = [];
  for (const c of candidates) {
    // 每次重新取条目 —— 前一组合并会改变 store 状态
    const fresh: MergeCandidate = {
      ...c,
      keep: args.store.get(c.keep.id) ?? c.keep,
      absorb: args.store.get(c.absorb.id) ?? c.absorb,
    };
    const r = mergeMemories({ ...args, candidate: fresh });
    if (r) out.push(r);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 内部
// ═══════════════════════════════════════════════════════════

/**
 * 能否参与合并。
 *
 * ★ 排除项（每条都有理由）：
 *   · `global_constraint` —— **安全约束必须逐条独立**。
 *     "花生过敏"与"坚果过敏"语义相近，合并成一条是危险的。
 *   · `candidate` —— 还没审核的候选不该被合并（可能整条被用户拒绝）
 *   · `sensitive` —— 敏感域内容合并会模糊授权边界
 */
export function canMerge(m: MemoryEntry): boolean {
  if (m.memClass === 'global_constraint') return false;
  if (m.memClass === 'sensitive') return false;
  if (m.lifecycle === 'candidate') return false;
  if (m.lifecycle === 'archived') return false;
  return true;
}

/** 两条记忆是否属于同一个"合并池"（层级与归属一致才可比）。 */
function compatible(a: MemoryEntry, b: MemoryEntry): boolean {
  if (a.memClass !== b.memClass) return false;
  if (a.kind !== b.kind) return false;
  if (a.memClass === 'domain') {
    const sa = a.owner.kind === 'servant' ? a.owner.servant : undefined;
    const sb = b.owner.kind === 'servant' ? b.owner.servant : undefined;
    if (sa !== sb) return false;
  }
  // 原则合并要特别小心：条件不同的原则不该合并
  if (a.kind === 'principle') {
    const ca = a.principle?.condition;
    const cb = b.principle?.condition;
    if (ca !== undefined && cb !== undefined && similarity(ca, cb) < MERGE_SIMILARITY) return false;
  }
  return true;
}

/** 选信息量更大、适应度更高的那条作为合并主体。 */
function betterOf(a: MemoryEntry, b: MemoryEntry): MemoryEntry {
  const scoreA = infoScore(a);
  const scoreB = infoScore(b);
  return scoreB > scoreA ? b : a;
}

function infoScore(m: MemoryEntry): number {
  return m.content.length * 0.4 + m.evidence.length * 20 + m.fitness * 50 + m.confidence * 20;
}

/** 合并内容：主体内容 + 从吸收方补充的、主体没有的信息。 */
function pickContent(keep: MemoryEntry, absorb: MemoryEntry): string {
  const k = keep.content.trim();
  const a = absorb.content.trim();
  if (a === k || k.includes(a)) return k;
  if (a.includes(k)) return a;
  // 都不包含对方：保留主体（信息量更大），不拼接 ——
  // 拼接会让内容越来越长且难读，而证据与适应度已经累加了
  return k.length >= a.length ? k : a;
}

/** 置信度按证据数加权。 */
function weightedConfidence(a: MemoryEntry, b: MemoryEntry): number {
  const wa = Math.max(1, a.evidence.length);
  const wb = Math.max(1, b.evidence.length);
  return Math.min(1, (a.confidence * wa + b.confidence * wb) / (wa + wb));
}

function ownerUserId(m: MemoryEntry): string {
  return m.owner.userId;
}

/** 合并统计（供界面"本月合并了 N 条"展示）。 */
export function mergeStats(log: EventLog): { readonly count: number; readonly absorbed: number } {
  const evs = log.byType('memory.merged');
  let absorbed = 0;
  for (const e of evs) {
    const from = (e.payload as { from?: unknown }).from;
    if (Array.isArray(from)) absorbed += from.length;
  }
  return { count: evs.length, absorbed };
}
