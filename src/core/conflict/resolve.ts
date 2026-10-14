/**
 * 跨领域冲突裁决 —— 创新点 ③「学得不矛盾」
 *
 * 设计依据：方案 § 2.1（唯一裁决者是管家）、§ 2.2⑤、§ 8.8
 *
 * ★ 核心纪律：**管家是唯一的裁决者，仆人之间谁也不能否决谁。**
 *
 *   硬约束 → 管家**机械拦截**（确定性代码，见 butler/hardConstraints.ts）
 *   软约束 → **上报用户裁决**（管家不替用户决定）
 *
 *   裁决结果落事件、落记忆状态（胜方 succeeded+1、败方降权但保留），
 *   并可固化为原则 —— 下次遇到同类冲突就能自动裁决，不用再问用户。
 *
 * ★ 为什么"可固化"很重要：
 *   如果每次冲突都要问用户，用户会被问烦；而自动裁决若无依据就是黑盒。
 *   固化路径解决了这个两难：
 *     第一次冲突 → 问用户 → 用户选择 → **固化为原则**
 *     同类冲突再现 → 命中原则 → 自动裁决 → 事件里说明依据
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { MemoryStore } from '../memory/store.js';
import type { MemoryConflict, ConflictResolution, ServantId } from '../servants/types.js';
import { isRelevant } from '../text/keywords.js';

// ═══════════════════════════════════════════════════════════
// 裁决类型
// ═══════════════════════════════════════════════════════════

/** 冲突双方各自的立场。 */
export interface ConflictSide {
  readonly servant: ServantId;
  /** 该方的主张（一句话） */
  readonly claim: string;
  /** 支撑证据 */
  readonly evidence: readonly string[];
  /** 这条主张背后引用的记忆（用于事后做效果验证） */
  readonly memoryIds: readonly string[];
}

/** 用户（或管家依据原则）的裁决。 */
export interface Verdict {
  readonly conflictId: string;
  /** 采纳哪一方 */
  readonly winner: ServantId | 'none';
  /** 'user' = 用户亲自裁决；'principle' = 依据已固化原则自动裁决 */
  readonly decidedBy: 'user' | 'principle';
  /** 依据说明（用户的话或命中的原则） */
  readonly reason: string;
  /** 命中自动裁决时，是哪条原则 */
  readonly principleId?: string;
  /** 用户是否要求把这次选择固化为原则（下次同类冲突自动裁决） */
  readonly makePrinciple?: boolean;
}

/** 裁决结果（含落到记忆上的效果）。 */
export interface VerdictOutcome {
  readonly verdict: Verdict;
  /** 被采纳方的记忆：succeeded +1 */
  readonly winners: readonly string[];
  /** 落败方的记忆：适应度下降但仍保留 */
  readonly losers: readonly {
    readonly memoryId: string;
    readonly fitnessBefore: number;
    readonly fitnessAfter: number;
  }[];
  /** 固化为原则时的候选（需用户审核后才生效 —— 与反思产出一致） */
  readonly principleCandidate?: {
    readonly content: string;
    readonly condition: string;
    readonly action: string;
    readonly fromVerdict: string;
  };
}

// ═══════════════════════════════════════════════════════════
// 自动裁决（依据已固化原则）
// ═══════════════════════════════════════════════════════════

export interface AutoVerdictResult {
  readonly verdict: Verdict;
  /** 依据的原则内容（供事件与界面展示） */
  readonly principleContent: string;
}

/**
 * 尝试依据**已生效原则**自动裁决。
 *
 * 适用前提：用户此前遇到同类冲突并选择过"固化为原则"。
 *
 * ⚠️ 判定"偏袒哪一方"有个陷阱（我第一版就踩了）：
 *    `isRelevant` 判的是"**提到了**某个概念"，不是"**偏向**谁"。
 *    而固化出来的原则动作往往同时提到双方 ——
 *    "当健康与生活的建议冲突时，采用健康一方" 里 health 和 life 都出现。
 *    于是 `parties.find(...)` 会返回数组里第一个，**必然选错**。
 *
 *    正确判据：原则必须**只提到一方**才算明确偏袒；
 *    双方都提到（措辞是对比式）或都没提到 → 无法裁决，交回用户。
 */
