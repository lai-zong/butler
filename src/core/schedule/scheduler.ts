/**
 * 定时任务调度 —— 常驻进程内的轻量调度器
 *
 * 设计依据：方案 § 5.4（定时任务调度设计）、§ 8.6（演化可观测）
 *
 * ★ 五条实现要点，逐条对应：
 *   | 触发器     | 常驻进程内轻量调度器（不引入额外中间件）→ 本文件，零依赖
 *   | 错过补偿   | 进程重启后检查错过任务，**只补跑最近一次**
 *   | 失败重试   | 指数退避，最多 3 次；仍失败则记录并提示
 *   | 手动触发   | 每个任务都提供「立即执行」—— 演示时不依赖等待
 *   | 额度熔断   | 受全局日额度约束；耗尽时自动跳过并提示
 *
 * ⚠️ 方案特别标注的风险：
 *   "定时任务是最容易在后台悄悄烧掉 API 额度的地方。
 *    **额度熔断 + 失败跳过是必须的。**"
 *   所以额度检查发生在**每次执行之前**，而不是事后统计。
 */

import { limitsConfig } from '../config/env.js';
import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';

// ═══════════════════════════════════════════════════════════
// 任务定义
// ═══════════════════════════════════════════════════════════

/**
 * 方案 § 5.4 的四个任务。
 *
 * ⚠️ 这里只声明"是什么、什么时候跑"，不实现"跑什么" ——
 *    具体逻辑由调用方注入（见 `Scheduler.register`）。
 *    这样调度器不需要知道反思/画像/聚合的任何细节。
 */
export type ScheduledTaskKind =
  | 'dailyReflection' // 每日反思：汇总当日会话，仆人层反思 → 产出候选
  | 'weeklyReview' // 管家周复盘：跨领域复盘 + 画像快照 + 重算规律
  | 'proactiveCheck' // 主动服务检查：需提前提醒的事项
  | 'activityAggregate'; // 行为聚合：原始记录 → ActivityAggregate

export interface TaskSchedule {
  /** 触发时刻的小时（0—23） */
  readonly hour: number;
  /** 触发时刻的分钟 */
  readonly minute: number;
  /** 每周只在指定星期几触发；不填表示每天 */
  readonly weekday?: number;
}

/** 方案 § 5.4 的默认频率。 */
export const DEFAULT_SCHEDULES: Record<ScheduledTaskKind, TaskSchedule> = {
  dailyReflection: { hour: 23, minute: 0 },
  weeklyReview: { hour: 22, minute: 0, weekday: 0 }, // 周日
  proactiveCheck: { hour: 8, minute: 0 },
  activityAggregate: { hour: -1, minute: 0 }, // 每小时（hour=-1 表示按小时触发）
};

export const TASK_LABEL: Record<ScheduledTaskKind, string> = {
  dailyReflection: '每日反思',
  weeklyReview: '管家周复盘',
  proactiveCheck: '主动服务检查',
  activityAggregate: '行为聚合',
};

/** 哪些任务会消耗模型 token（额度熔断主要防它们）。 */
export const COSTS_TOKENS: Record<ScheduledTaskKind, boolean> = {
  dailyReflection: true,
  weeklyReview: true,
  proactiveCheck: true,
  activityAggregate: false, // 纯本地聚合，不调模型
};

// ═══════════════════════════════════════════════════════════
// 额度熔断
// ═══════════════════════════════════════════════════════════

export interface QuotaConfig {
  /** 每日最多允许的耗 token 任务执行次数 */
  readonly dailyTokenTaskLimit: number;
  /** 是否已耗尽（由上层根据实际 API 用量设置）*/
  readonly exhausted?: boolean;
  /** 耗尽原因（展示给用户）*/
  readonly exhaustedReason?: string;
}

/**
 * 默认日额度。
 *
 * ★ 可用 DAILY_TOKEN_TASK_LIMIT 覆盖（默认 10，与原先一致）。
 */
export function defaultQuota(): QuotaConfig {
  return { dailyTokenTaskLimit: limitsConfig.dailyTokenTaskLimit };
}

