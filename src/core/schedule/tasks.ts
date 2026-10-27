/**
 * 四个定时任务的具体实现 —— 把已有机制串成**周期闭环**
 *
 * 设计依据：方案 § 5.4
 *
 * ★ 这个文件的价值不在于"加了定时器"，而在于**它让已有的机制活起来**：
 *
 *   每日反思    → 反思引擎（此前只能手动调）
 *   周复盘      → 画像快照 + 规律重算（"最强演示件"的自动化产出）
 *   主动服务    → 时间维度画像的**实际用途**（方案 § 7.4）
 *   行为聚合    → 原始记录 → 聚合（防线二的执行者）
 *
 *   没有它，反思、画像、规律都只是"能调用的函数"；
 *   有了它，系统才真的"常驻在电脑里、自己会动"。
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { MemoryStore } from '../memory/store.js';
import type { ActivityObserver } from '../activity/observe.js';
import { derivePatterns, patternGuidance } from '../activity/patterns.js';
import { captureProfile, diffProfiles, type ProfileSnapshot } from '../activity/profile.js';
import type { TemporalPattern } from '../activity/types.js';
import type { EvolutionPassResult } from '../memory/evolution.js';
import type { ScheduledTaskKind, TaskHandler } from './scheduler.js';

// ═══════════════════════════════════════════════════════════
// 依赖
// ═══════════════════════════════════════════════════════════

export interface TaskContext {
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly store: MemoryStore;
  readonly userId: string;
  readonly observer?: ActivityObserver;
  /** 当前会话数（画像快照要用）*/
  readonly sessionCount: () => number;
  /**
   * 执行一次反思（由上层注入 —— 反思需要模型，核心层不直连适配器）。
   *
   * ⚠️ 刻意做成注入：调度器要能在**没有模型**的情况下测试与运行
   *    （行为聚合就完全不需要模型）。
   */
  readonly reflect?: (args: {
    readonly scope: 'daily' | 'weekly';
    /**
     * 时间维度规律（已渲染成一句一条）。
     *
     * ★ 由**周复盘先算好再传进来**，不让反思自己去算 ——
     *   `derivePatterns` 会写 `pattern.derived` 事件，两处各算一次会重复落事件。
     */
    readonly temporalPatterns?: readonly string[];
  }) => Promise<{
  readonly candidateCount: number;
  readonly summary: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}>;
  /** 待提醒事项的检查（主动服务）*/
  readonly checkReminders?: () => Promise<readonly { readonly title: string; readonly dueAt: number }[]>;
  /**
   * 日级记忆演化（休眠/归档/唤醒）。
   *
   * ★ 由 runtime 注入同一个 EvolutionEngine 实例；每日反思任务调用。
   *   没有注入时任务照常跑，只是不迁移生命周期。
   */
  readonly evolve?: () => EvolutionPassResult;
  /**
   * 周级相似合并（由上层注入 `mergeAll`）。
   *
   * 不接时周复盘照常跑，只在摘要里注明未做；不假装合并过。
   */
  readonly merge?: () => { readonly merged: number; readonly absorbed: number };
  /**
   * 每日日记任务。注入后由调度器在 04:10 执行；
   * 旧 dailyReflection 不再注册，避免两套常规总结同时消耗 token。
   */
  readonly diary?: (args: {
    readonly scheduledAt: number;
    readonly manual: boolean;
  }) => Promise<{
    readonly created: number;
    readonly skipped: number;
    readonly failed: number;
    readonly summary: string;
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  }>;
}

/** 最近一次规律提取的结果（供界面与主动服务复用）。*/
export interface PatternState {
  readonly patterns: readonly TemporalPattern[];
  readonly observedDays: number;
  readonly derivedAt: number;
}

// ═══════════════════════════════════════════════════════════
// 任务工厂
// ═══════════════════════════════════════════════════════════

export interface TaskBundle {
  readonly handlers: Readonly<Record<ScheduledTaskKind, TaskHandler>>;
  /** 最近一次画像快照（周复盘产出）*/
  latestProfile: () => ProfileSnapshot | null;
  /** 上一次画像快照（用于成长对比）*/
  previousProfile: () => ProfileSnapshot | null;
  /** 当前的规律集 */
  patterns: () => PatternState | null;
  /** 待提醒事项 */
  reminders: () => readonly { readonly title: string; readonly dueAt: number }[];
}

/**
 * 构造四个任务处理器。
 *
 * ⚠️ 处理器都设计成**幂等且可手动触发** ——
 *    方案要求"每个任务都提供「立即执行」操作项，演示时不依赖等待"。
 */