export function tryAutoVerdict(args: {
  readonly store: MemoryStore;
  readonly conflict: {
    readonly message: string;
    readonly parties: readonly ServantId[];
    /**
     * 冲突双方的仆人对应关系。
     *
     * 用于判断"原则偏袒谁"：需要知道哪一方是**对立面**，
     * 才能确定"只提到 A 而没提到 B"意味着偏袒 A。
     */
    readonly opposing?: readonly ServantId[];
  };
}): AutoVerdictResult | null {
  const principles = args.store
    .all()
    .filter((m) => m.kind === 'principle' && m.lifecycle === 'active' && m.principle !== undefined);

  // 按效果排序：奏效率高的优先 —— 这是"优胜劣汰"在裁决路径上的体现
  const ordered = [...principles].sort((a, b) => {
    const ra =
      a.effectiveness && a.effectiveness.applied > 0
        ? a.effectiveness.succeeded / a.effectiveness.applied
        : 0.5;
    const rb =
      b.effectiveness && b.effectiveness.applied > 0
        ? b.effectiveness.succeeded / b.effectiveness.applied
        : 0.5;
    return rb - ra;
  });

  const parties = args.conflict.parties;

  for (const p of ordered) {
    const detail = p.principle;
    if (!detail) continue;

    // 条件必须与本次冲突相关，否则不该套用
    if (!isRelevant(args.conflict.message, detail.condition)) continue;

    // ★ 按中文偏向标记判定，而不是按"提到了谁"
    const scores = parties.map((party) => ({ party, score: prefersParty(detail.action, party) }));
    const positive = scores.filter((s) => s.score > 0);

    // 必须**恰好一方**明确得分，否则无法裁决 → 交回用户
    if (positive.length !== 1) continue;
    const favored = positive[0]?.party;
    if (favored === undefined) continue;

    return {
      verdict: {
        conflictId: '',
        winner: favored,
        decidedBy: 'principle',
        reason: `依据已生效原则：「${p.content}」`,
        principleId: p.id,
      },
      principleContent: p.content,
    };
  }

  return null;
}

/** 仆人领域的中文标签（用于在原则动作里识别「偏袒哪一方」）。 */
const SERVANT_LABEL: Record<ServantId, string> = {
  life: '生活',
  health: '健康',
  study: '学习',
  work: '办公',
  code: '代码',
};

/**
 * 判断原则动作里**偏袒**哪一方。
 *
 * ⚠️ 这里有个中文语序的坑，我连错两版才想清楚：
 *
 *   第一版：用 `isRelevant` 找「提到了哪一方」→ **两边都返回 true**，
 *           `find` 于是返回数组第一个，必然选错。
 *   第二版：要求「只提到一方」→ **两边仍然都提到**（"健康优先于生活"里两个词都在），
 *           结果判不出，全部退回用户。
 *
 *   根因：**「提到」不等于「偏向」**。
 *   中文的偏向有**语法标记**：
 *     · `X 优先` / `X 一方` / `采用 X` / `X 为准`  → 偏向 X
 *     · `X 让位` / `X 服从` / `X 次于`              → X 是让步方
 *
 *   所以改为按标记计分，**只在一方明确得分、另一方不得分时**才裁决。
 *   找不到明确标记就交回用户 —— 宁可多问一次，也不猜错。
 */
