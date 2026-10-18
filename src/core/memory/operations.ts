/**
 * 操作记忆仓储与执行路径选择 —— 记忆化执行的引擎
 *
 * 设计依据：方案 § 6.3
 *
 * ★ 这个模块回答一个问题：**"这类任务，在这台机器上，该走哪条路？"**
 *
 *   无状态的做法：每次从零试 → 试 UI → 失败 → 试 COM → 成功（每次都很慢）
 *   有记忆的做法：第一次学到"COM 在这台机器上可行" → 之后直接走 COM
 *
 * ⚠️ 但**不能无条件相信记忆**。两条纪律：
 *   ① 成功率低的路径要**降权而非排除**（环境可能变了，那条路可能又行了）
 *   ② 失败次数足够多时应当**提示放弃该路径**，而不是无限重试
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { RandomPort } from '../ports/clock.js';
import { operationSnapshotOf } from './operationReplay.js';
import {
  PATH_LABEL,
  sameTaskKind,
  taskSignature,
  type ExecutionPath,
  type OperationKind,
  type OperationMemory,
} from './operation.js';

// ═══════════════════════════════════════════════════════════
// 路径的先天可靠性
// ═══════════════════════════════════════════════════════════

/**
 * 路径的**先天**可靠性先验。
 *
 * ⚠️ 这只是先验，会被实际成功率覆盖 ——
 *    它的作用是在"还没有任何使用记录"时给出合理的初始排序。
 *    方案 § 6.1 的三层模型正是这个顺序。
 */
export const PATH_PRIOR: Record<ExecutionPath, number> = {
  api: 0.95,
  cli: 0.9,
  uia: 0.7,
  vision: 0.4,
  manual: 0.2,
};

// ═══════════════════════════════════════════════════════════
// 选择结果
// ═══════════════════════════════════════════════════════════

export interface PathRecommendation {
  readonly path: ExecutionPath;
  /** 综合得分 0—1 */
  readonly score: number;
  /** 为什么推荐它（界面与审计都要能看） */
  readonly why: string;
  /** 是否基于历史经验（false 表示靠先验排序） */
  readonly fromExperience: boolean;
  /** 来源记忆（若有） */
  readonly memoryId?: string;
  /** 是否应当提示"这条路试过多次都失败，考虑放弃" */
  readonly adviseGivingUp?: boolean;
  /**
   * 是否**可能已过期**（连续失败达到阈值，方案 §6.3⑤）。
   *
   * ⚠️ 与 `adviseGivingUp` 不同：这条**仍在列表里**（环境可能变了），
   *    只是提醒"用之前先验证"，而不是"永久放弃"。
   */
  readonly stale?: boolean;
}

export interface RecommendResult {
  readonly taskSignature: string;
  /** 推荐顺序（从最可信到最不可信）*/
  readonly ranked: readonly PathRecommendation[];
  /** 已知不可行的路径（失败次数过多）*/
  readonly discouraged: readonly ExecutionPath[];
  /**
   * 连续失败过多、判定为**可能已过期**的路径（方案 §6.3⑤ 第 3 层）。
   *
   * ⚠️ 它们**不参与推荐**，但记忆本身保留（供审计），
   *    且某次成功会让它自动回到 `ranked`。
   *    与 `discouraged` 的区别：那个是"一直不行"，这个是"现在可能不行了"。
   */
  readonly stale: readonly ExecutionPath[];
  /**
   * 按**应用**聚合的经验（跨任务说法）。
   *
   * ★ 只在调用方给了 `app` 时才有值。
   *   用途：任务签名没命中（说法不同）时，仍能回答"这个应用上哪条路走得通"。
   */
  readonly appLevel?: {
    readonly app: string;
    readonly ranked: readonly PathRecommendation[];
    readonly samples: number;
  };
  /** 本次是否用到了历史经验 */
  readonly usedMemory: boolean;
}

// ═══════════════════════════════════════════════════════════
// 仓储
// ═══════════════════════════════════════════════════════════

