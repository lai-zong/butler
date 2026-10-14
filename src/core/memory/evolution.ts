/**
 * 演化引擎 —— 让记忆真的会变化
 *
 * 设计依据：方案 § 8.3（三层演化模型）、§ 8.6（可观测可干预）
 *
 * `fitness.ts` 提供纯函数（公式、状态机）；本文件负责**把它接到仓储上**：
 *   · 命中时更新适应度并可能唤醒
 *   · 定时跑一轮演化，执行休眠/归档
 *   · 提供用户手动干预（提权 / 降权 / 强制唤醒 / 强制归档）
 *   · 把每次变化写成事件与演化日志（"本月 3 条休眠、1 条唤醒"的来源）
 *
 * ⚠️ 全部确定性：时间来自 ClockPort，随机来自 RandomPort。
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort, RandomPort } from '../ports/clock.js';
import {
  adaptThreshold,
  computeFitness,
  DEFAULT_PARAMS,
  nextLifecycle,
  type EvolutionParams,
  type LifecycleTransition,
  type OutcomeStats,
} from './fitness.js';
import type { MemoryStore } from './store.js';
import type { EvolutionEvent, MemoryEntry } from './types.js';

/** 行为统计的累计器 —— 由反馈事件驱动，不由模型判断。 */
interface StatsAccumulator {
  hits: number;
  successes: number;
  misuses: number;
  conflicts: number;
  lastHitAt: number | null;
}

export interface EvolutionEngineOptions {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly userId: string;
  readonly params?: EvolutionParams;
}

export interface EvolutionPassResult {
  readonly evaluated: number;
  readonly dormant: readonly string[];
  readonly archived: readonly string[];
  readonly revived: readonly string[];
  readonly threshold: number;
}

export class EvolutionEngine {
  private readonly log: EventLog;
  private readonly store: MemoryStore;
  private readonly clock: ClockPort;
  /** 供召回层复用的确定性随机源（探索性召回需要） */
  readonly random: RandomPort;
  private readonly userId: string;
  private params: EvolutionParams;

  /** memoryId → 行为统计。方案要求这项数据从事件流累计，可随时重算。 */
  private readonly stats = new Map<string, StatsAccumulator>();
  private readonly evolutionLog: EvolutionEvent[] = [];
  private evoSeq = 0;

  constructor(opts: EvolutionEngineOptions) {
    this.log = opts.log;
    this.store = opts.store;
    this.clock = opts.clock;
    this.random = opts.random;
    this.userId = opts.userId;
    this.params = opts.params ?? DEFAULT_PARAMS;
  }

  // ── 只读视图 ──

  getParams(): EvolutionParams {
    return this.params;
  }

  /** 演化日志（界面"本月 3 条休眠·1 条唤醒·2 条合并"的来源）。 */
  log_(): readonly EvolutionEvent[] {
    return this.evolutionLog;
  }

  evolutionEvents(): readonly EvolutionEvent[] {
    return this.evolutionLog;
  }

  statsOf(memoryId: string): OutcomeStats {
    return this.toOutcomeStats(memoryId);
  }

  /** 当前召回阈值（随库规模自适应）。 */
  currentThreshold(): number {
    return adaptThreshold(this.store.size(), this.params.recallThresholdBase);
  }

  // ── 行为反馈（驱动适应度的唯一数据源）──

  /**
   * 记录一次命中：记忆被召回了。
   *
   * 顺带处理**唤醒** —— 休眠/归档的记忆被再次命中时会自动回升，
   * 这是"淘汰 ≠ 删除"的关键行为。
   */
  recordHit(memoryId: string): LifecycleTransition {
    const entry = this.store.get(memoryId);
    if (!entry) return { kind: 'none' };

    const now = this.clock.now();
    const acc = this.acc(memoryId);
    acc.hits += 1;
    acc.lastHitAt = now;

    const transition = this.applyFitness(entry, now, now);

    // ★ 唤醒必须记事件与演化日志 —— 它是"淘汰 ≠ 删除"最直观的证据。
    //   `applyFitness` 只负责改状态，事件记录要在这里补，
    //   否则日志里只有"休眠"没有"唤醒"，演化叙事就断了一半。
    if (transition.kind !== 'none') {
      this.recordTransition(entry, transition, now);
    }

    this.log.append({
      type: 'memory.recalled',
      actor: 'butler',
      payload: { memoryId, hits: acc.hits, lifecycle: this.store.get(memoryId)?.lifecycle },
      createdAt: now,
    });

    return transition;
  }

