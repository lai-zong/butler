/**
 * 反思编排 —— 一轮对话结束后，把经验变成记忆
 *
 * ★★ 这个文件补的是一个**致命缺口**：
 *
 *   `reflectServant` / `reflectButler` / `sinkCandidates` 在此之前
 *   **只有验证脚本调用**（`validate/02-memory-loop.ts`）。
 *   生产代码里没有任何地方调用它们。
 *
 *   后果是一条完整的失效链：
 *     界面聊天 → 记忆库永远是空的 → 召回 0 条 → 没有硬约束注入
 *     → 没有原则 → 没有演化 → **「它记得你」在真实使用路径上完全不成立**
 *
 *   ⚠️ 而验证 2 是 34/34 全过的 —— 因为它手工调了反思与入库。
 *      这暴露了一个验证方法上的问题：
 *      **验证"核心能力可用"不等于验证"真实路径可达"**。
 *
 * ★ 两层反思的顺序不能反：
 *   ① 仆人层（作用域限本领域）—— 先各领域自己总结
 *   ② 管家层（跨领域）—— 看到的是**仆人的总结**，不是原始产出
 *   这样领域内的错误反思不会直接污染全局层（方案创新点 ① 的核心论点）。
 */

import type { ModelPort } from '../ports/model.js';
import type { ClockPort } from '../ports/clock.js';
import type { EventLog } from '../events/log.js';
import type { MemoryStore } from '../memory/store.js';
import type { ServantId, ServantReport } from '../servants/types.js';
import { buildServantReflectionInput, reflectButler, reflectServant } from './reflect.js';
import type { MemoryCandidate } from './reflect.js';
import { sinkCandidates } from '../memory/sink.js';
import {
  admitAutonomously,
  decideAdmission,
  inferSource,
  revocationRates,
} from '../memory/admission.js';
import type { RunSessionResult } from '../runtime/orchestrator.js';

// ═══════════════════════════════════════════════════════════
// 参数与结果
// ═══════════════════════════════════════════════════════════

export interface ReflectTurnArgs {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly store: MemoryStore;
  readonly session: RunSessionResult;
  readonly userGoal: string;
  /** 记忆归属的用户 */
  readonly userId: string;
  /**
   * 用户对本次产出的反馈。
   *
   * ⚠️ 目前**只能拿到"是否打回"这一个信号** ——
   *    界面还没有逐条产出的采纳/纠正交互。
   *    方案 § 8.4 的效果验证需要更细的反馈，但"整体是否通过"
   *    已经是有价值的信号（通过了说明方向对）。
   */
  readonly accepted: boolean;
  /** 用户是否明确纠正过（打回时用户说了什么） */
  readonly correction?: string;
}

export interface ReflectTurnResult {
  readonly servantCandidates: readonly MemoryCandidate[];
  readonly butlerCandidates: readonly MemoryCandidate[];
  /** 自主生效的（分级自主策略） */
  readonly admittedAutonomously: number;
  /** 需要用户确认的 */
  readonly pendingReview: number;
  readonly skippedDuplicates: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** 反思是否失败（失败不阻断对话，但要如实告知） */
  readonly failed: boolean;
  readonly failureReason?: string;
}

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════

/**
 * 一轮结束后的反思与入库。
 *
 * ★ 三条纪律：
 *   ① **失败不抛出** —— 反思是"事后学习"，它失败不该让用户
 *      刚拿到的结果作废（那是把学习成本转嫁给用户）
 *   ② **每个仆人只反思自己的产出** —— 结构上不给它看别的领域
 *      （`buildServantReflectionInput` 会过滤）
 *   ③ **去重后入库** —— 与既有记忆重复的候选不写
 */