/** 连续失败多少次后提示放弃该路径。 */
export const GIVE_UP_AFTER_FAILURES = 3;

/**
 * **连续**失败多少次后判定该条经验"可能已过期"（方案 §6.3⑤：连续 2 次失败 → 归档）。
 *
 * ⚠️ 为什么是 2 而不是 1：一次失败可能只是偶发（超时、焦点被抢），
 *    两次连续失败才更像"这条路真的变了"。
 */
export const ARCHIVE_AFTER_CONSECUTIVE_FAILURES = 2;

export class OperationMemoryStore {
  private readonly entries = new Map<string, OperationMemory>();
  private seq = 0;

  constructor(
    private readonly log: EventLog,
    private readonly clock: ClockPort,
    private readonly userId: string,
    /**
     * 确定性随机源。
     *
     * 当前的选择策略是**纯确定性排序**，还用不到它；
     * 预留给「探索性尝试」—— 偶尔试一试成功率低的路径，
     * 防止环境变了（比如软件装了新版本）却永远不知道。
     * 与记忆召回里的 ε 探索是同一个思路。
     */
    readonly random: RandomPort,
  ) {}

  // ── 重放注入（仅供重放器使用）──

  /**
   * 直接注入一条操作记忆。
   *
   * ⚠️ 只应由 hydrateOperationStore() 调用 ——
   *    它不发事件，业务代码必须走 ecordAttempt()。
   */
  restoreOperation(m: OperationMemory): void {
    this.entries.set(m.id, m);
  }

  // ── 查询 ──

  all(): readonly OperationMemory[] {
    return [...this.entries.values()];
  }

  get(id: string): OperationMemory | undefined {
    return this.entries.get(id);
  }

  byKind(kind: OperationKind): readonly OperationMemory[] {
    return this.all().filter((e) => e.kind === kind);
  }

  /** 找出与给定任务同类的全部方法记忆。 */
  matchingMethods(signature: string): readonly OperationMemory[] {
    return this.all().filter(
      (e) => e.kind === 'method' && sameTaskKind(e.taskSignature, signature),
    );
  }

  // ── 执行路径推荐 ──

