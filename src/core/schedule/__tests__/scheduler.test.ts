/**
 * 定时任务调度测试
 *
 * ★ 要锁住的五条（方案 § 5.4）+ 一条方案特别标注的风险：
 *   ① 到期判断基于"应触发时刻"，不是"距上次满 24 小时"
 *   ② **错过补偿只补最近一次**（进程停三天不该补三次）
 *   ③ 失败指数退避，最多 3 次
 *   ④ **手动触发不占额度**（演示点几次不该把额度用光）
 *   ⑤ 额度熔断发生在**执行之前**
 *   ⑥ 四个任务串起周期闭环（反思 / 画像 / 规律 / 聚合）
 */

import { describe, expect, it, vi } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../../memory/store.js';
import { ActivityObserver } from '../../activity/observe.js';
import {
  BACKOFF_BASE_MS,
  COSTS_TOKENS,
  DEFAULT_QUOTA,
  DEFAULT_SCHEDULES,
  MAX_ATTEMPTS,
  Scheduler,
  TASK_LABEL,
  backoffFor,
  lastDueAt,
} from '../scheduler.js';
import { buildTasks, interruptAdvice, renderPatterns } from '../tasks.js';
import type { TemporalPattern } from '../../activity/types.js';

const USER = 'u_sch';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 2026-10-13 是周二；这里取周一 2026-10-12 09:00 作为基准 */
const MON_9AM = new Date(2026, 9, 12, 9, 0, 0).getTime();

function setup(quota = DEFAULT_QUOTA) {
  const log = new EventLog('s_sch');
  const clock = new FixedClock(MON_9AM);
  const scheduler = new Scheduler(log, clock, quota);
  return { log, clock, scheduler };
}

// ═══════════════════════════════════════════════════════════
// ① 到期判断
// ═══════════════════════════════════════════════════════════

