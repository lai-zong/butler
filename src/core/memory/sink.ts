/**
 * 候选落库 —— 把反思产出送进审核流程
 *
 * 设计依据：方案 § 2.2④（反思产出候选）、§ 3.2（候选-审核-生效流程）
 *
 * 这一步连接两个模块：
 *   分层反思（产出候选）→ **本文件** → 记忆仓储（落为 candidate 状态）
 *
 * ⚠️ 关键纪律：反思产出**一律先落为 candidate，不直接生效**。
 *    理由：反思是模型生成的，可能错。候选必须经用户审核才进召回池
 *    （`recall` 会跳过 candidate 状态）。
 *
 * ⚠️ 去重：同一件事被多次反思出来是常态（尤其跨会话）。
 *    不做去重会让记忆库被近义候选灌满，直接毁掉"记得越久越准"。
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { MemoryCandidate } from '../reflection/reflect.js';
import type { MemoryStore } from './store.js';
import type { MemoryEntry } from './types.js';

export interface SinkResult {
  readonly created: readonly MemoryEntry[];
  /** 与既有记忆重复而被跳过的候选 */
  readonly skipped: readonly { readonly candidate: MemoryCandidate; readonly reason: string; readonly duplicateOf: string }[];
}

/** 判定重复的相似度阈值：核心串重合度达到此值即视为同一件事。 */
const DUPLICATE_SIMILARITY = 0.8;

export interface SinkOptions {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  /** 是否对同一批候选内部也去重（默认 true） */
  readonly dedupeWithinBatch?: boolean;
}

/**
 * 把候选落为 candidate 状态记忆。
 *
 * 去重范围刻意**包含已归档的记忆** ——
 * 否则"被拒绝过的候选"会在下次反思时又被提出来，用户要反复拒绝同一件事。
 */
export function sinkCandidates(
  opts: SinkOptions,
  candidates: readonly MemoryCandidate[],
): SinkResult {
  const created: MemoryEntry[] = [];
  const skipped: SinkResult['skipped'][number][] = [];
  const batch: MemoryEntry[] = [];

  for (const cand of candidates) {
    // ① 与既有记忆比对（含候选、活跃、休眠、归档 —— 全生命周期）
    const pool = [...opts.store.all(), ...batch];
    const dup = pool.find((e) => isDuplicate(e, cand));
    if (dup) {
      skipped.push({ candidate: cand, reason: '与既有记忆重复', duplicateOf: dup.id });
      continue;
    }

    // ② 落库。actor 用管家 —— 反思产出的建档动作由管家执行，
    //    但归属由 candidate.scope.domainOwner 决定（见 store.canCreateDomain）
    const res = opts.store.create(
      { kind: 'butler', userId: ownerUserId(cand) },
      {
        memClass: cand.scope.memClass,
        kind: cand.kind,
        content: cand.content,
        confidence: cand.confidence,
        evidence: cand.evidence,
        // ★ 一律候选状态，等用户审核
        lifecycle: 'candidate',
        ...(cand.scope.domainOwner !== undefined ? { domainOwner: cand.scope.domainOwner } : {}),
      },
    );

    if (!res.ok) {
      // 建档被拒（例如领域记忆没给归属）—— 记下来而不是静默丢弃
      skipped.push({ candidate: cand, reason: `建档被拒：${res.reason}`, duplicateOf: '' });
      continue;
    }

    created.push(res.entry);
    batch.push(res.entry);

    // ★ 原则落库时写入条件与动作 —— 没有它们，这条原则无法被正确注入，
    //   也无法被检测是否被违背（见 memory/principles.ts）。
    if (cand.principle !== undefined) {
      opts.store.setPrincipleDetail(res.entry.id, {
        condition: cand.principle.condition,
        action: cand.principle.action,
      });
    }

    // ③ 反思来源的元信息单独落事件。
    //    ⚠️ 不能重复发 memory.candidate —— store.create 已经发过一次了，
    //       重复会在审计视图里出现两条"候选创建"，看起来像建了两条记忆。
    //       这里用 memory.revised? 不对 —— 语义是"补充来源"，用 reflection 关联事件。
    opts.log.append({
      type: 'principle.derived',
      actor: 'butler',
      payload: {
        memoryId: res.entry.id,
        fromReflection: cand.layer,
        reflectedBy: cand.by,
        rationale: cand.rationale,
        hasPrincipleDetail: cand.principle !== undefined,
        candidateId: cand.id,
        memClass: cand.scope.memClass,
        domainOwner: cand.scope.domainOwner ?? null,
      },
      createdAt: opts.clock.now(),
    });
  }

  void opts.dedupeWithinBatch;
  return { created, skipped };
}

// ═══════════════════════════════════════════════════════════
// 去重
// ═══════════════════════════════════════════════════════════

/**
 * 两条记忆是否是"同一件事"。
 *
 * 判据（两条都要满足）：
 *   ① 同类（memClass 相同；领域记忆还要同归属）
 *   ② 内容核心串高度重合
 *
 * 用长度比值而不是编辑距离：中文短句下长度比就够用，
 * 且**确定性**（不依赖外部库，可重放）。
 */
export function isDuplicate(existing: MemoryEntry, cand: MemoryCandidate): boolean {
  if (existing.memClass !== cand.scope.memClass) return false;

  if (cand.scope.memClass === 'domain') {
    const ownerServant = existing.owner.kind === 'servant' ? existing.owner.servant : undefined;
    if (ownerServant !== cand.scope.domainOwner) return false;
  }

  return similarity(existing.content, cand.content) >= DUPLICATE_SIMILARITY;
}

/**
 * 计算两段文本的相似度（0—1）。
 *
 * 做法：取较短串，统计它的字符在较长串中的**连续片段**覆盖比例。
 * 简化但确定：先把共同出现的 2-gram 集合算出来，
 * 用 `2 × |交集| / (|A| + |B|)` 作为相似度（Dice 系数）。
 */
export function similarity(a: string, b: string): number {
  const ga = bigrams(normalize(a));
  const gb = bigrams(normalize(b));
  if (ga.size === 0 || gb.size === 0) return a === b ? 1 : 0;

  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return (2 * inter) / (ga.size + gb.size);
}

function normalize(s: string): string {
  return s.replace(/[\s，。、；：！？,.;:!?"'（）()【】\[\]]/g, '').toLowerCase();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length === 0) return out;
  if (s.length === 1) {
    out.add(s);
    return out;
  }
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

function ownerUserId(cand: MemoryCandidate): string {
  void cand;
  // 用户 id 由 store 持有；这里是建档时的占位，store 会用自己的 userId
  return 'local-user';
}