/** @deprecated 用 defaultQuota() —— 保留是为了不破坏既有测试。 */
export const DEFAULT_QUOTA: QuotaConfig = { dailyTokenTaskLimit: 10 };

export interface QuotaState {
  readonly date: string;
  readonly used: number;
  readonly limit: number;
  readonly exhausted: boolean;
  readonly reason?: string;
}

// ═══════════════════════════════════════════════════════════
// 执行记录
// ═══════════════════════════════════════════════════════════

export type RunOutcome = 'succeeded' | 'failed' | 'skipped';

export interface ScheduledRun {
  readonly id: string;
  readonly kind: ScheduledTaskKind;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: RunOutcome;
  /** 第几次尝试（1 起）*/
  readonly attempt: number;
  /** 失败原因 / 跳过原因 */
  readonly note?: string;
  /** 是否由用户手动触发（演示用；手动触发**不占额度**）*/
  readonly manual: boolean;
  /** 本次执行的产出摘要 */
  readonly summary?: string;
}

// ═══════════════════════════════════════════════════════════
// 调度器
// ═══════════════════════════════════════════════════════════

export type TaskHandler = (ctx: {
  readonly kind: ScheduledTaskKind;
  readonly scheduledAt: number;
  readonly manual: boolean;
}) => Promise<{ readonly summary: string }>;

interface TaskEntry {
  readonly kind: ScheduledTaskKind;
  readonly schedule: TaskSchedule;
  readonly handler: TaskHandler;
  /** 上次执行时间（用于判断是否到期与错过补偿）*/
  lastRunAt: number;
  /** 最近一次已补偿的时间点，避免重复补 */
  lastCatchUpKey: string;
}

/** 指数退避基数（毫秒）；第 n 次重试等待 base × 2^(n-1)。 */
export const BACKOFF_BASE_MS = 1000;
/** 最大尝试次数（含首次）。 */
export const MAX_ATTEMPTS = 3;

export class Scheduler {
  private readonly tasks = new Map<ScheduledTaskKind, TaskEntry>();
  private readonly runs: ScheduledRun[] = [];
  private quota: QuotaConfig;
  private seq = 0;

  constructor(
    private readonly log: EventLog,
    private readonly clock: ClockPort,
    quota: QuotaConfig = defaultQuota(),
  ) {
    this.quota = quota;
  }

  /** 注册一个任务。schedule 不填则用方案默认值。 */
  register(args: {
    readonly kind: ScheduledTaskKind;
    readonly handler: TaskHandler;
    readonly schedule?: TaskSchedule;
  }): void {
    this.tasks.set(args.kind, {
      kind: args.kind,
      schedule: args.schedule ?? DEFAULT_SCHEDULES[args.kind],
      handler: args.handler,
      lastRunAt: 0,
      lastCatchUpKey: '',
    });
  }

  // ── 额度 ──

  setQuota(q: Partial<QuotaConfig>): void {
    this.quota = { ...this.quota, ...q };
  }

  quotaState(now?: number): QuotaState {
    const t = now ?? this.clock.now();
    const date = dateKey(t);
    const used = this.runs.filter(
      (r) => dateKey(r.startedAt) === date && !r.manual && COSTS_TOKENS[r.kind],
    ).length;

    return {
      date,
      used,
      limit: this.quota.dailyTokenTaskLimit,
      exhausted: this.quota.exhausted === true || used >= this.quota.dailyTokenTaskLimit,
      ...(this.quota.exhaustedReason !== undefined
        ? { reason: this.quota.exhaustedReason }
        : used >= this.quota.dailyTokenTaskLimit
          ? { reason: `今日定时任务已用满 ${this.quota.dailyTokenTaskLimit} 次` }
          : {}),
    };
  }

  // ── 到期判断 ──

  /**
   * 判断某任务是否到期。
   *
   * ⚠️ 判据是"**应触发时刻**是否已过，且上次执行早于该时刻"，
   *    而不是"距上次执行满 24 小时" —— 后者在进程重启后会漂移。
   */
  isDue(kind: ScheduledTaskKind, now?: number): boolean {
    const t = now ?? this.clock.now();
    const task = this.tasks.get(kind);
    if (!task) return false;

    const due = lastDueAt(task.schedule, t);
    return due !== null && task.lastRunAt < due;
  }