export async function reflectTurn(args: ReflectTurnArgs): Promise<ReflectTurnResult> {
  const dbg = process.env['BUTLER_DEBUG_REFLECT'] === '1';
  const trace = (s: string): void => {
    if (dbg) console.error(`  [reflect] ${s}`);
  };

  // ── ① 反馈信号 ──
  //
  // ⚠️ 用户打回 = 所有产出都判为"未奏效"；通过 = 都判为"奏效"。
  //    这是粗糙的，但比"没有反馈"好得多 ——
  //    方案 § 8.4 的效果验证入口就在这个字段上。
  const feedback = args.session.reports.flatMap((r) =>
    r.artifacts.length > 0
      ? r.artifacts.map((_artifact, i) => ({
          // ⚠️ `ServantArtifact` 没有 id（它是仆人产出的原始形状，
          //    产出物 id 要到 `artifact.register` 之后才有）。
          //    所以用 `taskId#序号` 定位 —— 稳定且可读。
          onArtifact: `${r.taskId}#${i}`,
          effective: args.accepted,
          ...(args.correction !== undefined ? { note: args.correction } : {}),
        }))
      : [
          {
            onArtifact: r.taskId,
            effective: args.accepted,
            ...(args.correction !== undefined ? { note: args.correction } : {}),
          },
        ],
  );

  // ── ② 仆人层反思：每个参与过的仆人各一次 ──
  //
  // ★ 顺序：按 `SERVANT_IDS` 稳定排序，而不是按 reports 的出现顺序 ——
  //   否则同一批产出换个顺序会产生不同的候选集，破坏可复现性。
  const servants = [...new Set(args.session.reports.map((r) => r.servant))].sort();

  const servantCandidates: MemoryCandidate[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let failed = false;
  let failureReason: string | undefined;

  for (const servant of servants) {
    const ownReports = args.session.reports.filter((r) => r.servant === servant);
    /**
     * ⚠️ 领域记忆的可见性由 store.canRead 决定，这里**不能**
     *    自己按 memClass 过滤 —— 权限判定只有一处实现，
     *    多写一处必然与它漂移（那是分权失效的常见成因）。
     */
    const ownDomainMemories = args.store
      .visibleTo({ kind: 'butler', userId: args.userId })
      .filter((m) => m.memClass === 'domain' && m.domain === servant)
      .map((m) => ({ id: m.id, kind: m.kind, content: m.content, lifecycle: m.lifecycle }));

    const input = buildServantReflectionInput({
      servant: servant as ServantId,
      userGoal: args.userGoal,
      ownReports,
      ownDomainMemories,
      feedback,
    });

    trace(`仆人层反思：${servant}（${ownReports.length} 份产出）`);
    const r = await reflectServant({
      model: args.model,
      log: args.log,
      clock: args.clock,
      input,
    });

    inputTokens += r.usage.inputTokens;
    outputTokens += r.usage.outputTokens;
    servantCandidates.push(...r.candidates);
  }

  // ── ③ 管家层反思：看**仆人的总结**，跨领域 ──
  //
  // ⚠️ 传给它的是 reports 的 summary（结论与关键依据），
  //    不是原始产出 —— 监督者要"跨仆人比对"，
  //    看原始产出会被细节淹没，也放大了上下文成本。
  const globalMemories = args.store
    .all()
    .filter((m) => m.memClass === 'global_constraint' || m.memClass === 'global_shared')
    .map((m) => ({ id: m.id, kind: m.kind, content: m.content, lifecycle: m.lifecycle }));

  const existingPrinciples = args.store
    .all()
    .filter((m) => m.kind === 'principle')
    .map((m) => ({
      id: m.id,
      content: m.content,
      applied: m.effectiveness?.applied ?? 0,
      succeeded: m.effectiveness?.succeeded ?? 0,
    }));

  const butlerCandidates: MemoryCandidate[] = [];
  try {
    trace(`管家层反思（${args.session.reports.length} 份产出，${existingPrinciples.length} 条既有原则）`);
    const br = await reflectButler({
      model: args.model,
      log: args.log,
      clock: args.clock,
      input: {
        reports: args.session.reports.map((r) => ({
          servant: r.servant as ServantId,
          summary: summarizeReport(r),
        })),
        conflicts: (args.session.supervision.conflicts ?? []).map((c) => ({
          message: c.message,
          severity: 'advisory',
        })),
        globalMemories,
        existingPrinciples,
        userGoal: args.userGoal,
        temporalPatterns: temporalPatternLines(args),
      },
    });
    butlerCandidates.push(...br.candidates);
    inputTokens += br.usage.inputTokens;
    outputTokens += br.usage.outputTokens;
  } catch (err) {
    /**
     * ⚠️ 管家层失败**不影响仆人层候选入库** ——
     *    两层是独立的，一层挂掉不该把另一层的收获也丢掉。
     */
    failed = true;
    failureReason = err instanceof Error ? err.message : String(err);
    trace(`管家层反思失败：${failureReason}`);
  }

  const allCandidates = [...servantCandidates, ...butlerCandidates];
  trace(`候选合计 ${allCandidates.length} 条（仆人层 ${servantCandidates.length} / 管家层 ${butlerCandidates.length}）`);

  // ── ④⑤ 入库 + 分级自主准入 ──
  const outcome = sinkAndAdmit({
    log: args.log,
    store: args.store,
    clock: args.clock,
    candidates: allCandidates,
  });
  trace(
    `入库 ${outcome.created} 候选 · 自主生效 ${outcome.admittedAutonomously} · 待审核 ${outcome.pendingReview} · 重复跳过 ${outcome.skippedDuplicates}`,
  );

  return {
    servantCandidates,
    butlerCandidates,
    admittedAutonomously: outcome.admittedAutonomously,
    pendingReview: outcome.pendingReview,
    skippedDuplicates: outcome.skippedDuplicates,
    usage: { inputTokens, outputTokens },
    failed,
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}

// ═══════════════════════════════════════════════════════════
// 入库 + 准入（三条路径共用）
// ═══════════════════════════════════════════════════════════

export interface SinkAndAdmitResult {
  readonly created: number;
  readonly admittedAutonomously: number;
  readonly pendingReview: number;
  readonly skippedDuplicates: number;
  /** 自主生效的记忆 id（供界面展示"它刚刚记住了什么"） */
  readonly admittedIds: readonly string[];
}

/**
 * 把一批候选落库，并按**分级自主**策略决定哪些直接生效。
 *
 * ★ 为什么抽成函数：**三条路径都要用它**
 *   · 事实提取（用户发言）→ 立刻入库
 *   · 仆人层反思 → 会话结束后
 *   · 管家层反思 → 会话结束后
 *
 *   ⚠️ 复制三份必然会漂移，而"分级自主策略在哪条路径上生效了"
 *      这种东西漂移了**不会报错**，只会表现成"有时候记得住有时候记不住"。
 *
 * ★ 分级策略（用户明确要求「不要通过用户审核，让项目自主完成」）：
 *   · 用户陈述 / 用户纠正 / 用户指令 / 高置信观察 / 附件解析 → **自主生效**
 *   · AI 推断的偏好 → 待审核
 *   · AI 推断的原则 → **一律待审核**
 *
 *   ⚠️ 为什么原则最严：原则会**指导后续所有决策**，
 *      一条错原则的影响面远大于一条错事实。这个区分是刻意的。
 */
export function sinkAndAdmit(args: {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  readonly candidates: readonly MemoryCandidate[];
}): SinkAndAdmitResult {
  if (args.candidates.length === 0) {
    return {
      created: 0,
      admittedAutonomously: 0,
      pendingReview: 0,
      skippedDuplicates: 0,
      admittedIds: [],
    };
  }

  // ⚠️ 顺序不能反：**先 sink 再 admit**。
  //    `admitAutonomously` 要一个已存在的 memoryId，
  //    而 id 是 `store.create` 时分配的 —— 所以必须先建出来。
  const sinkResult = sinkCandidates(
    { log: args.log, store: args.store, clock: args.clock },
    args.candidates,
  );

  /**
   * ⚠️ 撤销率反馈：某类来源历史上被用户撤销得多，说明这类推断不可靠 ——
   *    把它喂回决策，让系统自己收紧。这是「元学习」的一环。
   */
  const rates = revocationRates(args.log);

  let admittedAutonomously = 0;
  let pendingReview = 0;
  const admittedIds: string[] = [];

  /**
   * ⚠️ 用 `sinkResult.paired` 而不是拿 id 去 find 候选。
   *
   *   `MemoryCandidate.id`（`cand_*`）与 `MemoryEntry.id`（`m_*`）是两套
   *   不同的 id —— 第一版按 `c.id === entry.id` 匹配，**全部匹配失败**，
   *   于是所有记忆都落进「待审核」，分级自主策略**静默失效**
   *   （功能看起来正常，只是所有记忆都变成要用户点确认）。
   */
  for (const { entry, candidate } of sinkResult.paired) {
    const source = inferSource(candidate);
    const decision = decideAdmission({
      candidate,
      source,
      revocationRate: rates[source],
    });

    if (decision.admission !== 'autoApproved') {
      pendingReview += 1;
      continue;
    }

    const ok = admitAutonomously({
      log: args.log,
      store: args.store,
      clock: args.clock,
      id: entry.id,
      source,
      reason: decision.reason,
    });

    if (ok !== null) {
      admittedAutonomously += 1;
      admittedIds.push(entry.id);
    } else {
      pendingReview += 1;
    }
  }

  return {
    created: sinkResult.created.length,
    admittedAutonomously,
    pendingReview,
    skippedDuplicates: sinkResult.skipped.length,
    admittedIds,
  };
}

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

/**
 * 把一份仆人汇报压成"结论与关键依据"。
 *
 * ⚠️ 刻意**不含 uncertainties 之外的原始正文**：
 *    管家层要跨仆人比对，看长正文会被细节淹没。
 *    截断到 300 字是防止单个产出独占上下文。
 */
function summarizeReport(r: ServantReport): string {
  const parts: string[] = [];

  // ⚠️ 截断到 300 字/项、最多 2 项 —— 防止单个产出独占管家层的上下文
  for (const artifact of r.artifacts.slice(0, 2)) {
    const text = Array.isArray(artifact.content)
      ? artifact.content.join('；')
      : String(artifact.content);
    parts.push(text.slice(0, 300));
  }
  for (const f of (r.findings ?? []).slice(0, 3)) {
    parts.push(`发现：${f.statement ?? ''}`);
  }
  if (r.uncertainties.length > 0) {
    parts.push(`不确定：${r.uncertainties.slice(0, 2).join('；')}`);
  }

  return parts.join(' | ').slice(0, 600) || `（${r.servant} 无产出）`;
}

/**
 * 时间维度规律（供管家层反思参考）。
 *
 * ★ 从事件流里取**已派生**的规律，而不是现算 ——
 *   规律由定时任务派生（`pattern.derived`），
 *   反思路径只是消费者。现算会让每轮对话都多一次聚合开销。
 */
function temporalPatternLines(args: ReflectTurnArgs): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const e of args.log.byType('pattern.derived')) {
    const p = e.payload as { patternId?: string; pattern?: string };
    if (p.patternId === undefined || p.pattern === undefined || seen.has(p.patternId)) continue;
    seen.add(p.patternId);
    out.push(p.pattern);
  }

  return out.slice(0, 6);
}

/** 供界面展示：本次学到了什么。 */
export function renderReflectSummary(r: ReflectTurnResult): string {
  const lines: string[] = [];
  const total = r.servantCandidates.length + r.butlerCandidates.length;

  if (total === 0) return '';

  if (r.admittedAutonomously > 0) {
    lines.push(`记住了 ${r.admittedAutonomously} 条`);
  }
  if (r.pendingReview > 0) {
    lines.push(`${r.pendingReview} 条待你确认`);
  }
  return lines.join(' · ');
}
