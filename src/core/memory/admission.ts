/**
 * 记忆准入门控 —— 分级自主
 *
 * 设计依据：方案 § 3.2（候选审核制）、§ 8（渐进式演化）；经用户确认的分级策略
 *
 * ★ 要解决的问题（用户提出的真实痛点）：
 *   原方案是"**AI 不能单方面写入记忆，必须用户审核后生效**"。
 *   但"你要的自主进化"与"每条都要你点确认"是矛盾的 ——
 *   更糟的是，用户会开始**习惯性点通过**，审核反而变成走过场。
 *
 * ★ 核心区分（这个区分就是本模块的全部价值）：
 *
 *     「用户对我说：我对花生过敏」        ← 【转述】信息来自用户
 *     「我推断用户偏好命令行而非图形界面」  ← 【推断】信息来自 AI 自己
 *
 *   **后者才是危险的东西**：AI 从一次行为里猜出偏好，写成记忆，
 *   之后每次都按这个猜测行事，**而用户根本不知道它在按什么行事**。
 *   这是"AI 越来越不懂你"的经典死法。
 *
 * ★ 所以分级自主：
 *   | 类型               | 谁决定     |
 *   | 转述用户明确说的事实 | 系统自主   |
 *   | 用户的纠正          | 系统自主   |
 *   | 高置信度行为事实     | 系统自主   |
 *   | AI 推断的偏好       | 待审       |
 *   | AI 提炼的原则       | 待审       |
 *   | 与既有记忆冲突       | 待审       |
 *
 * ⚠️ 三条安全网，让"自主生效"不等于"失控"：
 *   ① **全部留痕** —— 自主生效的也落事件，含理由与证据
 *   ② **可一键撤销** —— 撤销会记入效果反馈（同类推断以后更难自主生效）
 *   ③ **误用惩罚** —— 被撤销过的来源类型，门槛自动提高
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { MemoryStore } from './store.js';
import type { MemoryCandidate } from '../reflection/reflect.js';
import type { MemoryEntry } from './types.js';
import { snapshotOf } from './snapshot.js';

// ═══════════════════════════════════════════════════════════
// 候选来源
// ═══════════════════════════════════════════════════════════

/**
 * 一条候选的**信息来源**。
 *
 * ★ 这是分级自主的判据 —— 决定"要不要问用户"的不是内容，
 *   而是**这条信息是谁说的**。
 */
export type CandidateSource =
  /** 用户明确陈述（"我对花生过敏"）*/
  | 'userStated'
  /** 用户纠正 AI（"不是这样，我不吃辣"）*/
  | 'userCorrected'
  /** 用户直接指定（"记住我喜欢简短回复"）*/
  | 'userInstructed'
  /** 行为观察聚合出的高置信度事实（连续 5 天 23 点后无活动）*/
  | 'observed'
  /** AI 从对话中推断的偏好 */
  | 'aiInferredPreference'
  /** AI 提炼的原则（会改变未来行为方式，风险最高）*/
  | 'aiDerivedPrinciple'
  /** 从附件解析（收据 → 常购品牌）*/
  | 'parsedFromAttachment';

export const SOURCE_LABEL: Record<CandidateSource, string> = {
  userStated: '用户明确陈述',
  userCorrected: '用户纠正',
  userInstructed: '用户指定',
  observed: '行为观察',
  aiInferredPreference: 'AI 推断的偏好',
  aiDerivedPrinciple: 'AI 提炼的原则',
  parsedFromAttachment: '附件解析',
};

/** 哪些来源可以自主生效。 */
const AUTONOMOUS_SOURCES: readonly CandidateSource[] = [
  'userStated',
  'userCorrected',
  'userInstructed',
  'observed',
  // 附件解析单列 —— 它有自己的（更高）置信度门槛。
  // 放在这里只为通过「来源可自主」这一关，真正的判定在下面。
  'parsedFromAttachment',
];

// ═══════════════════════════════════════════════════════════
// 准入判定
// ═══════════════════════════════════════════════════════════

export type Admission = 'autoApproved' | 'needsReview';

export interface AdmissionDecision {
  readonly admission: Admission;
  readonly reason: string;
  /** 自主生效时的置信度门槛是否满足 */
  readonly confidenceOk: boolean;
}

