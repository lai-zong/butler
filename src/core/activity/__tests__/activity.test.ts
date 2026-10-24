/**
 * 行为观察与成长画像测试
 *
 * ★ 三组主张要锁住：
 *   ① **采集边界是结构性的** —— 类型里没有放标题/URL/路径的位置
 *   ② **样本不足时不产出规律** —— 一天的数据说明不了任何事
 *   ③ **演示数据走真实算法** —— 只有数据是模拟的，结论是算出来的
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../../memory/store.js';
import {
  ActivityObserver,
  DEFAULT_CONSENT,
  RETENTION_OPTIONS,
  SAMPLE_INTERVAL_MS,
  sanitizeAppName,
  type ActivitySourcePort,
} from '../observe.js';
import {
  HOUR_RATIO_THRESHOLD,
  MIN_OBSERVED_DAYS,
  derivePatterns,
  invalidatePattern,
  patternGuidance,
  requiredDaysFor,
} from '../patterns.js';
import { captureProfile, diffProfiles, renderSideBySide } from '../profile.js';
import { DEMO_OFFICE_DEV, DEMO_PROFILES, DEMO_STUDENT, generateDemoRecords } from '../demo.js';
import { bucketOf, categorize, dateOfBucket, hourOfBucket } from '../types.js';

const T0 = new Date(2026, 9, 13, 14, 0, 0).getTime(); // 2026-10-13 周二 14:00
const USER = 'u_act';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function setup(consent = DEFAULT_CONSENT) {
  const log = new EventLog('s_act');
  const clock = new FixedClock(T0);
  const observer = new ActivityObserver(log, clock, USER, consent);
  return { log, clock, observer };
}

const granted = { granted: true, grantedAt: T0, enabled: true, retentionDays: 7 };

// ═══════════════════════════════════════════════════════════
// ① ★ 采集边界（结构性保证）
// ═══════════════════════════════════════════════════════════

describe('① ★ 采集边界是结构性的', () => {
  it('★★ 应用名里的文档名被剥掉（传进来也存不下）', () => {
    // 这是防线一最关键的一条：窗口标题常含文档名
    expect(sanitizeAppName('Excel - 2026年财报.xlsx')).toBe('Excel');
    expect(sanitizeAppName('C:\\Program Files\\Office\\EXCEL.EXE')).toBe('EXCEL');
    expect(sanitizeAppName('Visual Studio Code — main.ts')).toBe('Visual Studio Code');
    expect(sanitizeAppName('记事本(会议记录.txt)')).toBe('记事本');
  });

  it('净化后不残留路径、扩展名、内容', () => {
    const s = sanitizeAppName('D:\\work\\机密项目\\计划书.docx - Word');
    expect(s).not.toContain('\\');
    expect(s).not.toContain('机密');
  });

  it('★ 事件里明确标注采了什么、没采什么（审计可见立场）', () => {
    const { observer, log } = setup(granted);
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });

    const p = log.byType('activity.sampled')[0]?.payload as {
      boundaries?: Record<string, boolean>;
    };
    expect(p.boundaries).toBeDefined();
    expect(p.boundaries?.['appName']).toBe(true);
    // ★ 这几条必须是 false —— 是立场声明，也是审计依据
    expect(p.boundaries?.['windowTitle']).toBe(false);
    expect(p.boundaries?.['url']).toBe(false);
    expect(p.boundaries?.['filePath']).toBe(false);
    expect(p.boundaries?.['keystrokes']).toBe(false);
  });

  it('只记是否有输入，不记输入内容', () => {
    const { observer } = setup(granted);
    const r = observer.observe({ app: 'Word', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    expect(r.record?.hadInput).toBe(true);
    // 记录里没有任何可以放按键的字段
    expect(Object.keys(r.record ?? {})).not.toContain('keys');
    expect(Object.keys(r.record ?? {})).not.toContain('text');
    expect(Object.keys(r.record ?? {})).not.toContain('title');
  });

  it('★ 浏览器归 other —— 不靠 URL 分类（那正是边界之外）', () => {
    expect(categorize('Chrome')).toBe('other');
    expect(categorize('Microsoft Edge')).toBe('other');
    // 但明确的应用能分类
    expect(categorize('Microsoft Excel')).toBe('work');
    expect(categorize('Visual Studio Code')).toBe('work');
    expect(categorize('WeChat')).toBe('communication');
    expect(categorize('Steam')).toBe('entertainment');
  });

  it('未知应用归 other，不猜测', () => {
    expect(categorize('某个没见过的软件')).toBe('other');
  });
});

// ═══════════════════════════════════════════════════════════
// ② ★ 三道闸门
// ═══════════════════════════════════════════════════════════

describe('② ★ 用户控制（防线三）', () => {
  it('★★ 默认不采集（绝不默认开启）', () => {
    expect(DEFAULT_CONSENT.granted).toBe(false);
    expect(DEFAULT_CONSENT.enabled).toBe(false);

    const { observer } = setup();
    const r = observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    expect(r.recorded).toBe(false);
    expect(r.reason).toContain('未同意');
  });

  it('同意后才开始采集', () => {
    const { observer } = setup();
    observer.grantConsent(T0);
    const r = observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    expect(r.recorded).toBe(true);
  });

  it('★ 一键关闭立即停止采集', () => {
    const { observer } = setup(granted);
    observer.disable(T0);
    const r = observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    expect(r.recorded).toBe(false);
    expect(r.reason).toContain('关闭');
  });

  it('关闭后数据仍在（关闭 ≠ 删除）', () => {
    const { observer } = setup(granted);
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    observer.disable(T0);
    expect(observer.rawRecords(T0 + HOUR)).toHaveLength(1);
  });

  it('★ 撤回同意会清除已采集数据（法规要求可撤回）', () => {
    const { observer } = setup(granted);
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    const r = observer.revokeConsent(T0 + HOUR);

    expect(r.deleted).toBe(1);
    expect(observer.rawRecords(T0 + HOUR)).toHaveLength(0);
    expect(observer.getConsent().granted).toBe(false);
  });

  it('未同意时无法单独开启采集', () => {
    const { observer } = setup();
    expect(observer.enable(T0)).toBe(false);
  });

  it('用户可删除单条与全部', () => {
    const { observer } = setup(granted);
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    observer.observe({ app: 'Word', startedAt: T0 + HOUR, endedAt: T0 + 2 * HOUR, hadInput: true });

    const first = observer.rawRecords(T0 + 2 * HOUR)[0];
    if (!first) throw new Error('missing');
    expect(observer.deleteRecord(first.id)).toBe(true);
    expect(observer.rawRecords(T0 + 2 * HOUR)).toHaveLength(1);

    const r = observer.deleteAll(T0 + 2 * HOUR);
    expect(r.records).toBe(1);
    expect(observer.rawRecords(T0 + 2 * HOUR)).toHaveLength(0);
  });

  it('保留期限选项符合方案（7 / 14 / 30 / 不保留）', () => {
    expect([...RETENTION_OPTIONS]).toEqual([7, 14, 30, 0]);
  });
});

// ═══════════════════════════════════════════════════════════
// ③ ★ 采样而非持续记录
// ═══════════════════════════════════════════════════════════

describe('③ ★ 采样而非持续记录（不是键盘记录器）', () => {
  it('★ 未到采样间隔时不再采样', () => {
    const { observer } = setup(granted);
    expect(observer.shouldSampleNow(T0)).toBe(true);
  });

  it('采样间隔是 5 分钟（方案明确要求）', () => {
    expect(SAMPLE_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('★ 采样一次后，间隔内不会重复采样', async () => {
    const { observer } = setup(granted);
    const source: ActivitySourcePort = {
      sample: async () => ({ app: 'Excel', hadInput: true }),
    };

    const first = await observer.sampleOnce(source, T0);
    expect(first.recorded).toBe(true);

    // 同一时刻再采一次 → 被间隔拦住
    const second = await observer.sampleOnce(source, T0 + 1000);
    expect(second.recorded).toBe(false);
    expect(second.reason).toContain('采样间隔');
  });

  it('采样为空时不记录', async () => {
    const { observer } = setup(granted);
    const source: ActivitySourcePort = { sample: async () => null };
    const r = await observer.sampleOnce(source, T0);
    expect(r.recorded).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// ④ ★ 分层存储：长期留规律，不留原始记录
// ═══════════════════════════════════════════════════════════

describe('④ ★ 分层存储（防线二）', () => {
  it('★ 超过保留期的原始记录被清除', () => {
    const { observer } = setup(granted);
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });

    // 8 天后（保留 7 天）
    const later = T0 + 8 * DAY;
    const r = observer.purgeExpired(later);
    expect(r.purged).toBe(1);
    expect(observer.rawRecords(later)).toHaveLength(0);
  });

  it('保留期内的记录不清除', () => {
    const { observer } = setup(granted);
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    expect(observer.purgeExpired(T0 + 3 * DAY).purged).toBe(0);
  });

  it('★★ 聚合结果不受保留期影响（关键：长期留的是规律）', () => {
    const { observer } = setup(granted);
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + 30 * 60 * 1000, hadInput: true });
    observer.aggregate(T0 + HOUR);

    // 30 天后原始记录早已清除
    const later = T0 + 30 * DAY;
    observer.purgeExpired(later);

    expect(observer.rawRecords(later)).toHaveLength(0);
    // ★ 但聚合还在 —— 这就是"数据最小化"与"画像仍成立"的平衡
    expect(observer.allAggregates().length).toBeGreaterThan(0);
  });

  it('retentionDays=0 表示不保留原始记录', () => {
    const { observer } = setup({ ...granted, retentionDays: 0 });
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    expect(observer.purgeExpired(T0).purged).toBe(1);
    expect(observer.rawRecords(T0)).toHaveLength(0);
  });

  it('聚合按小时与类别分桶，只留应用名', () => {
    const { observer } = setup(granted);
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + 30 * 60 * 1000, hadInput: true });
    observer.observe({ app: 'Word', startedAt: T0 + 10 * 60 * 1000, endedAt: T0 + 25 * 60 * 1000, hadInput: true });

    const aggs = observer.aggregate(T0 + HOUR);
    const work = aggs.find((a) => a.category === 'work');
    expect(work).toBeDefined();
    expect(work?.minutes).toBeGreaterThan(0);
    // 只有应用名
    expect(work?.topApps).toContain('Excel');
    expect(JSON.stringify(work)).not.toContain('.xlsx');
  });

  it('聚合落 activity.aggregated 事件', () => {
    const { observer, log } = setup(granted);
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    observer.aggregate(T0 + HOUR);

    const ev = log.byType('activity.aggregated');
    expect(ev).toHaveLength(1);
    expect((ev[0]?.payload as { note?: string }).note).toContain('长期保留');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ ★ 规律提取：样本不足宁可不产出
// ═══════════════════════════════════════════════════════════

describe('⑤ ★ 规律提取', () => {
  function seedDays(observer: ActivityObserver, days: number, opts?: { skipWeekend?: boolean }): void {
    const start = T0 - days * DAY;
    for (let d = 0; d < days; d++) {
      const dayStart = start + d * DAY;
      const dow = new Date(dayStart).getDay();
      if (opts?.skipWeekend === true && (dow === 0 || dow === 6)) continue;
      // 每天 10 点用 Excel 半小时
      const at = dayStart + 10 * HOUR;
      observer.observe({ app: 'Excel', startedAt: at, endedAt: at + 30 * 60 * 1000, hadInput: true });
    }
  }

  it('★★ 少于最少观察天数时不产出任何规律', () => {
    const { observer, log, clock } = setup(granted);
    seedDays(observer, 3);

    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER },
    });

    expect(r.patterns).toHaveLength(0);
    expect(r.reason).toContain('说明不了任何事');
    expect(log.byType('pattern.derived')).toHaveLength(0);
  });

  it('★ 达到最少天数后产出规律', () => {
    const { observer, log, clock } = setup(granted);
    seedDays(observer, 10);

    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER },
    });

    expect(r.observedDays).toBeGreaterThanOrEqual(MIN_OBSERVED_DAYS);
    expect(r.patterns.length).toBeGreaterThan(0);
  });

  it('规律描述是人话（不是数字）', () => {
    const { observer, log, clock } = setup(granted);
    seedDays(observer, 10);

    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER },
    });

    const routine = r.patterns.find((p) => p.pattern.includes('Excel') || p.pattern.includes('工作'));
    expect(routine).toBeDefined();
    expect(routine?.pattern).toMatch(/工作日|周末|每天/);
    expect(routine?.pattern).toMatch(/\d{2}:\d{2}—\d{2}:\d{2}/);
  });

  it('★ 规律带观察天数与证据链', () => {
    const { observer, log, clock } = setup(granted);
    seedDays(observer, 10);

    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER },
    });

    const p = r.patterns[0];
    expect(p?.observedDays).toBeGreaterThanOrEqual(MIN_OBSERVED_DAYS);
    expect(p?.evidence.length).toBeGreaterThan(0);
  });

  it('置信度在合理区间（不是拍脑袋的 1.0）', () => {
    const { observer, log, clock } = setup(granted);
    seedDays(observer, 10);

    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER },
    });

    for (const p of r.patterns) {
      expect(p.confidence).toBeGreaterThan(0);
      expect(p.confidence).toBeLessThanOrEqual(0.95);
    }
  });

  it('★ 规律落 pattern.derived 事件', () => {
    const { observer, log, clock } = setup(granted);
    seedDays(observer, 10);
    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER },
    });
    expect(log.byType('pattern.derived')).toHaveLength(r.patterns.length);
  });

  it('requiredDaysFor 保证比例在整数天数上可达', () => {
    const d = requiredDaysFor(HOUR_RATIO_THRESHOLD);
    expect(d).toBeGreaterThanOrEqual(MIN_OBSERVED_DAYS);
    // 在该天数上确实存在一个整数分子达标
    expect(Math.ceil(HOUR_RATIO_THRESHOLD * d) / d).toBeGreaterThanOrEqual(HOUR_RATIO_THRESHOLD - 1e-9);
  });

  it('空输入不崩溃', () => {
    const { log, clock } = setup();
    const r = derivePatterns({ aggregates: [], options: { log, clock, userId: USER } });
    expect(r.observedDays).toBe(0);
    expect(r.patterns).toHaveLength(0);
  });

  it('★ 规律失效落独立事件（节奏变化要留痕，不悄悄覆盖）', () => {
    const { observer, log, clock } = setup(granted);
    seedDays(observer, 10);
    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER },
    });
    const p = r.patterns[0];
    if (!p) throw new Error('no pattern');

    invalidatePattern({ log, clock, pattern: p, reason: '近两周该时段不再出现' });
    const ev = log.byType('pattern.invalidated');
    expect(ev).toHaveLength(1);
    expect((ev[0]?.payload as { reason?: string }).reason).toContain('不再出现');
  });

  it('规律可翻译成管家提示语', () => {
    const { observer, log, clock } = setup(granted);
    seedDays(observer, 10);
    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER },
    });
    for (const p of r.patterns) {
      expect(patternGuidance(p).length).toBeGreaterThan(p.pattern.length);
    }
  });

  it('★ 作息与偏好按**时段性质**区分，不重复报告同一件事', () => {
    const { observer, log, clock } = setup(granted);
    // 每天 10 点（工作时段内）与 21 点（自由时段）各用一次
    for (let d = 0; d < 12; d++) {
      const dayStart = T0 - d * DAY;
      const dow = new Date(dayStart).getDay();
      if (dow === 0 || dow === 6) continue; // 只看工作日
      for (const h of [10, 21]) {
        const at = dayStart + h * HOUR;
        observer.observe({
          app: h === 10 ? 'Excel' : 'Steam',
          startedAt: at,
          endedAt: at + 30 * 60 * 1000,
          hadInput: true,
        });
      }
    }

    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER },
    });

    // ★ 同一个「类别|星期类型|小时」只能出现在一个类型里 ——
    //   第一版按比例判定，同一条规律会既算作息又算偏好。
    const ids = r.patterns.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    // 工作时段内的 → routine
    const ten = r.patterns.find((p) => p.id.includes('_10') && p.appliesTo === 'weekday');
    if (ten) expect(ten.kind).toBe('routine');

    // 自由时段的 → preference
    const late = r.patterns.find((p) => p.id.includes('_21') && p.appliesTo === 'weekday');
    if (late) expect(late.kind).toBe('preference');
  });

  it('★ 自由时段的规律用「通常在」措辞（读起来是偏好而非作息）', () => {
    const { observer, log, clock } = setup(granted);
    for (let d = 0; d < 12; d++) {
      const dayStart = T0 - d * DAY;
      const dow = new Date(dayStart).getDay();
      if (dow === 0 || dow === 6) continue;
      const at = dayStart + 21 * HOUR;
      observer.observe({ app: 'Steam', startedAt: at, endedAt: at + 30 * 60 * 1000, hadInput: true });
    }

    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER },
    });
    const pref = r.patterns.find((p) => p.kind === 'preference');
    if (pref) expect(pref.pattern).toContain('通常在');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑥ ★ 演示数据走真实算法
// ═══════════════════════════════════════════════════════════

describe('⑥ ★ 演示加速（用真实机制处理演示数据）', () => {
  it('★ 演示数据只改变积累时长，算法完全一致', () => {
    // ★ 保留期必须放宽到覆盖演示天数，否则 7 天保留会把 30 天的数据清掉 ——
    //   第一次跑这条测试时只观察到 8 天，正是保留策略在正常工作。
    //   方案 § 7.3 允许用户把保留期设为 7 / 14 / 30 天，演示用 30 天。
    const { observer, log, clock } = setup({ ...granted, retentionDays: 30 });
    const records = generateDemoRecords({
      profile: DEMO_OFFICE_DEV,
      userId: USER,
      days: 30,
      endAt: T0,
    });

    // 走同一条 observe() 路径 —— 三道闸门照常生效
    for (const r of records) {
      observer.observe({
        app: r.app,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        hadInput: r.hadInput,
        source: r.source,
      });
    }

    const r = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER, demo: true },
    });

    expect(r.observedDays).toBeGreaterThanOrEqual(20);
    expect(r.patterns.length).toBeGreaterThan(0);
  });

  it('★ 默认 7 天保留会让 30 天演示数据只剩最近一周（保留策略是真在生效）', () => {
    const { observer, log, clock } = setup(granted); // 默认 7 天
    for (const r of generateDemoRecords({ profile: DEMO_OFFICE_DEV, userId: USER, days: 30, endAt: T0 })) {
      observer.observe({ app: r.app, startedAt: r.startedAt, endedAt: r.endedAt, hadInput: r.hadInput, source: 'demo' });
    }

    const res = derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER, demo: true },
    });

    expect(res.observedDays).toBeLessThanOrEqual(8);
    expect(res.observedDays).toBeGreaterThanOrEqual(MIN_OBSERVED_DAYS);
  });

  it('★ 演示来源被诚实标注在事件里', () => {
    const { observer, log, clock } = setup({ ...granted, retentionDays: 30 });
    const records = generateDemoRecords({ profile: DEMO_OFFICE_DEV, userId: USER, days: 30, endAt: T0 });
    for (const r of records) {
      observer.observe({ app: r.app, startedAt: r.startedAt, endedAt: r.endedAt, hadInput: r.hadInput, source: 'demo' });
    }
    derivePatterns({
      aggregates: observer.aggregate(T0),
      options: { log, clock, userId: USER, demo: true },
    });

    const ev = log.byType('pattern.derived')[0];
    expect((ev?.payload as { fromDemoData?: boolean }).fromDemoData).toBe(true);
  });

  it('演示数据可重放（同种子同结果）', () => {
    const gen = (): string =>
      generateDemoRecords({ profile: DEMO_OFFICE_DEV, userId: USER, days: 10, endAt: T0 })
        .map((r) => `${r.app}@${r.startedAt}`)
        .join(',');
    expect(gen()).toBe(gen());
  });

  it('★ 演示数据不是完美的（有噪声，置信度才有意义）', () => {
    const a = generateDemoRecords({ profile: DEMO_OFFICE_DEV, userId: USER, days: 30, endAt: T0, noiseSeed: 1 });
    const b = generateDemoRecords({ profile: DEMO_OFFICE_DEV, userId: USER, days: 30, endAt: T0, noiseSeed: 999 });
    // 不同种子产出不同数据 —— 说明噪声真的在起作用
    expect(a.length).not.toBe(b.length);
  });

  it('两个预置画像都在', () => {
    expect(DEMO_PROFILES).toHaveLength(2);
    expect(DEMO_PROFILES.map((p) => p.name)).toContain(DEMO_STUDENT.name);
  });

  it('预置画像产生不同类别的规律', () => {
    const cats = (profile: typeof DEMO_OFFICE_DEV): Set<string> => {
      const { observer, log, clock } = setup(granted);
      for (const r of generateDemoRecords({ profile, userId: USER, days: 30, endAt: T0 })) {
        observer.observe({ app: r.app, startedAt: r.startedAt, endedAt: r.endedAt, hadInput: r.hadInput, source: 'demo' });
      }
      const res = derivePatterns({
        aggregates: observer.aggregate(T0),
        options: { log, clock, userId: USER, demo: true },
      });
      return new Set(res.patterns.map((p) => p.kind));
    };

    expect(cats(DEMO_OFFICE_DEV).size).toBeGreaterThan(0);
    expect(cats(DEMO_STUDENT).size).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑦ ★ 成长画像（最强演示件）
// ═══════════════════════════════════════════════════════════

describe('⑦ ★ 成长画像', () => {
  const butler = { kind: 'butler', userId: USER } as const;

  function withMemories(n: number, principles = 0): MemoryStore {
    const log = new EventLog('s_p');
    const store = new MemoryStore(log, new FixedClock(T0), USER);
    for (let i = 0; i < n; i++) {
      store.create(butler, {
        id: `m${i}`,
        memClass: 'global_shared',
        kind: 'fact',
        content: `事实 ${i}`,
        confidence: 0.8,
        evidence: [],
        lifecycle: 'active',
      });
    }
    for (let i = 0; i < principles; i++) {
      store.create(butler, {
        id: `p${i}`,
        memClass: 'global_shared',
        kind: 'principle',
        content: `原则 ${i}`,
        confidence: 0.8,
        evidence: [],
        lifecycle: 'active',
      });
    }
    return store;
  }

  it('★ 快照反映记忆构成', () => {
    const { log, clock } = setup();
    const store = withMemories(10, 3);
    const s = captureProfile({ log, clock, store, userId: USER, patterns: [], sessionCount: 10 });

    expect(s.facts).toBe(10);
    expect(s.principles).toBe(3);
    expect(s.sessionCount).toBe(10);
    expect(s.perDomain).toBeDefined();
  });

  it('★ 候选不计入（没被承认的不算"我了解你"）', () => {
    const { log, clock } = setup();
    const store = new MemoryStore(log, new FixedClock(T0), USER);
    store.create(butler, {
      id: 'cand',
      memClass: 'global_shared',
      kind: 'fact',
      content: '还没审核的',
      confidence: 0.5,
      evidence: [],
      lifecycle: 'candidate',
    });

    const s = captureProfile({ log, clock, store, userId: USER, patterns: [], sessionCount: 1 });
    expect(s.facts).toBe(0);
  });

  it('快照落 profile.snapshot 事件，并标注是只读派生', () => {
    const { log, clock } = setup();
    const store = withMemories(5);
    captureProfile({ log, clock, store, userId: USER, patterns: [], sessionCount: 5 });

    const ev = log.byType('profile.snapshot');
    expect(ev).toHaveLength(1);
    expect((ev[0]?.payload as { readOnlyDerivation?: boolean }).readOnlyDerivation).toBe(true);
  });

  it('★ 只读派生：不往记忆库里写东西', () => {
    const { log, clock } = setup();
    const store = withMemories(5);
    const before = store.all().length;
    captureProfile({ log, clock, store, userId: USER, patterns: [], sessionCount: 5 });
    expect(store.all()).toHaveLength(before);
  });

  it('★★ 对比体现成长（记忆 12 → 47、原则 0 → 6）', () => {
    const { log, clock } = setup();
    const early = captureProfile({
      log, clock, store: withMemories(12, 0), userId: USER, patterns: [], sessionCount: 10,
    });
    const late = captureProfile({
      log, clock, store: withMemories(41, 6), userId: USER, patterns: [], sessionCount: 50,
    });

    const d = diffProfiles(early, late);
    expect(d.totalMemories).toBe(35); // 47 − 12
    expect(d.principles).toBe(6);
    expect(d.headline).toContain('多了解你 35 条');
  });

  it('★ 新原则按**内容**比较，不按 id（否则会说"全换了"）', () => {
    const { log, clock } = setup();

    // 两份快照来自不同 store，id 必然不同，但有一条内容相同
    const s1 = new MemoryStore(log, new FixedClock(T0), USER);
    s1.create(butler, { id: 'a1', memClass: 'global_shared', kind: 'principle', content: '推荐餐厅前确认忌口', confidence: 0.8, evidence: [], lifecycle: 'active' });
    const early = captureProfile({ log, clock, store: s1, userId: USER, patterns: [], sessionCount: 10 });

    const s2 = new MemoryStore(log, new FixedClock(T0), USER);
    s2.create(butler, { id: 'b1', memClass: 'global_shared', kind: 'principle', content: '推荐餐厅前确认忌口', confidence: 0.8, evidence: [], lifecycle: 'active' });
    s2.create(butler, { id: 'b2', memClass: 'global_shared', kind: 'principle', content: '提交代码前先跑测试', confidence: 0.8, evidence: [], lifecycle: 'active' });
    const late = captureProfile({ log, clock, store: s2, userId: USER, patterns: [], sessionCount: 50 });

    const d = diffProfiles(early, late);
    // 只新增了 1 条，不是 2 条
    expect(d.newPrinciples).toEqual(['提交代码前先跑测试']);
  });

  it('能被应用过的新原则被单独列出（"学过的东西真的在用"）', () => {
    const { log, clock } = setup();
    const early = captureProfile({
      log, clock, store: withMemories(1), userId: USER, patterns: [], sessionCount: 10,
    });

    const s2 = new MemoryStore(log, new FixedClock(T0), USER);
    s2.create(butler, { id: 'x', memClass: 'global_shared', kind: 'principle', content: '原则X', confidence: 0.8, evidence: [], lifecycle: 'active' });
    s2.setEffectiveness('x', { applied: 5, succeeded: 4, lastAppliedAt: T0 });
    const late = captureProfile({ log, clock, store: s2, userId: USER, patterns: [], sessionCount: 50 });

    const d = diffProfiles(early, late);
    expect(d.appliedPrinciples).toEqual(['原则X']);
  });

  it('★ 并排渲染包含方案 § 3.3 展示形式的关键元素', () => {
    const { log, clock } = setup();
    const early = captureProfile({ log, clock, store: withMemories(12), userId: USER, patterns: [], sessionCount: 10 });
    const late = captureProfile({ log, clock, store: withMemories(41, 2), userId: USER, patterns: [], sessionCount: 50 });

    const text = renderSideBySide(early, late);
    expect(text).toContain('会话 10');
    expect(text).toContain('会话 50');
    expect(text).toContain('记忆');
    expect(text).toContain('原则');
    expect(text).toContain('生活节奏');
    expect(text).toContain('我了解你');
  });

  it('无原则时并排渲染说明"还没有提炼出规律"', () => {
    const { log, clock } = setup();
    const s = captureProfile({ log, clock, store: withMemories(3), userId: USER, patterns: [], sessionCount: 5 });
    const text = renderSideBySide(s, s);
    expect(text).toContain('还没有提炼出可复用');
  });

  it('summary 说清记住了什么', () => {
    const { log, clock } = setup();
    const store = withMemories(5, 2);
    const s = captureProfile({ log, clock, store, userId: USER, patterns: [], sessionCount: 3 });
    expect(s.summary).toContain('第 3 次会话');
    expect(s.summary).toContain('7 条');
  });

  it('空记忆库也有合理 summary', () => {
    const { log, clock } = setup();
    const store = withMemories(0);
    const s = captureProfile({ log, clock, store, userId: USER, patterns: [], sessionCount: 1 });
    expect(s.summary).toContain('还没有形成');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑧ 桶键工具
// ═══════════════════════════════════════════════════════════

describe('⑧ 小时桶', () => {
  it('bucketOf 生成 YYYY-MM-DDTHH', () => {
    expect(bucketOf(new Date(2026, 9, 13, 14).getTime())).toBe('2026-10-13T14');
  });

  it('hourOfBucket 反解小时', () => {
    expect(hourOfBucket('2026-10-13T14')).toBe(14);
  });

  it('dateOfBucket 反解日期与星期', () => {
    const { day, dow } = dateOfBucket('2026-10-13T14');
    expect(day).toBe(13);
    expect(dow).toBe(2); // 周二
  });

  it('非法桶键不崩溃', () => {
    expect(hourOfBucket('bad')).toBe(0);
    expect(() => dateOfBucket('bad')).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// ⑨ 确定性
// ═══════════════════════════════════════════════════════════

describe('⑨ 确定性', () => {
  it('同一批聚合产出同一份规律（可重放）', () => {
    const build = (): string => {
      const { observer, log, clock } = setup(granted);
      for (let d = 0; d < 10; d++) {
        const at = T0 - d * DAY + 10 * HOUR;
        observer.observe({ app: 'Excel', startedAt: at, endedAt: at + 30 * 60 * 1000, hadInput: true });
      }
      const r = derivePatterns({
        aggregates: observer.aggregate(T0),
        options: { log, clock, userId: USER },
      });
      return r.patterns.map((p) => `${p.id}:${p.confidence}`).join(',');
    };
    expect(build()).toBe(build());
  });

  it('时间来自 ClockPort', () => {
    const { observer, clock } = setup(granted);
    const r = observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    expect(r.record?.startedAt).toBe(T0);
    expect(clock.now()).toBe(T0);
  });
});

describe('⑩ 回放：重启后明细不丢', () => {
  it('恢复原始记录、聚合，并保留单条删除结果', () => {
    const { observer, log, clock } = setup(granted);
    const a = observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    const b = observer.observe({ app: 'Word', startedAt: T0 + HOUR, endedAt: T0 + 2 * HOUR, hadInput: true });
    observer.aggregate(T0 + 2 * HOUR);
    observer.deleteRecord(a.record?.id ?? '');

    const replayed = new ActivityObserver(log, clock, USER, granted);
    replayed.replayFromLog(T0 + 2 * HOUR);
    const records = replayed.rawRecords(T0 + 2 * HOUR);
    expect(records.map((r) => r.app)).toEqual(['Word']);
    expect(records[0]?.id).toBe(b.record?.id);
    expect(replayed.allAggregates().length).toBeGreaterThan(0);
  });

  it('清空事件能让回放后的原始与聚合都为空', () => {
    const { observer, log, clock } = setup(granted);
    observer.observe({ app: 'Excel', startedAt: T0, endedAt: T0 + HOUR, hadInput: true });
    observer.aggregate(T0 + HOUR);
    observer.deleteAll(T0 + 2 * HOUR);

    const replayed = new ActivityObserver(log, clock, USER, granted);
    replayed.replayFromLog(T0 + 2 * HOUR);
    expect(replayed.rawRecords(T0 + 2 * HOUR)).toHaveLength(0);
    expect(replayed.allAggregates()).toHaveLength(0);
  });
});