  /**
   * 为某个任务推荐执行路径。
   *
   * ★ 这是"第 5 次直接走 COM"的实现：
   *   有历史记录时按**实际成功率**排序；没有时按先天先验排序。
   */
  recommend(args: {
    readonly task: string;
    readonly app?: string;
  }): RecommendResult {
    const signature = taskSignature({
      task: args.task,
      ...(args.app !== undefined ? { app: args.app } : {}),
    });

    const known = this.matchingMethods(signature);
    const byPath = new Map<ExecutionPath, OperationMemory>();
    for (const m of known) {
      if (m.path === undefined) continue;
      // 同路径多条时取成功率高的
      const cur = byPath.get(m.path);
      if (!cur || successRate(m) > successRate(cur)) byPath.set(m.path, m);
    }

    const ranked: PathRecommendation[] = [];
  const stalePaths: ExecutionPath[] = [];

    for (const path of Object.keys(PATH_PRIOR) as ExecutionPath[]) {
      const mem = byPath.get(path);

      if (!mem) {
        // 无记录：按先天先验排序，并说明"尚无经验"
        ranked.push({
          path,
          score: PATH_PRIOR[path],
          why: `尚无该类任务的经验记录，按路径可靠性先验排序（${PATH_LABEL[path]}）`,
          fromExperience: false,
        });
        continue;
      }

      const eff = mem.effectiveness;
      const rate = successRate(mem);
      const failures = eff ? eff.attempts - eff.succeeded : 0;
      const durationBonus = eff ? durationFactor(eff.avgDurationMs) : 0;

      // 综合分：成功率为主（权重 0.7），耗时次之（0.2），置信度兜底（0.1）
      const score = 0.7 * rate + 0.2 * durationBonus + 0.1 * mem.confidence;

      const giveUp = failures >= GIVE_UP_AFTER_FAILURES && rate <= 0.34;

      /**
       * ★★ 连续失败 → 标记为**可能已过期**（方案 §6.3⑤ 第 3 层）。
       *
       * ⚠️ **刻意不从列表里删掉**：
       *    既有设计原则是「失败路径仍然在列表里，因为环境可能变了，不能永久排除」。
       *    把它删掉会让"软件修好了"这件事永远学不回来。
       *
       *    所以这里只做三件事：**降序、打标、说明**。
       *    模型看到 `⚠️ 可能已过期` 就会先验证再用，而不是盲信。
       *
       * 与 `giveUp` 的区别（两个不同判断）：
       *   - `giveUp`：累计失败多、成功率低 → "这条路一直不行"
       *   - `stale` ：**连续**失败达到阈值 → "这条路**现在**可能不行了"
       */
      const consecutive = eff?.consecutiveFailures ?? 0;
      const isStale = consecutive >= ARCHIVE_AFTER_CONSECUTIVE_FAILURES;
      if (isStale) stalePaths.push(path);

      ranked.push({
        path,
        score,
        why:
          `历史记录：尝试 ${eff?.attempts ?? 0} 次、成功 ${eff?.succeeded ?? 0} 次` +
          (eff?.avgDurationMs ? `，平均耗时 ${Math.round(eff.avgDurationMs)}ms` : '') +
          (eff?.lastFailure ? `；上次失败原因：${eff.lastFailure}` : '') +
          (isStale
            ? ` ⚠️ 可能已过期：连续失败 ${consecutive} 次（软件更新或界面改版？）—— 用之前先验证`
            : '') +
          (giveUp ? ' ⚠️ 该路径反复失败，建议放弃' : ''),
        fromExperience: true,
        memoryId: mem.id,
        ...(giveUp ? { adviseGivingUp: true } : {}),
        ...(isStale ? { stale: true } : {}),
      });
    }

    ranked.sort((a, b) => b.score - a.score);

    /**
     * ★ 应用级聚合（跨说法稳定）。
     *
     * ⚠️ 只在"签名没命中任何历史"时才附加：
     *    命中时任务级信息更精确，不必用更粗的应用级去干扰模型判断。
     *    （两者都给会让模型在两份排名之间纠结。）
     */
    const appLevel =
      args.app !== undefined && !ranked.some((r) => r.fromExperience)
        ? (() => {
            const agg = this.byApp(args.app as string);
            return agg.samples > 0
              ? { app: args.app as string, ranked: agg.ranked, samples: agg.samples }
              : undefined;
          })()
        : undefined;

    return {
      taskSignature: signature,
      ranked,
      discouraged: ranked.filter((r) => r.adviseGivingUp === true).map((r) => r.path),
      stale: stalePaths,
      ...(appLevel !== undefined ? { appLevel } : {}),
      usedMemory: ranked.some((r) => r.fromExperience) || appLevel !== undefined,
    };
  }