export function buildTasks(ctx: TaskContext): TaskBundle {
  let latest: ProfileSnapshot | null = null;
  let previous: ProfileSnapshot | null = null;
  let patternState: PatternState | null = null;
  let pendingReminders: readonly { readonly title: string; readonly dueAt: number }[] = [];

  // ── 每日反思 ──
  const dailyReflection: TaskHandler = async () => {
    let evolutionText = '';
    if (ctx.evolve) {
      try {
        const e = ctx.evolve();
        evolutionText =
          `演化：评估 ${e.evaluated} 条，休眠 ${e.dormant.length}，` +
          `归档 ${e.archived.length}，唤醒 ${e.revived.length}。`;
      } catch (err) {
        // 演化失败不阻断反思；如实写进摘要，不假装跑过。
        evolutionText = `演化失败：${err instanceof Error ? err.message : String(err)}。`;
      }
    }

    if (!ctx.reflect) {
      return { summary: `未接入反思引擎，跳过反思（可手动触发）。${evolutionText}`.trim() };
    }
    const r = await ctx.reflect({ scope: 'daily' });
    ctx.log.append({
      type: 'reflection.done',
      actor: 'scheduler',
      payload: {
        scope: 'daily',
        candidateCount: r.candidateCount,
        note: '定时任务产出，候选需用户审核后才生效',
      },
      createdAt: ctx.clock.now(),
    });
    return {
      summary: `每日反思完成，产出 ${r.candidateCount} 条候选。${r.summary}${evolutionText}`,
      ...(r.usage !== undefined ? { usage: r.usage } : {}),
    };
  };

  // ── 每日日记（新的常规长期记忆入口）──
  const dailyDiary: TaskHandler = async () => {
    if (!ctx.diary) {
      return { summary: '未接入日记生成器' };
    }
    try {
      const r = await ctx.diary({ scheduledAt: ctx.clock.now(), manual: false });
      let evolutionText = '';
      if (ctx.evolve) {
        try {
          const e = ctx.evolve();
          evolutionText =
            ` 演化：评估 ${e.evaluated} 条，休眠 ${e.dormant.length}，` +
            `归档 ${e.archived.length}，唤醒 ${e.revived.length}` +
            `，试行转正 ${e.trialPromoted?.length ?? 0}，试行到期 ${e.trialArchived?.length ?? 0}。`;
        } catch (err) {
          evolutionText = ` 演化失败：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      return {
        summary: r.summary + evolutionText,
        ...(r.usage !== undefined ? { usage: r.usage } : {}),
      };
    } catch (err) {
      return {
        summary: `每日日记失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  // ── 管家周复盘 ──
  const weeklyReview: TaskHandler = async () => {
    const parts: string[] = [];
    let usedInput = 0;
    let usedOutput = 0;

    /**
     * ★ 顺序调整（v8）：**先算时间规律，再反思**。
     *
     * ⚠️ 原来反思是第 ① 步、规律是第 ② 步，于是反思拿不到规律
     *    （`temporalPatterns` 恒为空）。而"时间维度画像"的意义恰恰是
     *    **参与反思**（方案 §7.4）—— 顺序反了等于白算。
     *
     * ⚠️ 也不能让反思自己去算：`derivePatterns` **会写事件**
     *    （`pattern.derived`），两处各算一次就会重复落事件。
     *    所以这里算一次，把结果**传进去**。
     */
    let renderedPatterns: readonly string[] = [];
    if (ctx.observer) {
      const aggregates = ctx.observer.aggregate();
      const derived = derivePatterns({
        aggregates,
        options: { log: ctx.log, clock: ctx.clock, userId: ctx.userId },
      });
      patternState = {
        patterns: derived.patterns,
        observedDays: derived.observedDays,
        derivedAt: ctx.clock.now(),
      };
      renderedPatterns = derived.patterns.map((p) => patternGuidance(p));
      parts.push(
        derived.patterns.length > 0
          ? `重算规律 ${derived.patterns.length} 条（观察 ${derived.observedDays} 天）`
          : `未能重算规律：${derived.reason ?? '数据不足'}`,
      );
    }

    // ② 跨领域复盘（把①算出的时间规律一起喂进去）
    if (ctx.reflect) {
      const r = await ctx.reflect({
        scope: 'weekly',
        ...(renderedPatterns.length > 0 ? { temporalPatterns: renderedPatterns } : {}),
      });
      usedInput += r.usage?.inputTokens ?? 0;
      usedOutput += r.usage?.outputTokens ?? 0;
      parts.push(`跨领域复盘产出 ${r.candidateCount} 条候选`);
    } else {
      parts.push('未接入反思引擎');
    }

    // ②b 相似合并：只合并 active、同池、相似度足够的条目；不删数据。
    if (ctx.merge) {
      try {
        const m = ctx.merge();
        parts.push(
          m.merged > 0
            ? `相似合并 ${m.merged} 组（吸收 ${m.absorbed} 条，保留原数据）`
            : '本轮没有达到合并阈值的记忆',
        );
      } catch (err) {
        parts.push(`相似合并失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      parts.push('未接入相似合并');
    }

    // ③ 生成画像快照（方案 § 3.3 的"最强演示件"由这里自动产出）
    previous = latest;
    const snap = captureProfile({
      log: ctx.log,
      clock: ctx.clock,
      store: ctx.store,
      userId: ctx.userId,
      patterns: patternState?.patterns ?? [],
      sessionCount: ctx.sessionCount(),
    });
    latest = snap;

    // ④ 若有上一份快照，把成长差异也写进摘要
    if (previous) {
      const d = diffProfiles(previous, snap);
      parts.push(d.headline);
    }

    return {
      summary: parts.join('；'),
      ...(usedInput > 0 || usedOutput > 0
        ? { usage: { inputTokens: usedInput, outputTokens: usedOutput } }
        : {}),
    };
  };

  // ── 主动服务检查 ──
  const proactiveCheck: TaskHandler = async () => {
    const found: { title: string; dueAt: number }[] = [];

    if (ctx.checkReminders) {
      found.push(...(await ctx.checkReminders()));
    }

    pendingReminders = found;

    if (found.length === 0) {
      return { summary: '没有需要提前提醒的事项' };
    }

    // ★ 用时间维度画像决定**现在合不合适打扰**（方案 § 7.4 的"打断控制"）
    const now = ctx.clock.now();
    const advice = patternState ? interruptAdvice(patternState.patterns, now) : null;

    ctx.log.append({
      type: 'supervisor.observe',
      actor: 'scheduler',
      payload: {
        kind: 'proactiveReminder',
        count: found.length,
        items: found.map((f) => f.title),
        timing: advice?.timing ?? 'unknown',
        advice: advice?.reason ?? '尚无时间维度画像，按默认时机提醒',
      },
      createdAt: now,
    });

    return {
      summary:
        `发现 ${found.length} 项待提醒：${found.map((f) => f.title).join('、')}` +
        (advice ? `。时机建议：${advice.reason}` : ''),
    };
  };

  // ── 行为聚合 ──
  const activityAggregate: TaskHandler = async () => {
    if (!ctx.observer) return { summary: '未开启行为观察' };

    const before = ctx.observer.allAggregates().length;
    const aggs = ctx.observer.aggregate();
    const purged = ctx.observer.purgeExpired();

    return {
      summary:
        `聚合 ${aggs.length} 个小时桶（累计 ${before + aggs.length} 条）；` +
        `清除过期原始记录 ${purged.purged} 条 —— 长期只保留聚合结果`,
    };
  };

  return {
    handlers: { dailyReflection, dailyDiary, weeklyReview, proactiveCheck, activityAggregate },
    latestProfile: () => latest,
    previousProfile: () => previous,
    patterns: () => patternState,
    reminders: () => pendingReminders,
  };
}

// ═══════════════════════════════════════════════════════════
// 打断控制（方案 § 7.4）
// ═══════════════════════════════════════════════════════════

export interface InterruptAdvice {
  /** 'now' 现在合适；'later' 建议换个时间 */
  readonly timing: 'now' | 'later' | 'unknown';
  readonly reason: string;
}

/**
 * 依据时间维度画像判断"现在适不适合打扰用户"。
 *
 * ★ 这是方案 § 7.4 四个用途里最直接的一个（"打断控制"）——
 *   时间维度画像不是拿来看的，是用来**决定行为**的。
 */
export function interruptAdvice(
  patterns: readonly TemporalPattern[],
  now: number,
): InterruptAdvice {
  const d = new Date(now);
  const hour = d.getHours();
  const dow = d.getDay();
  const isWeekend = dow === 0 || dow === 6;

  // 找当前时段的作息规律
  const inRoutine = patterns.find(
    (p) =>
      p.kind === 'routine' &&
      (p.appliesTo === 'all' || (isWeekend ? p.appliesTo === 'weekend' : p.appliesTo === 'weekday')) &&
      p.pattern.includes(`${String(hour).padStart(2, '0')}:00`),
  );
  if (inRoutine) {
    return {
      timing: 'later',
      reason: `现在处于${inRoutine.pattern}（置信度 ${(inRoutine.confidence * 100).toFixed(0)}%），建议稍后再提醒`,
    };
  }

  // 找当前时段的空闲规律
  const inFree = patterns.find(
    (p) =>
      p.kind === 'availability' &&
      (p.appliesTo === 'all' || (isWeekend ? p.appliesTo === 'weekend' : p.appliesTo === 'weekday')) &&
      p.pattern.includes(`${String(hour).padStart(2, '0')}:00`),
  );
  if (inFree) {
    return { timing: 'now', reason: `现在是${inFree.pattern}，适合提醒` };
  }

  // 深夜一律不建议打扰（画像里不一定有这个时段的使用记录）
  if (hour >= 23 || hour < 7) {
    return { timing: 'later', reason: '现在是深夜，建议早上再提醒' };
  }

  return { timing: 'unknown', reason: '画像中未覆盖当前时段，按默认时机提醒' };
}

/** 把规律集渲染成给用户看的清单（界面与答辩材料复用）。 */
export function renderPatterns(patterns: readonly TemporalPattern[]): string {
  if (patterns.length === 0) return '（还没有提取出可用的规律）';
  return patterns.map((p) => `· ${patternGuidance(p)}`).join('\n');
}