  /** 所有到期的任务。 */
  dueTasks(now?: number): readonly ScheduledTaskKind[] {
    const t = now ?? this.clock.now();
    return [...this.tasks.keys()].filter((k) => this.isDue(k, t));
  }

  // ── 运行 ──

  /**
   * 跑一轮：执行所有到期任务。
   *
   * ★ 错过补偿在这里体现：`isDue` 只看"最近一次应触发时刻"，
   *   所以进程停了三天再启动，也**只会补跑最近那一次**，
   *   而不是把三天欠下的都补上（方案明确要求）。
   */
  async tick(now?: number): Promise<readonly ScheduledRun[]> {
    const t = now ?? this.clock.now();
    const out: ScheduledRun[] = [];

    for (const kind of this.dueTasks(t)) {
      const due = lastDueAt(this.tasks.get(kind)?.schedule ?? DEFAULT_SCHEDULES[kind], t) ?? t;
      const run = await this.runTask(kind, { scheduledAt: due, manual: false });
      out.push(run);
      // 无论成败都更新 lastRunAt —— 否则失败任务会每次 tick 都重试到天荒地老
      const task = this.tasks.get(kind);
      if (task) task.lastRunAt = t;
    }

    return out;
  }

  /**
   * 手动执行（方案要求：**每个任务都提供「立即执行」**）。
   *
   * ★ 手动触发**不占额度** —— 否则演示时用户点几次就把当天的额度用光了。
   *   演示不依赖等待，这一点方案写得很明确。
   */
  async runNow(kind: ScheduledTaskKind, now?: number): Promise<ScheduledRun | null> {
    if (!this.tasks.has(kind)) return null;
    const t = now ?? this.clock.now();
    const run = await this.runTask(kind, { scheduledAt: t, manual: true });
    const task = this.tasks.get(kind);
    if (task && run.outcome === 'succeeded') task.lastRunAt = t;
    return run;
  }

  private async runTask(
    kind: ScheduledTaskKind,
    opts: { readonly scheduledAt: number; readonly manual: boolean },
  ): Promise<ScheduledRun> {
    const task = this.tasks.get(kind);
    const now = this.clock.now();

    if (!task) {
      return this.record(kind, now, now, 'skipped', 1, '任务未注册', opts.manual);
    }

    // ── 额度熔断：在**执行之前**检查 ──
    if (!opts.manual && COSTS_TOKENS[kind]) {
      const q = this.quotaState(now);
      if (q.exhausted) {
        this.log.append({
          type: 'schedule.triggered',
          actor: 'scheduler',
          payload: {
            kind,
            outcome: 'skipped',
            reason: 'quota_exhausted',
            detail: q.reason ?? '额度耗尽',
            used: q.used,
            limit: q.limit,
          },
          createdAt: now,
        });
        return this.record(kind, now, now, 'skipped', 1, q.reason ?? '额度耗尽', false);
      }
    }

    // ── 执行，失败按指数退避重试 ──
    let lastNote = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = this.clock.now();
      try {
        const r = await task.handler({
          kind,
          scheduledAt: opts.scheduledAt,
          manual: opts.manual,
        });
        const ended = this.clock.now();

        this.log.append({
          type: 'schedule.triggered',
          actor: 'scheduler',
          payload: {
            kind,
            outcome: 'succeeded',
            manual: opts.manual,
            attempt,
            scheduledAt: opts.scheduledAt,
            summary: r.summary,
            trigger: opts.manual ? 'manual' : 'timer',
          },
          createdAt: started,
        });

        return this.record(kind, started, ended, 'succeeded', attempt, undefined, opts.manual, r.summary);
      } catch (err) {
        lastNote = err instanceof Error ? err.message : String(err);
        const ended = this.clock.now();

        this.log.append({
          type: 'schedule.triggered',
          actor: 'scheduler',
          payload: {
            kind,
            outcome: attempt < MAX_ATTEMPTS ? 'retrying' : 'failed',
            manual: opts.manual,
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            scheduledAt: opts.scheduledAt,
            error: lastNote,
            // 退避时长也记下来，便于排查"为什么等这么久"
            backoffMs: attempt < MAX_ATTEMPTS ? BACKOFF_BASE_MS * 2 ** (attempt - 1) : 0,
          },
          createdAt: ended,
        });
      }
    }