  /**
   * 按**应用**聚合的历史经验（跨任务说法）。
   *
   * ★★ 为什么需要它（实测驱动）：
   *   同一件事的 5 种中文说法会算出 **5 个不同的任务签名**
   *   （"把 Word 转 PDF" / "导出成 pdf" / "另存为 PDF" …）——
   *   按签名召回**几乎不命中**。
   *
   *   而"在某个应用上，哪条路走得通"是**跨说法稳定**的，
   *   这恰好也是桌面控制真正要回答的问题。
   *
   * ⚠️ app 的取值：优先用显式字段（新记录），
   *    旧记录没有就从 `taskSignature` 的段里找（兼容）。
   */
  byApp(app: string): {
    readonly ranked: readonly PathRecommendation[];
    readonly samples: number;
  } {
    const want = app.trim().toLowerCase();
    if (want.length === 0) return { ranked: [], samples: 0 };

    /** 这条记忆是否属于该应用 */
    const belongs = (m: OperationMemory): boolean => {
      if (m.app !== undefined) return m.app.trim().toLowerCase() === want;
      // 旧记录：签名形如 `verb|object|app`，逐段找（空段会被过滤，位置不固定）
      return m.taskSignature
        .split('|')
        .some((seg) => seg.trim().toLowerCase() === want);
    };

    // 按路径汇总（跨任务）
    const agg = new Map<ExecutionPath, { attempts: number; succeeded: number; ms: number; n: number; lastFailure?: string; consecutive: number }>();
    for (const m of this.all()) {
      if (m.kind !== 'method' || m.path === undefined) continue;
      if (!belongs(m)) continue;
      const cur = agg.get(m.path) ?? { attempts: 0, succeeded: 0, ms: 0, n: 0, consecutive: 0 };
      const eff = m.effectiveness;
      cur.attempts += eff?.attempts ?? 0;
      cur.succeeded += eff?.succeeded ?? 0;
      if (eff?.avgDurationMs) {
        cur.ms += eff.avgDurationMs;
        cur.n += 1;
      }
      if (eff?.lastFailure !== undefined) cur.lastFailure = eff.lastFailure;
      // 该应用上"最近一条"的连续失败数：只要有一条还在连续失败，就提示
      cur.consecutive = Math.max(cur.consecutive, eff?.consecutiveFailures ?? 0);
      agg.set(m.path, cur);
    }

    const ranked: PathRecommendation[] = [];
    for (const [path, a] of agg) {
      const rate = a.attempts === 0 ? 0.5 : a.succeeded / a.attempts;
      const durationBonus = a.n > 0 ? durationFactor(a.ms / a.n) : 0;
      const score = 0.7 * rate + 0.2 * durationBonus + 0.1 * 0.5;
      const stale = a.consecutive >= ARCHIVE_AFTER_CONSECUTIVE_FAILURES;
      ranked.push({
        path,
        score,
        why:
          `该应用上的历史（跨任务）：尝试 ${a.attempts} 次、成功 ${a.succeeded} 次` +
          (a.lastFailure !== undefined ? `；上次失败原因：${a.lastFailure}` : '') +
          (stale ? ' ⚠️ 可能已过期：连续失败' : ''),
        fromExperience: true,
        ...(stale ? { stale: true } : {}),
      });
    }
    ranked.sort((x, y) => y.score - x.score);
    const samples = [...agg.values()].reduce((s, a) => s + a.attempts, 0);
    return { ranked, samples };
  }

  // ── 记录执行结果 ──