  /**
   * 记录一次效果验证（创新点 ②）。
   *
   * @param effective true = 用户采纳/未纠正；false = 用户纠正/撤销
   */
  recordOutcome(memoryId: string, effective: boolean, note = ''): void {
    const entry = this.store.get(memoryId);
    if (!entry) return;

    const now = this.clock.now();
    const acc = this.acc(memoryId);
    if (effective) acc.successes += 1;
    else acc.misuses += 1;

    this.applyFitness(entry, now);

    this.log.append({
      type: effective ? 'principle.effectMeasured' : 'intervention.correct',
      actor: 'user',
      payload: { memoryId, effective, note, successes: acc.successes, misuses: acc.misuses },
      createdAt: now,
    });
  }

  /** 记录一次冲突（与其它记忆矛盾）。 */
  recordConflict(memoryId: string): void {
    const entry = this.store.get(memoryId);
    if (!entry) return;
    const now = this.clock.now();
    this.acc(memoryId).conflicts += 1;
    this.applyFitness(entry, now);
    this.log.append({
      type: 'fitness.updated',
      actor: 'supervisor',
      payload: { memoryId, reason: 'conflict', conflicts: this.acc(memoryId).conflicts },
      createdAt: now,
    });
  }

  // ── 演化主循环 ──

  /**
   * 跑一轮演化。
   *
   * 定时任务（天级）调用。做的事：
   *   ① 重算全部记忆的适应度
   *   ② 执行生命周期迁移（活跃→休眠→归档）
   *   ③ 检查参数自适应（召回阈值是否该上调）
   *
   * 注意顺序：**先算适应度，再判迁移** —— 否则归档判定会用上旧的分数。
   */
  runPass(): EvolutionPassResult {
    const now = this.clock.now();
    const dormant: string[] = [];
    const archived: string[] = [];
    const revived: string[] = [];

    for (const entry of this.store.all()) {
      const t = this.applyFitness(entry, now);
      switch (t.kind) {
        case 'dormant':
          dormant.push(this.recordTransition(entry, t, now));
          break;
        case 'archived':
          archived.push(this.recordTransition(entry, t, now));
          break;
        case 'revived':
          revived.push(this.recordTransition(entry, t, now));
          break;
        case 'none':
          break;
      }
    }

    // ③ 参数自适应：库规模变了，阈值跟着变
    const threshold = this.currentThreshold();
    if (Math.abs(threshold - this.lastThreshold) > 1e-6) {
      this.log.append({
        type: 'evolution.thresholdAdapted',
        actor: 'system',
        payload: {
          from: this.lastThreshold,
          to: threshold,
          librarySize: this.store.size(),
          reason: '记忆库规模变化',
        },
        createdAt: now,
      });
      this.pushEvolution({
        type: 'thresholdAdapted',
        memoryIds: [],
        detail: `召回阈值 ${this.lastThreshold.toFixed(2)} → ${threshold.toFixed(2)}（库规模 ${this.store.size()}）`,
        actor: 'system',
      });
      this.lastThreshold = threshold;
    }

    return {
      evaluated: this.store.size(),
      dormant,
      archived,
      revived,
      threshold,
    };
  }

  // ── 人工干预（§ 8.6：可观测 + 可干预，所以演化不是黑盒）──

  /** 用户手动调整权重。 */
  adjustWeight(memoryId: string, delta: number, reason = '用户手动调整'): boolean {
    const entry = this.store.get(memoryId);
    if (!entry) return false;

    const now = this.clock.now();
    const next = Math.min(this.params.maxFitness, Math.max(0, entry.fitness + delta));

    // 直接写入 —— 绕过 EMA，因为这是用户的显式意志，不该被平滑掉
    this.store.setFitness(memoryId, next);

    this.log.append({
      type: 'intervention.weightAdjusted',
      actor: 'user',
      payload: { memoryId, from: entry.fitness, to: next, delta, reason },
      createdAt: now,
    });
    this.pushEvolution({
      type: 'weightAdjusted',
      memoryIds: [memoryId],
      detail: `用户手动调整权重 ${entry.fitness.toFixed(2)} → ${next.toFixed(2)}`,
      actor: 'user',
    });
    return true;
  }

  /** 用户强制唤醒一条记忆。 */
  forceRevive(memoryId: string): boolean {
    const entry = this.store.get(memoryId);
    if (!entry) return false;
    if (entry.memClass === 'global_constraint') return false; // 硬约束本来就不会休眠

    const now = this.clock.now();
    this.store.setLifecycle(memoryId, 'active', {
      revivedCount: entry.revivedCount + 1,
      clearDormant: true,
    });

    const t: LifecycleTransition = { kind: 'revived', reason: '用户强制唤醒' };
    this.recordTransition(entry, t, now);
    return true;
  }