/** `observed` 来源自主生效所需的置信度门槛。 */
export const OBSERVED_CONFIDENCE_FLOOR = 0.7;

/** `parsedFromAttachment` 自主生效所需的置信度门槛（单张图证据弱）。 */
export const ATTACHMENT_CONFIDENCE_FLOOR = 0.8;

/**
 * 判定一条候选该自主生效还是等用户审。
 *
 * ⚠️ 判定顺序有讲究：
 *   ① **冲突检查在最前** —— 一条与硬约束或既有记忆矛盾的候选，
 *      无论来源多可信都不能自主生效。矛盾是价值判断，AI 不该替用户决定。
 *   ② 再看来源
 *   ③ 最后看置信度
 */
export function decideAdmission(args: {
  readonly candidate: MemoryCandidate;
  readonly source: CandidateSource;
  /** 与既有记忆是否冲突（由调用方用 recall/相似度判断）*/
  readonly conflictsWith?: readonly string[];
  /** 来源类型的历史撤销率（0—1）。越高说明这类推断越不可靠。*/
  readonly revocationRate?: number;
}): AdmissionDecision {
  const { candidate, source } = args;

  // ① 冲突 → 必须人工
  if (args.conflictsWith !== undefined && args.conflictsWith.length > 0) {
    return {
      admission: 'needsReview',
      reason:
        `与既有记忆冲突（${args.conflictsWith.length} 条）。` +
        '采纳哪个是价值判断，AI 不替用户决定。',
      confidenceOk: true,
    };
  }

  // ② 原则一律待审 —— 它会改变未来的行为方式，风险最高
  if (candidate.kind === 'principle') {
    return {
      admission: 'needsReview',
      reason: '原则会改变 AI 未来的行为方式，风险最高，需用户确认。',
      confidenceOk: true,
    };
  }

  // ③ AI 推断的偏好待审 —— 这正是"AI 静默把你带偏"的主要来源
  if (source === 'aiInferredPreference') {
    return {
      admission: 'needsReview',
      reason: '这是 AI 的推断而非用户所述。一次行为的推断可能是巧合，需用户确认。',
      confidenceOk: true,
    };
  }

  // ④ 来源可自主 → 看置信度
  if (!AUTONOMOUS_SOURCES.includes(source)) {
    return {
      admission: 'needsReview',
      reason: `来源「${SOURCE_LABEL[source]}」不在可自主生效之列。`,
      confidenceOk: true,
    };
  }

  // 附件解析：证据来自一张图，门槛更高
  if (source === 'parsedFromAttachment') {
    const ok = candidate.confidence >= ATTACHMENT_CONFIDENCE_FLOOR;
    return {
      admission: ok ? 'autoApproved' : 'needsReview',
      reason: ok
        ? `附件解析且置信度 ${candidate.confidence} ≥ ${ATTACHMENT_CONFIDENCE_FLOOR}，自主生效。`
        : `附件解析的置信度 ${candidate.confidence} 低于 ${ATTACHMENT_CONFIDENCE_FLOOR}（单张图的证据较弱），需用户确认。`,
      confidenceOk: ok,
    };
  }

  // 行为观察：需要足够置信度
  if (source === 'observed') {
    let floor = OBSERVED_CONFIDENCE_FLOOR;
    // ★ 安全网③：这类来源历史上被撤销过 → 门槛提高
    if (args.revocationRate !== undefined && args.revocationRate > 0.2) {
      floor = Math.min(0.95, floor + 0.15);
      const ok = candidate.confidence >= floor;
      return {
        admission: ok ? 'autoApproved' : 'needsReview',
        reason:
          `行为观察，但这类来源历史撤销率 ${(args.revocationRate * 100).toFixed(0)}% 偏高，` +
          `门槛已提高到 ${floor.toFixed(2)}（当前 ${candidate.confidence}）。`,
        confidenceOk: ok,
      };
    }
    const ok = candidate.confidence >= floor;
    return {
      admission: ok ? 'autoApproved' : 'needsReview',
      reason: ok
        ? `行为观察且置信度 ${candidate.confidence} ≥ ${floor}，自主生效。`
        : `行为观察的置信度 ${candidate.confidence} 低于 ${floor}，证据不足，需用户确认。`,
      confidenceOk: ok,
    };
  }

  // 用户所述 / 纠正 / 指定 → 自主生效
  return {
    admission: 'autoApproved',
    reason:
      source === 'userCorrected'
        ? '用户的纠正必须立刻生效，否则下次还会错。'
        : '这是用户所述内容，属转述而非 AI 的推断，无需让用户重复确认自己的话。',
    confidenceOk: true,
  };
}