  /**
   * 记录一次执行尝试。
   *
   * ★ 这是"学习"发生的地方 —— 第 1 次试 UI 失败、试 COM 成功，
   *   这些结果写进来，第 5 次就能直接命中 COM。
   */
  recordAttempt(args: {
    readonly task: string;
    readonly app?: string;
    readonly path: ExecutionPath;
    readonly success: boolean;
    readonly durationMs: number;
    /** 失败原因（成功时为空） */
    readonly failureReason?: string;
    /** 方法的具体描述（首次记录时用） */
    readonly method?: string;
    /** 证据：哪次任务的哪条事件 */
    readonly evidence?: string;
  }): OperationMemory {
    const now = this.clock.now();
    const signature = taskSignature({
      task: args.task,
      ...(args.app !== undefined ? { app: args.app } : {}),
    });

    const existing = this.matchingMethods(signature).find((m) => m.path === args.path);

    if (existing) {
      const eff = existing.effectiveness ?? {
        attempts: 0,
        succeeded: 0,
        lastUsedAt: now,
        avgDurationMs: 0,
      };

      const attempts = eff.attempts + 1;
      const succeeded = eff.succeeded + (args.success ? 1 : 0);

      // 平均耗时用 **EMA** 平滑。
      //
      // ⚠️ 我第一版用的是"对样本数封顶后加权"，方向搞反了：
      //    给最近样本更大权重，反而让一次极慢的尝试主导了平均值
      //    （实测 100×10 后再来一次 10000，朴素均值 1000，我的做法算出 1750）。
      //    EMA 是收敛到长期均值、并让单次极端值只占 α 的份额 —— 这才是"不被拖累"。
      //
      //    与记忆适应度用的是同一套平滑（α=0.15），保持项目内一致。
      const EMA_ALPHA = 0.15;
      const avgDurationMs =
        eff.attempts === 0
          ? args.durationMs
          : EMA_ALPHA * args.durationMs + (1 - EMA_ALPHA) * eff.avgDurationMs;

      const next: OperationMemory = {
        ...existing,
        // ★ 首次记录时可能没带 app，后续带上就补进记忆
        ...(existing.app === undefined && args.app !== undefined ? { app: args.app } : {}),
        effectiveness: {
          attempts,
          succeeded,
          lastUsedAt: now,
          avgDurationMs,
          /**
           * ★ 连续失败计数（方案 §6.3⑤ 第 3 层）：
           *   失败 +1，**成功清零**。
           *   清零是关键 —— 否则"软件更新后这条路又行了"也永远回不来。
           */
          consecutiveFailures: args.success ? 0 : (eff.consecutiveFailures ?? 0) + 1,
          ...(args.success
            ? {}
            : { lastFailure: args.failureReason ?? '未说明原因' }),
        },
        // 置信度随样本量增长，但有上限（不因做过 100 次就变成"绝对真理"）
        confidence: Math.min(0.95, existing.confidence + (args.success ? 0.05 : -0.08)),
        updatedAt: now,
        ...(args.evidence !== undefined
          ? { evidence: [...existing.evidence, args.evidence] }
          : {}),
      };

      this.entries.set(existing.id, next);

      this.log.append({
        type: 'fitness.updated',
        actor: 'butler',
        payload: {
          operationMemoryId: existing.id,
          kind: 'operation',
          taskSignature: signature,
          path: args.path,
          success: args.success,
          attempts,
          succeeded,
          successRate: Number((succeeded / attempts).toFixed(3)),
          durationMs: args.durationMs,
          failureReason: args.failureReason ?? null,
        },
        createdAt: now,
      });

      return next;
    }

    // 首次记录
    const created: OperationMemory = {
      id: `op_${++this.seq}_${now.toString(36)}`,
      userId: this.userId,
      kind: 'method',
      taskSignature: signature,
      taskLabel: args.task,
      // ★ 显式存 app（供"按应用聚合"用，见 OperationMemory.app 的注释）
      ...(args.app !== undefined ? { app: args.app } : {}),
      content: args.method ?? `这类任务走「${PATH_LABEL[args.path]}」${args.success ? '可行' : '不可行'}`,
      path: args.path,
      effectiveness: {
        attempts: 1,
        succeeded: args.success ? 1 : 0,
        lastUsedAt: now,
        avgDurationMs: args.durationMs,
        /**
         * ★ 首次记录也要写连续失败计数（方案 §6.3⑤）。
         *   ⚠️ 我第一版只在"更新已有记录"的分支里加了它，
         *      于是**第一次失败记成 undefined、第二次才变 1** —— 差一次，
         *      而阈值是 2 次，意味着"过期判定"永远慢一次。测试直接抓到了。
         */
        consecutiveFailures: args.success ? 0 : 1,
        ...(args.success ? {} : { lastFailure: args.failureReason ?? '未说明原因' }),
      },
      // 首次记录置信度不高 —— 一次成功不足以证明这条路永远可行
      confidence: args.success ? 0.5 : 0.4,
      evidence: args.evidence !== undefined ? [args.evidence] : [],
      createdAt: now,
      updatedAt: now,
    };

    this.entries.set(created.id, created);

    this.log.append({
      type: 'fitness.updated',
      actor: 'butler',
      payload: {
        operationMemoryId: created.id,
        kind: 'operation',
        taskSignature: signature,
        path: args.path,
        success: args.success,
        attempts: 1,
        succeeded: args.success ? 1 : 0,
        isNew: true,
        failureReason: args.failureReason ?? null,
        snapshot: operationSnapshotOf(created),
      },
      createdAt: now,
    });

    return created;
  }