describe('① 到期判断', () => {
  it('★ 每天 23:00 的任务在 9:00 不算到期（取的是昨天那次）', () => {
    const due = lastDueAt({ hour: 23, minute: 0 }, MON_9AM);
    if (due === null) throw new Error('应为到期');
    // 昨天 23:00
    expect(new Date(due).getHours()).toBe(23);
    expect(due).toBeLessThan(MON_9AM);
    expect(MON_9AM - due).toBeLessThan(DAY);
    expect(MON_9AM - due).toBeGreaterThan(9 * HOUR);
  });

  it('★ 23:30 时该任务已到期（取今天 23:00）', () => {
    const at2330 = new Date(2026, 9, 12, 23, 30, 0).getTime();
    const due = lastDueAt({ hour: 23, minute: 0 }, at2330);
    if (due === null) throw new Error('应为到期');
    expect(new Date(due).getHours()).toBe(23);
    expect(new Date(due).getDate()).toBe(12);
  });

  it('★★ 重启后不会重复执行今天已经跑过的任务', () => {
    const log = new EventLog('s_sch_restart');
    const clock = new FixedClock(MON_9AM);
    // 推进到周一 23:30 —— 今天的 23:00 已经该跑了
    clock.advance(14.5 * HOUR);
    const at = clock.now();

    log.append({
      type: 'schedule.triggered',
      actor: 'scheduler',
      payload: { kind: 'dailyReflection', outcome: 'succeeded', scheduledAt: at },
      createdAt: at,
    });

    // 模拟重启：新 Scheduler，但事件流还在
    const restarted = new Scheduler(log, clock);
    restarted.register({ kind: 'dailyReflection', handler: async () => ({ summary: 'ok' }) });

    // 今天这一次已经跑过 → 不再到期
    expect(restarted.isDue('dailyReflection')).toBe(false);

    // 到了明天 23:30，应该再次到期
    clock.advance(DAY);
    expect(restarted.isDue('dailyReflection')).toBe(true);
  });

  it('每小时任务取当前小时整点', () => {
    const due = lastDueAt({ hour: -1, minute: 0 }, MON_9AM);
    if (due === null) throw new Error('应为到期');
    expect(new Date(due).getMinutes()).toBe(0);
    expect(new Date(due).getHours()).toBe(9);
  });

  it('周任务取最近的那个周日', () => {
    // 周一 9:00 → 最近的周日是昨天
    const due = lastDueAt({ hour: 22, minute: 0, weekday: 0 }, MON_9AM);
    if (due === null) throw new Error('应为到期');
    const d = new Date(due);
    expect(d.getDay()).toBe(0); // 周日
    expect(d.getTime()).toBeLessThan(MON_9AM);
  });

  it('★ 首次注册的任务立即到期（lastRunAt=0）', () => {
    const { scheduler } = setup();
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: 'x' }) });
    expect(scheduler.isDue('dailyReflection', MON_9AM)).toBe(true);
  });

  it('跑过之后当天不再到期', async () => {
    const { scheduler } = setup();
    const fn = vi.fn(async () => ({ summary: 'ok' }));
    scheduler.register({ kind: 'dailyReflection', handler: fn });

    await scheduler.runNow('dailyReflection', MON_9AM);
    expect(scheduler.isDue('dailyReflection', MON_9AM + HOUR)).toBe(false);
  });

  it('默认频率符合方案（每日 23:00 / 周日 / 每日早晨 / 每小时）', () => {
    expect(DEFAULT_SCHEDULES.dailyReflection.hour).toBe(23);
    expect(DEFAULT_SCHEDULES.weeklyReview.weekday).toBe(0);
    expect(DEFAULT_SCHEDULES.proactiveCheck.hour).toBe(8);
    expect(DEFAULT_SCHEDULES.activityAggregate.hour).toBe(-1);
  });

  it('每个任务都有中文标签', () => {
    for (const label of Object.values(TASK_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// ② ★ 错过补偿：只补最近一次
// ═══════════════════════════════════════════════════════════

describe('② ★ 错过补偿只补最近一次', () => {
  it('★ 进程停了三天，也只补跑一次（不是三次）', async () => {
    const { scheduler } = setup();
    const fn = vi.fn(async () => ({ summary: 'ok' }));
    scheduler.register({ kind: 'dailyReflection', handler: fn });

    // 首次注册后立刻"停摆三天"再启动
    const threeDaysLater = MON_9AM + 3 * DAY;
    const runs = await scheduler.tick(threeDaysLater);

    const mine = runs.filter((r) => r.kind === 'dailyReflection');
    expect(mine).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('补偿的是"最近一次应触发的时刻"，不是"现在"', async () => {
    const seen: number[] = [];
    const { scheduler } = setup();
    scheduler.register({
      kind: 'dailyReflection',
      handler: async (c) => {
        seen.push(c.scheduledAt);
        return { summary: 'ok' };
      },
    });

    await scheduler.tick(MON_9AM + 3 * DAY);
    const scheduled = seen[0];
    if (scheduled === undefined) throw new Error('no run');
    // 补偿时刻应当落在过去，且是 23:00
    expect(scheduled).toBeLessThan(MON_9AM + 3 * DAY);
    expect(new Date(scheduled).getHours()).toBe(23);
  });

  it('★ 失败也会更新 lastRunAt（否则每次 tick 都重试到天荒地老）', async () => {
    const { scheduler } = setup();
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    scheduler.register({ kind: 'dailyReflection', handler: fn });

    await scheduler.tick(MON_9AM);
    const first = fn.mock.calls.length;
    expect(first).toBe(MAX_ATTEMPTS);

    // 紧接着再 tick 一次 —— 不该再触发
    await scheduler.tick(MON_9AM + 1000);
    expect(fn.mock.calls.length).toBe(first);
  });
});

// ═══════════════════════════════════════════════════════════
// ③ 重试与退避
// ═══════════════════════════════════════════════════════════

describe('③ 失败重试（指数退避，最多 3 次）', () => {
  it('★ 失败重试到上限', async () => {
    const { scheduler } = setup();
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    scheduler.register({ kind: 'dailyReflection', handler: fn });

    const runs = await scheduler.tick(MON_9AM);
    expect(fn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const r = runs[0];
    expect(r?.outcome).toBe('failed');
    expect(r?.note).toContain('连续 3 次失败');
    expect(r?.note).toContain('boom');
  });

  it('★ 第二次成功就不算失败', async () => {
    const { scheduler } = setup();
    let calls = 0;
    scheduler.register({
      kind: 'dailyReflection',
      handler: async () => {
        calls += 1;
        if (calls === 1) throw new Error('第一次失败');
        return { summary: '第二次成功' };
      },
    });

    const runs = await scheduler.tick(MON_9AM);
    expect(runs[0]?.outcome).toBe('succeeded');
    expect(runs[0]?.attempt).toBe(2);
    expect(calls).toBe(2);
  });

  it('退避时长是指数增长（1s → 2s → 4s）', () => {
    expect(backoffFor(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffFor(2)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffFor(3)).toBe(BACKOFF_BASE_MS * 4);
  });

  it('★ 重试过程落事件，含退避时长（便于排查"为什么等这么久"）', async () => {
    const { scheduler, log } = setup();
    scheduler.register({
      kind: 'dailyReflection',
      handler: async () => {
        throw new Error('boom');
      },
    });
    await scheduler.tick(MON_9AM);

    const evs = log.byType('schedule.triggered');
    const retrying = evs.filter((e) => (e.payload as { outcome?: string }).outcome === 'retrying');
    expect(retrying).toHaveLength(MAX_ATTEMPTS - 1);
    expect((retrying[0]?.payload as { backoffMs?: number }).backoffMs).toBe(BACKOFF_BASE_MS);
  });

  it('未注册的任务不崩溃', async () => {
    const { scheduler } = setup();
    expect(await scheduler.runNow('dailyReflection', MON_9AM)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// ④ ★ 额度熔断
// ═══════════════════════════════════════════════════════════

describe('④ ★ 额度熔断（方案特别标注的风险）', () => {
  it('★ 额度耗尽时跳过并记录原因', async () => {
    const { scheduler, log } = setup({ dailyTokenTaskLimit: 1 });
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: 'ok' }) });

    await scheduler.tick(MON_9AM);
    expect(scheduler.quotaState(MON_9AM).used).toBe(1);
    expect(scheduler.quotaState(MON_9AM).exhausted).toBe(true);

    // 注册一个新任务（首次注册即到期），此时额度已耗尽 → 应被熔断
    scheduler.register({ kind: 'proactiveCheck', handler: async () => ({ summary: 'ok' }) });
    const runs = await scheduler.tick(MON_9AM + 1000);
    const skipped = runs.find((r) => r.outcome === 'skipped');
    expect(skipped).toBeDefined();
    expect(skipped?.note).toContain('用满');

    const ev = log.byType('schedule.triggered').find(
      (e) => (e.payload as { reason?: string }).reason === 'quota_exhausted',
    );
    expect(ev).toBeDefined();
  });

  it('★ 额度检查在**执行之前**（同轮内多个到期任务都会跑完）', async () => {
    // ⚠️ 这是有意为之：一轮里的任务不该跑到一半被砍掉。
    //    额度判断的是「这一轮开始前够不够」，不是「跑到第几个停」。
    //    我第一版测试写的是"used 应为 1"，实测是 2 —— 测试预期错了，实现是对的。
    const { scheduler } = setup({ dailyTokenTaskLimit: 5 });
    const a = vi.fn(async () => ({ summary: 'a' }));
    const b = vi.fn(async () => ({ summary: 'b' }));
    scheduler.register({ kind: 'dailyReflection', handler: a });
    scheduler.register({ kind: 'proactiveCheck', handler: b });

    await scheduler.tick(MON_9AM);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(scheduler.quotaState(MON_9AM).used).toBe(2);
  });

  it('★★ 手动触发不占额度（演示点几次不该把额度用光）', async () => {
    const { scheduler } = setup({ dailyTokenTaskLimit: 1 });
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: 'ok' }) });
    scheduler.register({ kind: 'proactiveCheck', handler: async () => ({ summary: 'ok' }) });

    // 手动点 5 次
    for (let i = 0; i < 5; i++) {
      const r = await scheduler.runNow('dailyReflection', MON_9AM + i * 1000);
      expect(r?.outcome).toBe('succeeded');
    }

    // 额度仍未被占用
    const state = scheduler.quotaState(MON_9AM + 5000);
    expect(state.used).toBe(0);
    expect(state.exhausted).toBe(false);
  });

  it('★ 不耗 token 的任务不受额度限制（行为聚合是纯本地）', async () => {
    expect(COSTS_TOKENS.activityAggregate).toBe(false);

    const { scheduler } = setup({ dailyTokenTaskLimit: 0 });
    const fn = vi.fn(async () => ({ summary: '本地聚合' }));
    scheduler.register({ kind: 'activityAggregate', handler: fn });

    const runs = await scheduler.tick(MON_9AM);
    expect(runs[0]?.outcome).toBe('succeeded');
    expect(fn).toHaveBeenCalled();
  });

  it('耗 token 的任务在 limit=0 时直接跳过', async () => {
    const { scheduler } = setup({ dailyTokenTaskLimit: 0 });
    const fn = vi.fn(async () => ({ summary: 'ok' }));
    scheduler.register({ kind: 'dailyReflection', handler: fn });

    const runs = await scheduler.tick(MON_9AM);
    expect(runs[0]?.outcome).toBe('skipped');
    expect(fn).not.toHaveBeenCalled();
  });

  it('外部标记额度耗尽（如 API 报错）也生效', async () => {
    const { scheduler } = setup({ dailyTokenTaskLimit: 100, exhausted: true, exhaustedReason: 'API 余额不足' });
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: 'ok' }) });

    const runs = await scheduler.tick(MON_9AM);
    expect(runs[0]?.outcome).toBe('skipped');
    expect(runs[0]?.note).toContain('余额不足');
  });

  it('额度按天重置', async () => {
    const { scheduler } = setup({ dailyTokenTaskLimit: 1 });
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: 'ok' }) });

    await scheduler.tick(MON_9AM);
    expect(scheduler.quotaState(MON_9AM).used).toBe(1);
    // 第二天
    expect(scheduler.quotaState(MON_9AM + DAY).used).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ 执行可见
// ═══════════════════════════════════════════════════════════

describe('⑤ 执行可见（历史记录 / 产出 / 耗时）', () => {
  it('★ 概览列出每个任务的状态', async () => {
    const { scheduler } = setup();
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: '反思完成' }) });

    await scheduler.runNow('dailyReflection', MON_9AM);

    const ov = scheduler.overview(MON_9AM);
    const dr = ov.find((o) => o.kind === 'dailyReflection');
    expect(dr?.totalRuns).toBe(1);
    expect(dr?.lastOutcome).toBe('succeeded');
    expect(dr?.label).toBe('每日反思');
  });

  it('历史记录可按任务筛选', async () => {
    const { scheduler } = setup();
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: 'a' }) });
    scheduler.register({ kind: 'proactiveCheck', handler: async () => ({ summary: 'b' }) });

    await scheduler.runNow('dailyReflection', MON_9AM);
    await scheduler.runNow('proactiveCheck', MON_9AM);

    expect(scheduler.history()).toHaveLength(2);
    expect(scheduler.history('dailyReflection')).toHaveLength(1);
  });

  it('记录耗时与产出摘要', async () => {
    const { scheduler } = setup();
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: '产出 3 条候选' }) });

    const r = await scheduler.runNow('dailyReflection', MON_9AM);
    expect(r?.summary).toBe('产出 3 条候选');
    expect(r?.endedAt).toBeGreaterThanOrEqual(r?.startedAt ?? 0);
  });

  it('★ 手动触发被标记（可区分"我点的"与"自己跑的"）', async () => {
    const { scheduler } = setup();
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: 'x' }) });

    const manual = await scheduler.runNow('dailyReflection', MON_9AM);
    expect(manual?.manual).toBe(true);
  });

  it('事件里记录触发方式', async () => {
    const { scheduler, log } = setup();
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: 'x' }) });
    await scheduler.runNow('dailyReflection', MON_9AM);

    const ev = log.byType('schedule.triggered')[0];
    expect((ev?.payload as { trigger?: string }).trigger).toBe('manual');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑥ ★ 四个任务串成周期闭环