  /** 用户强制归档。 */
  forceArchive(memoryId: string): boolean {
    const entry = this.store.get(memoryId);
    if (!entry) return false;
    if (entry.memClass === 'global_constraint') return false;

    const now = this.clock.now();
    this.store.setLifecycle(memoryId, 'archived', { archivedAt: now });
    this.recordTransition(entry, { kind: 'archived', reason: '用户强制归档' }, now);
    return true;
  }

  // ── 内部 ──

  private lastThreshold = DEFAULT_PARAMS.recallThresholdBase;

  /**
   * 重算适应度并执行迁移。
   *
   * ⚠️ 顺序关键：**先算适应度，再判迁移**。
   *    否则"休眠 → 归档"的判定会用上没更新的分数。
   */
  private applyFitness(entry: MemoryEntry, now: number, hitAt?: number): LifecycleTransition {
    const current = this.store.get(entry.id) ?? entry;
    const stats = this.toOutcomeStats(entry.id);

    const fit = computeFitness({
      entry: current,
      stats,
      now,
      params: this.params,
      previousFitness: current.fitness,
    });

    this.store.setFitness(entry.id, fit.smoothed, hitAt !== undefined ? { at: hitAt } : undefined);
    this.log.append({
      type: 'fitness.updated',
      actor: 'system',
      payload: {
        memoryId: entry.id,
        observed: Number(fit.observed.toFixed(4)),
        smoothed: Number(fit.smoothed.toFixed(4)),
        components: fit.components,
        decayClass: fit.decayClass,
      },
      createdAt: now,
    });

    // 用到更新后的分数去判迁移
    const updated = this.store.get(entry.id) ?? current;
    const transition = nextLifecycle({ entry: updated, stats, now, params: this.params });

    if (transition.kind === 'dormant') {
      this.store.setLifecycle(entry.id, 'dormant', { dormantSince: now });
    } else if (transition.kind === 'archived') {
      this.store.setLifecycle(entry.id, 'archived', { archivedAt: now });
    } else if (transition.kind === 'revived') {
      this.store.setLifecycle(entry.id, 'active', {
        revivedCount: updated.revivedCount + 1,
        clearDormant: true,
      });
    }

    return transition;
  }

  /** 迁移落事件 + 演化日志，返回 memoryId 方便汇总。 */
  private recordTransition(
    entry: MemoryEntry,
    transition: LifecycleTransition,
    now: number,
  ): string {
    if (transition.kind === 'none') return entry.id;

    const type =
      transition.kind === 'dormant'
        ? 'memory.dormant'
        : transition.kind === 'archived'
          ? 'memory.archived'
          : 'memory.revived';

    this.log.append({
      type,
      actor: 'system',
      payload: {
        memoryId: entry.id,
        content: entry.content,
        reason: transition.reason,
        fitness: this.store.get(entry.id)?.fitness,
      },
      createdAt: now,
    });

    this.pushEvolution({
      type: transition.kind === 'revived' ? 'revived' : transition.kind,
      memoryIds: [entry.id],
      detail: transition.reason,
      actor: 'system',
    });

    return entry.id;
  }

  private pushEvolution(e: Omit<EvolutionEvent, 'id' | 'userId' | 'at'>): void {
    this.evoSeq += 1;
    this.evolutionLog.push({
      id: `evo_${this.evoSeq}`,
      userId: this.userId,
      at: this.clock.now(),
      ...e,
    });
  }

  private acc(memoryId: string): StatsAccumulator {
    let a = this.stats.get(memoryId);
    if (!a) {
      const entry = this.store.get(memoryId);
      a = {
        hits: entry?.hitCount ?? 0,
        successes: 0,
        misuses: 0,
        conflicts: 0,
        lastHitAt: entry?.lastHitAt ?? null,
      };
      this.stats.set(memoryId, a);
    }
    return a;
  }

  private toOutcomeStats(memoryId: string): OutcomeStats {
    const a = this.acc(memoryId);
    const entry = this.store.get(memoryId);
    return {
      hits: a.hits,
      successes: a.successes,
      misuses: a.misuses,
      conflicts: a.conflicts,
      lastHitAt: a.lastHitAt,
      createdAt: entry?.createdAt ?? this.clock.now(),
      evidenceCount: entry?.evidence.length ?? 0,
    };
  }
}