// ═══════════════════════════════════════════════════════════
// 自主生效与撤销
// ═══════════════════════════════════════════════════════════

export interface AdmitResult {
  readonly entry: MemoryEntry;
  readonly admission: Admission;
  readonly reason: string;
}

/**
 * 自主生效一条记忆。
 *
 * ★ 与 `store.review(approve)` 的区别：
 *   review 是**人**的决定（actor='user'）；
 *   本函数是**系统**的决定（actor='butler'），
 *   并且**必须记录判据** —— 否则事后无法回答"它凭什么自己记下这条"。
 */
export function admitAutonomously(args: {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  readonly id: string;
  readonly source: CandidateSource;
  readonly reason: string;
}): AdmitResult | null {
  const before = args.store.get(args.id);
  if (!before) return null;

  // ★ 走 store.review 的正规路径，并把「这是系统自主决定的」作为元信息带进去。
  //
  //   ⚠️ 我第一版在 review 之后**又自己发了一条 memory.approved** ——
  //      结果同一次生效在事件流里有两条 approved，
  //      `revocationRates` 与界面统计都会翻倍。单一事件来源更可靠。
  const res = args.store.review(
    { kind: 'butler', userId: before.owner.userId },
    args.id,
    'approve',
    args.reason,
    {
      decidedBy: 'system',
      source: args.source,
      sourceLabel: SOURCE_LABEL[args.source],
      audit: 'autoAdmission',
    },
  );
  if (!res.ok) return null;

  return {
    entry: args.store.get(args.id) ?? res.entry,
    admission: 'autoApproved',
    reason: args.reason,
  };
}

/**
 * 撤销一条记忆（安全网②）。
 *
 * ★ 撤销不只是删掉 —— 它同时是**效果反馈**：
 *   告诉系统"这类来源的判断不可靠"，从而**提高同类推断的门槛**。
 *
 *   这是"误用惩罚"（适应度公式的 w6 项）在准入路径上的体现。
 */
export function revoke(args: {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  readonly id: string;
  readonly reason: string;
}): boolean {
  const entry = args.store.get(args.id);
  if (!entry) return false;

  // 归档而非删除 —— 保留"曾被撤销"这一事实，供统计撤销率
  args.store.setLifecycle(args.id, 'archived', { archivedAt: args.clock.now() });

  args.log.append({
    type: 'memory.rejected',
    actor: 'user',
    payload: {
      memoryId: args.id,
      content: entry.content,
      kind: entry.kind,
      reason: args.reason,
      // ★ 撤销同时是效果反馈：让同来源类型的门槛提高
      feedback: 'revokedByUser',
      confidence: entry.confidence,
      note: '用户撤销了一条已生效的记忆；该来源类型的自主准入门槛将提高',
      /**
       * ★ 必带快照，否则撤销活不过一次重启（实测过）。
       *
       *   `setLifecycle` 只改内存、不发事件，而重放只认 `snapshot` ——
       *   没有这一行，重启后这条记忆会回到 `active` 继续被召回，
       *   用户撤销三次、它复活三次。
       */
      snapshot: snapshotOf(args.store.get(args.id)),
    },
    createdAt: args.clock.now(),
  });

  return true;
}

/**
 * 统计各类来源的撤销率（安全网③的数据来源）。
 *
 * ⚠️ 撤销率只统计**自主生效过的**那些 ——
 *    用户审核时手动拒绝的不算，因为那不是"系统自主判断错了"。
 */