export function prefersParty(action: string, party: ServantId): number {
  const label = SERVANT_LABEL[party];
  let score = 0;

  // 正面标记：明确表示"采用这一方"
  const forX = [
    `${label}[^，。；,;]{0,6}一方`, // 「采用健康一方」
    `${label}[^，。；,;]{0,4}优先`, // 「健康优先于生活」
    `${label}[^，。；,;]{0,4}为准`, // 「以健康为准」
    `(采用|采纳|选择|取|按)[^，。；,;]{0,3}${label}`, // 「采用健康」
  ];
  for (const p of forX) if (new RegExp(p).test(action)) score += 1;

  // 负面标记：明确表示"这一方让步"
  //
  // ⚠️ 必须用 `让位`/`服从` 这类**完整词**，不能写成 `次[于之]` ——
  //    「优先**于**」里的「于」会被字符类 `[于之]` 命中，
  //    于是"健康优先于生活"被判成"生活次于健康"，双方一起负分（实测踩过）。
  //
  // ⚠️ 另外补一条**对称规则**：「B 让位于 A」也意味着 A 胜。
  //    否则"生活让位于健康"里健康得 0 分，
  //    而"恰好一方正分"的判据要求另一方 <= 0 —— 0 分也满足，
  //    所以裁决仍然正确。但显式加上这条能覆盖更多措辞。
  const againstX = [
    `${label}[^，。；,;]{0,4}让位`,
    `${label}[^，。；,;]{0,4}服从`,
    `${label}[^，。；,;]{0,4}次要`,
    `${label}[^，。；,;]{0,4}退让`,
  ];
  for (const p of againstX) if (new RegExp(p).test(action)) score -= 1;

  // 对称规则：若**别人**让位于本方，本方得分
  const yieldedTo = new RegExp(
    `(生活|健康|学习|办公|代码)[^，。；,;]{0,4}让位[^，。；,;]{0,2}${label}`,
  );
  if (yieldedTo.test(action)) score += 1;

  return score;
}

// ═══════════════════════════════════════════════════════════
// 应用裁决
// ═══════════════════════════════════════════════════════════

/**
 * 把裁决落到记忆上，并落事件。
 *
 * ⚠️ 落败方**降权但保留** —— 方案 § 8.3 第二层明确"落败方降低置信度而非删除"。
 *    理由：这次输了不代表永远错。场景变了它可能重新是对的（淘汰 ≠ 删除）。
 */
export function applyVerdict(args: {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  readonly conflict: { readonly id: string; readonly message: string };
  readonly sides: readonly ConflictSide[];
  readonly verdict: Verdict;
}): VerdictOutcome {
  const now = args.clock.now();
  const { verdict } = args;

  const winners: string[] = [];
  const losers: { memoryId: string; fitnessBefore: number; fitnessAfter: number }[] = [];

  for (const side of args.sides) {
    const isWinner = side.servant === verdict.winner;
    for (const memoryId of side.memoryIds) {
      const r = args.store.recordVerdict(memoryId, isWinner ? 'won' : 'lost');
      if (!r.ok) continue;
      if (isWinner) {
        winners.push(memoryId);
      } else if (r.fitnessBefore !== undefined && r.fitnessAfter !== undefined) {
        losers.push({
          memoryId,
          fitnessBefore: r.fitnessBefore,
          fitnessAfter: r.fitnessAfter,
        });
      }
    }
  }

  // 落裁决事件（可回溯 —— 方案 § 2.2⑤ 明确要求）
  args.log.append({
    type: 'conflict.resolved',
    actor: verdict.decidedBy === 'user' ? 'user' : 'butler',
    payload: {
      conflictId: args.conflict.id,
      message: args.conflict.message,
      winner: verdict.winner,
      decidedBy: verdict.decidedBy,
      reason: verdict.reason,
      principleId: verdict.principleId ?? null,
      // 各方的立场与证据一并留痕，便于事后追问"当时为什么这么判"
      sides: args.sides.map((s) => ({
        servant: s.servant,
        claim: s.claim,
        evidence: s.evidence,
      })),
      winners,
      losers: losers.map((l) => l.memoryId),
    },
    createdAt: now,
  });

  // 用户要求固化为原则 → 产出**候选**（不是直接生效）
  const principleCandidate =
    verdict.makePrinciple === true && verdict.winner !== 'none'
      ? buildPrincipleCandidate(args.conflict, args.sides, verdict)
      : undefined;

  if (principleCandidate !== undefined) {
    args.log.append({
      type: 'principle.derived',
      actor: 'butler',
      payload: {
        source: 'user_verdict',
        conflictId: args.conflict.id,
        content: principleCandidate.content,
        condition: principleCandidate.condition,
        action: principleCandidate.action,
        note: '由用户裁决固化，待审核生效后同类冲突可自动裁决',
      },
      createdAt: now,
    });
  }

  return {
    verdict,
    winners,
    losers,
    ...(principleCandidate !== undefined ? { principleCandidate } : {}),
  };
}