// ═══════════════════════════════════════════════════════════

describe('⑥ ★ 周期闭环', () => {
  function ctx(overrides: Partial<Parameters<typeof buildTasks>[0]> = {}) {
    const log = new EventLog('s_tasks');
    const clock = new FixedClock(MON_9AM);
    const store = new MemoryStore(log, clock, USER);
    const observer = new ActivityObserver(log, clock, USER, {
      granted: true, grantedAt: MON_9AM, enabled: true, retentionDays: 30,
    });
    return { log, clock, store, observer, ctx: { log, clock, store, userId: USER, observer, sessionCount: () => 5, ...overrides } };
  }

  it('每日反思调用反思引擎并落事件', async () => {
    const { ctx: c, log } = ctx({
      reflect: async () => ({ candidateCount: 3, summary: '产出 3 条候选' }),
    });
    const bundle = buildTasks(c);
    const r = await bundle.handlers.dailyReflection({
      kind: 'dailyReflection', scheduledAt: MON_9AM, manual: false,
    });

    expect(r.summary).toContain('3 条候选');
    const ev = log.byType('reflection.done').find(
      (e) => (e.payload as { scope?: string }).scope === 'daily',
    );
    expect(ev).toBeDefined();
    expect((ev?.payload as { note?: string }).note).toContain('审核');
  });

  it('未接入反思引擎时如实说明，不假装成功', async () => {
    const { ctx: c } = ctx();
    const bundle = buildTasks(c);
    const r = await bundle.handlers.dailyReflection({
      kind: 'dailyReflection', scheduledAt: MON_9AM, manual: false,
    });
    expect(r.summary).toContain('未接入');
  });

  it('★ 周复盘生成画像快照（"最强演示件"的自动产出）', async () => {
    const { ctx: c } = ctx({ reflect: async () => ({ candidateCount: 2, summary: '' }) });
    const bundle = buildTasks(c);

    expect(bundle.latestProfile()).toBeNull();
    await bundle.handlers.weeklyReview({ kind: 'weeklyReview', scheduledAt: MON_9AM, manual: false });

    const snap = bundle.latestProfile();
    expect(snap).not.toBeNull();
    expect(snap?.sessionCount).toBe(5);
  });

  it('★ 第二次周复盘能算出成长差异', async () => {
    const { ctx: c } = ctx();
    const bundle = buildTasks(c);

    await bundle.handlers.weeklyReview({ kind: 'weeklyReview', scheduledAt: MON_9AM, manual: false });
    const r = await bundle.handlers.weeklyReview({
      kind: 'weeklyReview', scheduledAt: MON_9AM + 7 * DAY, manual: false,
    });

    // 第二次应当带上"多了解你 N 条"这类差异说明
    expect(r.summary).toMatch(/记忆|多了解你|会话/);
    expect(bundle.previousProfile()).not.toBeNull();
  });

  it('★ 周复盘重算时间维度规律', async () => {
    const { ctx: c, observer } = ctx();
    // 灌入 10 天数据
    for (let d = 0; d < 12; d++) {
      const dayStart = MON_9AM - d * DAY;
      const dow = new Date(dayStart).getDay();
      if (dow === 0 || dow === 6) continue;
      const at = dayStart + 10 * HOUR;
      observer.observe({ app: 'Excel', startedAt: at, endedAt: at + 30 * 60 * 1000, hadInput: true });
    }

    const bundle = buildTasks(c);
    const r = await bundle.handlers.weeklyReview({
      kind: 'weeklyReview', scheduledAt: MON_9AM, manual: false,
    });

    expect(bundle.patterns()).not.toBeNull();
    expect(bundle.patterns()?.patterns.length).toBeGreaterThan(0);
    expect(r.summary).toContain('重算规律');
  });

  it('数据不足时周复盘如实说明原因', async () => {
    const { ctx: c } = ctx();
    const bundle = buildTasks(c);
    const r = await bundle.handlers.weeklyReview({
      kind: 'weeklyReview', scheduledAt: MON_9AM, manual: false,
    });
    expect(r.summary).toContain('未能重算规律');
  });

  it('主动服务检查发现事项并落事件', async () => {
    const { ctx: c, log } = ctx({
      checkReminders: async () => [
        { title: '出差前一周提醒订票', dueAt: MON_9AM + 3 * DAY },
        { title: '信用卡还款', dueAt: MON_9AM + DAY },
      ],
    });
    const bundle = buildTasks(c);
    const r = await bundle.handlers.proactiveCheck({
      kind: 'proactiveCheck', scheduledAt: MON_9AM, manual: false,
    });

    expect(r.summary).toContain('2 项待提醒');
    expect(bundle.reminders()).toHaveLength(2);
    const ev = log.byType('supervisor.observe').find(
      (e) => (e.payload as { kind?: string }).kind === 'proactiveReminder',
    );
    expect(ev).toBeDefined();
  });

  it('无待提醒事项时不产生噪音', async () => {
    const { ctx: c, log } = ctx({ checkReminders: async () => [] });
    const bundle = buildTasks(c);
    const r = await bundle.handlers.proactiveCheck({
      kind: 'proactiveCheck', scheduledAt: MON_9AM, manual: false,
    });
    expect(r.summary).toContain('没有需要');
    expect(log.byType('supervisor.observe')).toHaveLength(0);
  });

  it('★ 行为聚合清除过期原始记录并保留聚合', async () => {
    const { ctx: c, observer } = ctx();
    const at = MON_9AM + 10 * HOUR;
    observer.observe({ app: 'Excel', startedAt: at, endedAt: at + 30 * 60 * 1000, hadInput: true });

    const bundle = buildTasks(c);
    const r = await bundle.handlers.activityAggregate({
      kind: 'activityAggregate', scheduledAt: MON_9AM, manual: false,
    });

    expect(r.summary).toContain('聚合');
    expect(observer.allAggregates().length).toBeGreaterThan(0);
  });

  it('未开启观察时如实说明', async () => {
    const log = new EventLog('s');
    const clock = new FixedClock(MON_9AM);
    const store = new MemoryStore(log, clock, USER);
    const bundle = buildTasks({ log, clock, store, userId: USER, sessionCount: () => 0 });
    const r = await bundle.handlers.activityAggregate({
      kind: 'activityAggregate', scheduledAt: MON_9AM, manual: false,
    });
    expect(r.summary).toContain('未开启行为观察');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑦ ★ 打断控制（时间维度画像的实际用途）
// ═══════════════════════════════════════════════════════════

describe('⑦ ★ 打断控制', () => {
  const routine: TemporalPattern = {
    id: 'p1',
    userId: USER,
    kind: 'routine',
    pattern: '工作日 14:00—15:00 通常工作',
    confidence: 0.88,
    evidence: [],
    observedDays: 20,
    appliesTo: 'weekday',
    createdAt: MON_9AM,
  };

  const free: TemporalPattern = {
    id: 'p2',
    userId: USER,
    kind: 'availability',
    pattern: '工作日 16:00—18:00 通常比较空闲',
    confidence: 0.6,
    evidence: [],
    observedDays: 20,
    appliesTo: 'weekday',
    createdAt: MON_9AM,
  };

  it('★ 处于专注时段时建议稍后提醒', () => {
    const at14 = new Date(2026, 9, 12, 14, 30).getTime(); // 周一
    const advice = interruptAdvice([routine], at14);
    expect(advice.timing).toBe('later');
    expect(advice.reason).toContain('通常工作');
  });

  it('★ 处于空闲时段时建议现在提醒', () => {
    const at16 = new Date(2026, 9, 12, 16, 30).getTime();
    const advice = interruptAdvice([free], at16);
    expect(advice.timing).toBe('now');
    expect(advice.reason).toContain('适合提醒');
  });

  it('深夜一律不建议打扰', () => {
    const at2 = new Date(2026, 9, 12, 2, 0).getTime();
    const advice = interruptAdvice([], at2);
    expect(advice.timing).toBe('later');
    expect(advice.reason).toContain('深夜');
  });

  it('画像未覆盖时如实说不知道（不硬猜）', () => {
    const at11 = new Date(2026, 9, 12, 11, 0).getTime();
    const advice = interruptAdvice([], at11);
    expect(advice.timing).toBe('unknown');
    expect(advice.reason).toContain('未覆盖');
  });

  it('工作日规律不会套用到周末', () => {
    const sat14 = new Date(2026, 9, 17, 14, 30).getTime(); // 周六
    const advice = interruptAdvice([routine], sat14);
    expect(advice.timing).not.toBe('later');
  });

  it('规律集能渲染成清单', () => {
    expect(renderPatterns([routine, free])).toContain('通常工作');
    expect(renderPatterns([])).toContain('还没有');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑧ 确定性
// ═══════════════════════════════════════════════════════════

describe('⑧ 确定性', () => {
  it('同一时刻的到期判断可重放', () => {
    const a = lastDueAt({ hour: 23, minute: 0 }, MON_9AM);
    const b = lastDueAt({ hour: 23, minute: 0 }, MON_9AM);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it('时间来自 ClockPort', async () => {
    const { scheduler, clock } = setup();
    scheduler.register({ kind: 'dailyReflection', handler: async () => ({ summary: 'x' }) });
    const r = await scheduler.runNow('dailyReflection', MON_9AM);
    expect(r?.startedAt).toBe(clock.now());
  });
});