export function revocationRates(log: EventLog): Readonly<Record<CandidateSource, number>> {
  const approved = new Map<string, CandidateSource>();
  for (const e of log.byType('memory.approved')) {
    const p = e.payload as { memoryId?: string; decidedBy?: string; source?: string };
    if (p.decidedBy === 'system' && p.memoryId !== undefined && p.source !== undefined) {
      approved.set(p.memoryId, p.source as CandidateSource);
    }
  }

  const totals = new Map<CandidateSource, number>();
  for (const src of approved.values()) {
    totals.set(src, (totals.get(src) ?? 0) + 1);
  }

  const revoked = new Map<CandidateSource, number>();
  for (const e of log.byType('memory.rejected')) {
    const p = e.payload as { memoryId?: string; feedback?: string };
    if (p.feedback !== 'revokedByUser' || p.memoryId === undefined) continue;
    const src = approved.get(p.memoryId);
    if (src === undefined) continue;
    revoked.set(src, (revoked.get(src) ?? 0) + 1);
  }

  const out: Record<string, number> = {};
  for (const [src, total] of totals) {
    out[src] = total === 0 ? 0 : (revoked.get(src) ?? 0) / total;
  }
  return out as Readonly<Record<CandidateSource, number>>;
}

/**
 * 从候选的形态**推断**它的来源。
 *
 * ⚠️ 这是兜底路径。理想情况下反思层应当显式标注来源，
 *    但在那之前用证据特征推断 —— 比"全部当推断"要好得多。
 *
 * 判据：
 *   · 证据里出现用户直接引述 → userStated
 *   · 证据里出现"纠正/不是/改为" → userCorrected
 *   · 证据来自活动聚合 → observed
 *   · 管家层产出的 principle → aiDerivedPrinciple
 *   · 其余 → aiInferredPreference（保守：宁可待审）
 */
export function inferSource(candidate: MemoryCandidate): CandidateSource {
  // ⚠️ 原则的判断必须在**最前** —— 我第一版把它放在后面，
  //    于是「用户说：……」这类证据会把原则判成 userStated，
  //    而原则恰恰是**最该审**的一类。
  if (candidate.kind === 'principle') return 'aiDerivedPrinciple';

  const evidenceText = candidate.evidence.join(' ');

  if (/纠正|更正|不是这样|改为|改成|不对/.test(evidenceText)) return 'userCorrected';
  if (/用户(说|要求|表示|提到|指定)|原话|user said/i.test(evidenceText)) return 'userStated';
  if (/activity|聚合|观察|连续\s*\d+\s*(天|次)|采样/.test(evidenceText)) return 'observed';
  if (/receipt|收据|附件|解析|ocr|截图/.test(evidenceText)) return 'parsedFromAttachment';

  // ★ 兜底走"推断"而不是"用户所述" —— 保守方向。
  //   判错的代价：多让用户看一眼（可接受）
  //   反向判错的代价：AI 静默地把用户带偏（不可接受）
  return 'aiInferredPreference';
}

/**
 * 批量准入：对一批候选逐条判定并处理。
 *
 * 返回自主生效的与待审的分开，便于调用方分别落事件与展示。
 */
export function admitBatch(args: {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  readonly entries: readonly { readonly entry: MemoryEntry; readonly candidate: MemoryCandidate }[];
}): {
  readonly autoApproved: readonly AdmitResult[];
  readonly pendingReview: readonly { readonly entry: MemoryEntry; readonly reason: string; readonly source: CandidateSource }[];
} {
  const rates = revocationRates(args.log);
  const autoApproved: AdmitResult[] = [];
  const pendingReview: { entry: MemoryEntry; reason: string; source: CandidateSource }[] = [];

  for (const { entry, candidate } of args.entries) {
    const source = inferSource(candidate);
    const decision = decideAdmission({
      candidate,
      source,
      ...(rates[source] !== undefined ? { revocationRate: rates[source] } : {}),
    });

    if (decision.admission === 'autoApproved') {
      const r = admitAutonomously({
        log: args.log,
        store: args.store,
        clock: args.clock,
        id: entry.id,
        source,
        reason: decision.reason,
      });
      if (r) autoApproved.push(r);
    } else {
      pendingReview.push({ entry, reason: decision.reason, source });
    }
  }

  return { autoApproved, pendingReview };
}