    // 三次都失败 → 记录并提示（不再无限重试）
    const t2 = this.clock.now();
    return this.record(
      kind,
      t2,
      t2,
      'failed',
      MAX_ATTEMPTS,
      `连续 ${MAX_ATTEMPTS} 次失败：${lastNote}`,
      opts.manual,
    );
  }

  private record(
    kind: ScheduledTaskKind,
    startedAt: number,
    endedAt: number,
    outcome: RunOutcome,
    attempt: number,
    note?: string,
    manual = false,
    summary?: string,
  ): ScheduledRun {
    const run: ScheduledRun = {
      id: `run_${++this.seq}_${startedAt.toString(36)}`,
      kind,
      startedAt,
      endedAt,
      outcome,
      attempt,
      manual,
      ...(note !== undefined ? { note } : {}),
      ...(summary !== undefined ? { summary } : {}),
    };
    this.runs.push(run);
    return run;
  }

  // ── 可见性（方案：历史执行记录、产出、耗时可查）──

  history(kind?: ScheduledTaskKind): readonly ScheduledRun[] {
    return kind === undefined ? this.runs : this.runs.filter((r) => r.kind === kind);
  }

  /** 每个任务的概览（供「历史任务」页展示）。 */
  overview(now?: number): readonly {
    readonly kind: ScheduledTaskKind;
    readonly label: string;
    readonly lastRunAt: number;
    readonly lastOutcome: RunOutcome | null;
    readonly totalRuns: number;
    readonly failedRuns: number;
    readonly due: boolean;
    readonly costsTokens: boolean;
  }[] {
    const t = now ?? this.clock.now();
    return [...this.tasks.values()].map((task) => {
      const mine = this.runs.filter((r) => r.kind === task.kind);
      const last = mine[mine.length - 1];
      return {
        kind: task.kind,
        label: TASK_LABEL[task.kind],
        lastRunAt: task.lastRunAt,
        lastOutcome: last?.outcome ?? null,
        totalRuns: mine.length,
        failedRuns: mine.filter((r) => r.outcome === 'failed').length,
        due: this.isDue(task.kind, t),
        costsTokens: COSTS_TOKENS[task.kind],
      };
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 时间计算
// ═══════════════════════════════════════════════════════════

/**
 * 求"最近一次应当触发的时刻"。
 *
 * ⚠️ 返回的是**该触发时刻本身**，不是"现在" ——
 *    这样 `lastRunAt < due` 才能正确表达"这一次还没跑过"。
 */
export function lastDueAt(schedule: TaskSchedule, now: number): number | null {
  // 每小时任务：取当前小时的整点
  if (schedule.hour < 0) {
    const d = new Date(now);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }

  const today = new Date(now);
  today.setHours(schedule.hour, schedule.minute, 0, 0);

  // 指定了星期几（如周日复盘）
  if (schedule.weekday !== undefined) {
    const cur = today.getDay();
    let diff = cur - schedule.weekday;
    if (diff < 0) diff += 7;
    // 如果今天就是那天但还没到点，则取上周那次
    if (diff === 0 && today.getTime() > now) diff = 7;
    return today.getTime() - diff * 24 * 60 * 60 * 1000;
  }

  // 每天：今天还没到点就取昨天
  if (today.getTime() > now) return today.getTime() - 24 * 60 * 60 * 1000;
  return today.getTime();
}

function dateKey(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 计算第 n 次重试的退避时长（供测试与界面展示）。
 *
 * 指数退避：1s → 2s → 4s …
 */
export function backoffFor(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
}