/**
 * 从一次裁决生成原则候选。
 *
 * ⚠️ 产出的是**候选**而非直接生效 ——
 *    与反思产出一致，必须经用户审核。理由：单次裁决不足以证明它是通用规律。
 */
export function buildPrincipleCandidate(
  conflict: { readonly id: string; readonly message: string },
  sides: readonly ConflictSide[],
  verdict: Verdict,
): NonNullable<VerdictOutcome['principleCandidate']> {
  const winnerSide = sides.find((s) => s.servant === verdict.winner);
  const loserSide = sides.find((s) => s.servant !== verdict.winner);

  const winnerLabel = verdict.winner === 'none' ? '两者' : SERVANT_LABEL[verdict.winner];
  const loserLabel = loserSide ? SERVANT_LABEL[loserSide.servant] : '其它';

  return {
    // 固化措辞要泛化到"同类冲突"，而不是记住这一次的具体内容
    content: `跨领域冲突时，${winnerLabel}类约束优先于${loserLabel}类偏好`,
    condition: conflict.message,
    action: `当${winnerLabel}与${loserLabel}的建议冲突时，采用${winnerLabel}一方：${
      winnerSide?.claim ?? verdict.reason
    }`,
    fromVerdict: conflict.id,
  };
}

// ═══════════════════════════════════════════════════════════
// 冲突收集（把监督层检出的冲突整理成可裁决的形式）
// ═══════════════════════════════════════════════════════════

export interface PendingConflict {
  readonly id: string;
  readonly message: string;
  readonly severity: 'info' | 'warn' | 'block';
  readonly parties: readonly ServantId[];
  readonly sides: readonly ConflictSide[];
  /** 是否可自动裁决（命中已生效原则） */
  readonly autoVerdict: AutoVerdictResult | null;
  /** 用户的候选选项（界面用） */
  readonly options: readonly { readonly servant: ServantId; readonly claim: string }[];
}

/**
 * 把管家监督检出的冲突整理成待裁决项。
 *
 * 每个冲突都会尝试自动裁决；成功时界面可以直接展示"依据原则 X，已自动裁决"，
 * 失败时列出选项让用户选。
 */
export function collectPending(args: {
  readonly store: MemoryStore;
  readonly conflicts: readonly {
    readonly id: string;
    readonly message: string;
    readonly severity: 'info' | 'warn' | 'block';
    readonly parties: readonly ServantId[];
  }[];
  readonly sides: readonly ConflictSide[];
}): readonly PendingConflict[] {
  return args.conflicts.map((c) => {
    const sides = args.sides.filter((s) => c.parties.includes(s.servant));
    return {
      id: c.id,
      message: c.message,
      severity: c.severity,
      parties: c.parties,
      sides,
      autoVerdict: tryAutoVerdict({ store: args.store, conflict: c }),
      options: sides.map((s) => ({ servant: s.servant, claim: s.claim })),
    };
  });
}

/** 汇总裁决统计（供界面"这个月自动裁决了几次"展示）。 */
export function verdictStats(log: EventLog): {
  readonly total: number;
  readonly byUser: number;
  readonly byPrinciple: number;
} {
  const resolved = log.byType('conflict.resolved');
  let byUser = 0;
  let byPrinciple = 0;
  for (const e of resolved) {
    const d = (e.payload as { decidedBy?: string }).decidedBy;
    if (d === 'user') byUser += 1;
    else if (d === 'principle') byPrinciple += 1;
  }
  return { total: resolved.length, byUser, byPrinciple };
}

/** 依据 `MemoryConflict` 类型构造冲突 id（与监督层对接）。 */
export function conflictIdOf(conflict: Pick<MemoryConflict, 'kind' | 'message'>): string {
  return `cf_${conflict.kind}_${conflict.message.slice(0, 12).replace(/\s/g, '_')}`;
}

/** 类型辅助：把内部裁决类型映射到领域模型。 */
export function toDomainResolution(verdict: Verdict): ConflictResolution {
  if (verdict.decidedBy === 'principle') {
    return {
      kind: 'autoResolved',
      by: verdict.principleId ?? 'principle',
      reason: verdict.reason,
    };
  }
  if (verdict.winner === 'none') {
    return { kind: 'dismissed', by: 'user', reason: verdict.reason };
  }
  return { kind: 'askUser' };
}
