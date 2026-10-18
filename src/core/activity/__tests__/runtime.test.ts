/**
 * A10 接线测试
 *
 * ★ 这一层之前**完全没有测试能覆盖"接线"**：`ActivityObserver`、
 *   `buildTasks`、`Scheduler` 各自都有测试，但**没人把它们装上**。
 *   这里测的正是"装上之后，整条链路真的会动"。
 */
import { describe, expect, it } from 'vitest';

import { createActivityRuntime } from '../runtime.js';
import { ActivityObserver, SAMPLE_INTERVAL_MS, type ActivitySourcePort } from '../observe.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../../memory/store.js';

const T0 = 1_760_000_000_000;

function setup(opts?: { consent?: boolean; source?: ActivitySourcePort }) {
  const log = new EventLog('s_activity');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, 'local');
  const observer = new ActivityObserver(log, clock, 'local');
  if (opts?.consent === true) observer.grantConsent(T0);

  const runtime = createActivityRuntime({
    log,
    clock,
    store,
    userId: 'local',
    observer,
    sessionCount: () => 0,
    ...(opts?.source !== undefined ? { source: opts.source } : {}),
  });

  return { log, clock, observer, runtime };
}

/** 假数据源：固定返回一个应用 */
function fakeSource(app = 'VS Code'): ActivitySourcePort {
  return { sample: async () => ({ app, hadInput: true }) };
}

describe('★★ A10 接线：定时任务真的被注册了', () => {
  it('★ 四类任务全部注册（改造前一个都没注册）', () => {
    const { runtime } = setup();
    const overview = runtime.scheduler.overview();
    const kinds = overview.map((o) => o.kind).sort();
    expect(kinds).toEqual(['activityAggregate', 'dailyReflection', 'proactiveCheck', 'weeklyReview']);
  });

  it('★★ 到期后会真的执行（不再是空转）', async () => {
    const { runtime } = setup();
    // 时间推到第二天凌晨 —— 每日任务应当到期
    const later = T0 + 24 * 60 * 60 * 1000;
    const r = await runtime.tickOnce(later);
    expect(r.ran.length).toBeGreaterThan(0);
  });
});

describe('★★★ 采样：同意才采、按间隔采', () => {
  it('★★ 未同意 → 不记录（默认关闭，不能"帮你打开"）', async () => {
    const { runtime, observer } = setup({ consent: false, source: fakeSource() });
    const r = await runtime.tickOnce(T0);
    expect(r.sampled).toBe(false);
    expect(observer.rawRecords(T0)).toHaveLength(0);
  });

  it('★★ 已同意 → 记录一条（应用名来自数据源）', async () => {
    const { runtime, observer } = setup({ consent: true, source: fakeSource('VS Code') });
    const r = await runtime.tickOnce(T0);
    expect(r.sampled).toBe(true);
    const records = observer.rawRecords(T0);
    expect(records).toHaveLength(1);
    expect(records[0]?.app).toBe('VS Code');
  });

  it('★★ 未到 5 分钟 → 不重复采样（避免变成持续监听）', async () => {
    const { runtime, observer } = setup({ consent: true, source: fakeSource() });
    await runtime.tickOnce(T0);
    const second = await runtime.tickOnce(T0 + 60_000); // 只过了 1 分钟
    expect(second.sampled).toBe(false);
    expect(observer.rawRecords(T0 + 60_000)).toHaveLength(1);
  });

  it('★ 满 5 分钟后再次采样', async () => {
    const { runtime, observer } = setup({ consent: true, source: fakeSource() });
    await runtime.tickOnce(T0);
    const second = await runtime.tickOnce(T0 + SAMPLE_INTERVAL_MS);
    expect(second.sampled).toBe(true);
    expect(observer.rawRecords(T0 + SAMPLE_INTERVAL_MS)).toHaveLength(2);
  });

  it('★ 没有数据源 → 如实报"没有数据源"，不编造应用名', async () => {
    const { runtime, observer } = setup({ consent: true });
    const r = await runtime.tickOnce(T0);
    expect(r.sampled).toBe(false);
    expect(r.sampleReason).toContain('数据源');
    expect(observer.rawRecords(T0)).toHaveLength(0);
  });

  it('★ 数据源返回空（无前台窗口）→ 不记录', async () => {
    const source: ActivitySourcePort = { sample: async () => null };
    const { runtime, observer } = setup({ consent: true, source });
    const r = await runtime.tickOnce(T0);
    expect(r.sampled).toBe(false);
    expect(observer.rawRecords(T0)).toHaveLength(0);
  });
});

describe('★ 撤回同意后不再采集', () => {
  it('撤回 → 已采数据被清空，后续不采', async () => {
    const { runtime, observer, clock } = setup({ consent: true, source: fakeSource() });
    await runtime.tickOnce(T0);
    expect(observer.rawRecords(T0)).toHaveLength(1);

    observer.revokeConsent(T0 + 1000);
    expect(observer.rawRecords(T0 + 1000)).toHaveLength(0);

    const r = await runtime.tickOnce(T0 + SAMPLE_INTERVAL_MS);
    expect(r.sampled).toBe(false);
    void clock;
  });
});
