/**
 * 行为采集与周期总结的接线（A10 · 方案 §7 / §5.4）
 *
 * ★★ 这个模块补的是一个**整个能力空转**的缺口。核查代码得到的事实：
 *
 *   | 模块 | 改造前 |
 *   |---|---|
 *   | `Scheduler.register` | **生产代码 0 调用** —— 没有任何任务被注册 |
 *   | `buildTasks`（每日反思 / 周复盘 / 时间规律）| **0 生产调用方** |
 *   | `ActivityObserver` | **从未实例化** |
 *   | `ActivitySourcePort` | **无实现** |
 *
 *   也就是说：定时任务与行为观察**在运行时完全是空的**。
 *   能力都写好了、有测试，但没人把它们装上。
 *
 * ★ 两条设计约束（都来自现有代码的形状，不是我另定的）：
 *
 *   ① **采样不由调度器驱动**
 *      `TaskSchedule` 只有 `{ hour, minute }`，表达不了"每 5 分钟"。
 *      所以采样用 `shouldSampleNow()` 自己判间隔 ——
 *      这正是它存在的原因（注释写着"避免变成持续监听"）。
 *
 *   ② **tick 不做定时器**
 *      定时器在 Next.js 里会随热重载重复注册、也无法在测试里控制。
 *      所以这里只提供**可显式调用的 `tickOnce(now)`**，
 *      定时循环交给调用方（运行时用 `setInterval`，测试直接调）。
 */

import type { ActivityObserver, ActivitySourcePort } from './observe.js';
import type { ClockPort } from '../ports/clock.js';
import type { EventLog } from '../events/log.js';
import type { MemoryStore } from '../memory/store.js';
import { Scheduler, type ScheduledRun } from '../schedule/scheduler.js';
import { buildTasks, type TaskBundle } from '../schedule/tasks.js';

export interface ActivityRuntimeArgs {
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly store: MemoryStore;
  readonly userId: string;
  /** 已按用户同意初始化的观察器；未同意时**不要**传（或传 consented=false 的实例）*/
  readonly observer: ActivityObserver;
  /**
   * 前台采样数据源。
   *
   * ⚠️ 可选：拿不到数据源时采样返回 null（如实记"无前台窗口"），
   *    而不是编一个假的应用名 —— 编数据比没有数据糟得多。
   */
  readonly source?: ActivitySourcePort;
  /** 当前会话数（画像快照要用）*/
  readonly sessionCount: () => number;
  /** 反思（需要模型；不接也能跑聚合）*/
  readonly reflect?: (args: { readonly scope: 'daily' | 'weekly' }) => Promise<{
    readonly candidateCount: number;
    readonly summary: string;
  }>;
  readonly checkReminders?: () => Promise<readonly { readonly title: string; readonly dueAt: number }[]>;
}

export interface ActivityRuntime {
  readonly scheduler: Scheduler;
  readonly tasks: TaskBundle;
  /**
   * 跑一次：先看要不要采样，再跑到期任务。
   *
   * ★ 这是**可测的单元**（不带定时器）。返回值用于诊断与测试。
   */
  tickOnce(now?: number): Promise<{
    readonly sampled: boolean;
    readonly sampleReason?: string;
    readonly ran: readonly ScheduledRun[];
  }>;
}

/** 注册全部定时任务，并给出一个可显式调用的 tick。 */
export function createActivityRuntime(args: ActivityRuntimeArgs): ActivityRuntime {
  const scheduler = new Scheduler(args.log, args.clock);

  const tasks = buildTasks({
    log: args.log,
    clock: args.clock,
    store: args.store,
    userId: args.userId,
    observer: args.observer,
    sessionCount: args.sessionCount,
    ...(args.reflect !== undefined ? { reflect: args.reflect } : {}),
    ...(args.checkReminders !== undefined ? { checkReminders: args.checkReminders } : {}),
  });

  // ★ 注册全部任务（改造前这里一次都没被调用过）
  for (const [kind, handler] of Object.entries(tasks.handlers)) {
    scheduler.register({ kind: kind as Parameters<typeof scheduler.register>[0]['kind'], handler });
  }

  return {
    scheduler,
    tasks,
    async tickOnce(now) {
      const t = now ?? args.clock.now();

      // ① 采样（自己判间隔，不走调度器）
      let sampled = false;
      let sampleReason: string | undefined;
      if (args.source !== undefined) {
        const r = await args.observer.sampleOnce(args.source, t);
        sampled = r.recorded;
        if (!r.recorded) sampleReason = r.reason;
      } else {
        sampleReason = '没有前台采样数据源';
      }

      // ② 跑到期任务
      const ran = await scheduler.tick(t);
      return {
        sampled,
        ...(sampleReason !== undefined ? { sampleReason } : {}),
        ran,
      };
    },
  };
}

/**
 * 启动定时循环。
 *
 * ⚠️ 三条注意（Next.js 下踩过才知道）：
 *   ① 用 `globalThis` 做单例，否则**热重载会重复注册**，任务跑两遍
 *   ② `unref()` 让定时器不阻止进程退出（否则测试/CLI 会挂住）
 *   ③ 回调里必须**吞掉异常** —— 定时器抛错会变成未捕获异常，直接崩进程
 */
export interface StartLoopOptions {
  readonly runtime: ActivityRuntime;
  /** 多久检查一次（毫秒）。默认 60 秒 —— 采样间隔是 5 分钟，1 分钟粒度足够 */
  readonly intervalMs?: number;
  readonly onError?: (err: unknown) => void;
}

const LOOP_KEY = '__butlerActivityLoop';

export function startActivityLoop(opts: StartLoopOptions): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 60_000;

  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[LOOP_KEY];
  if (existing !== undefined && typeof existing === 'object' && existing !== null) {
    // 已经起过 —— 直接复用，避免热重载重复注册
    const handle = existing as { stop(): void };
    return handle;
  }

  const timer = setInterval(() => {
    void opts.runtime
      .tickOnce()
      .catch((err: unknown) => {
        opts.onError?.(err);
      });
  }, intervalMs);
  // ★ 不阻止进程退出
  timer.unref?.();

  const handle = {
    stop(): void {
      clearInterval(timer);
      delete g[LOOP_KEY];
    },
  };
  g[LOOP_KEY] = handle;
  return handle;
}