  // ── 偏好与环境记忆 ──

  /** 记录一条偏好记忆（用户希望怎么做）。 */
  recordPreference(args: {
    readonly content: string;
    readonly taskLabel: string;
    readonly evidence?: string;
  }): OperationMemory {
    return this.createSimple('preference', args);
  }

  /** 记录一条环境记忆（这台机器的事实）。 */
  recordEnvironment(args: {
    readonly content: string;
    readonly taskLabel: string;
    readonly evidence?: string;
  }): OperationMemory {
    return this.createSimple('environment', args);
  }

  private createSimple(
    kind: 'preference' | 'environment',
    args: { readonly content: string; readonly taskLabel: string; readonly evidence?: string },
  ): OperationMemory {
    const now = this.clock.now();
    const created: OperationMemory = {
      id: `op_${++this.seq}_${now.toString(36)}`,
      userId: this.userId,
      kind,
      taskSignature: taskSignature({ task: args.taskLabel }),
      taskLabel: args.taskLabel,
      content: args.content,
      confidence: 0.7,
      evidence: args.evidence !== undefined ? [args.evidence] : [],
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(created.id, created);

    this.log.append({
      type: 'fitness.updated',
      actor: 'butler',
      payload: {
        operationMemoryId: created.id,
        kind,
        content: args.content,
        isNew: true,
      },
      createdAt: now,
    });

    return created;
  }

  /** 查找与任务相关的偏好与环境记忆（供执行前注入）。 */
  relevantGuidance(args: { readonly task: string }): readonly OperationMemory[] {
    const sig = taskSignature({ task: args.task });
    const verb = sig.split('|')[0] ?? '';
    const object = sig.split('|')[1] ?? '';

    return this.all().filter((e) => {
      if (e.kind === 'method') return false;
      // 环境记忆与任务无关时也应注入（"Python 装在 D 盘"对任何任务都成立）
      if (e.kind === 'environment') return true;
      // 偏好记忆要相关：签名有交集
      const es = e.taskSignature.split('|');
      return es[0] === verb || es[1] === object || e.taskSignature === sig;
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 内部
// ═══════════════════════════════════════════════════════════

/** 成功率。无记录时给先验值的一半（保守）。 */
export function successRate(m: OperationMemory): number {
  const e = m.effectiveness;
  if (!e || e.attempts === 0) return 0.5;
  return e.succeeded / e.attempts;
}

/**
 * 耗时因子：越快分越高。
 *
 * 用对数刻度 —— 100ms 与 200ms 的差别远大于 10s 与 10.1s。
 */
function durationFactor(avgMs: number): number {
  if (avgMs <= 0) return 0.5;
  // 100ms → ~1.0；1s → ~0.8；10s → ~0.6；60s → ~0.4
  const score = 1 - Math.log10(Math.max(1, avgMs / 100)) * 0.2;
  return Math.max(0, Math.min(1, score));
}

/** 供测试与界面：把一条方法记忆压成一行摘要。 */
export function summarizeOperation(m: OperationMemory): string {
  if (m.kind !== 'method') {
    return `[${m.kind === 'preference' ? '偏好' : '环境'}] ${m.content}`;
  }
  const rate = successRate(m);
  const e = m.effectiveness;
  return (
    `${m.taskLabel} → ${PATH_LABEL[m.path ?? 'manual']}` +
    `（${e?.succeeded ?? 0}/${e?.attempts ?? 0} 成功，${(rate * 100).toFixed(0)}%）`
  );
}

export type { OperationMemory, ExecutionPath } from './operation.js';
export { PATH_LABEL, taskSignature, sameTaskKind } from './operation.js';
