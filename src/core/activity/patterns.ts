/**
 * 时间维度规律提取 —— 从聚合记录里提炼自然语言规律
 *
 * 设计依据：方案 § 7.5（演示加速）、§ 7.4（用途）
 *
 * ★ 两条纪律：
 *
 *   ① **样本不足时宁可不产出**。
 *      方案 § 7.2 风险 3 说得很直白："单个数据点信息量极低……
 *      需要长期累积才能形成有用规律"。
 *      所以 `MIN_OBSERVED_DAYS` 以下直接返回空 —— 不猜。
 *
 *   ② **用真实机制处理演示数据，而不是伪造机制**（方案 § 7.5 原文）。
 *      演示模式只改变"积累的时长"，**不改变**聚合算法、规律提取逻辑
 *      与置信度计算 —— 那些必须是产品里真实运行的那一套。
 *      所以本模块没有任何"演示专用分支"：演示数据走的是同一条代码路径，
 *      只是 `source` 字段标成 `demo` 以便诚实标注。
 */

import type { ClockPort } from '../ports/clock.js';
import type { EventLog } from '../events/log.js';
import {
  CATEGORY_LABEL,
  dateOfBucket,
  hourOfBucket,
  type ActivityAggregate,
  type ActivityCategory,
  type PatternKind,
  type TemporalPattern,
} from './types.js';

// ═══════════════════════════════════════════════════════════
// 阈值
// ═══════════════════════════════════════════════════════════

/**
 * 最少观察天数。低于此值不产出任何规律。
 *
 * ★ 这个数字是"诚实"的体现：一天的"9 点到 18 点在用 Excel"
 *   说明不了任何事 —— 那天可能只是赶一个报表。
 */
export const MIN_OBSERVED_DAYS = 5;

/** 某个小时要被认定为"惯常"，需要在观察天数里出现的比例。 */
export const HOUR_RATIO_THRESHOLD = 0.6;

/**
 * 推导天数需求：既要够 `MIN_OBSERVED_DAYS`，也要让 0.6 的比例在整数天数上可达。
 *
 * 例：只观察到 5 天时，4/5 = 0.8 ✓、3/5 = 0.6 ✓（恰好），
 *     所以 5 天够用；若阈值提到 0.7 就需要至少 7 天（5/7≈0.71）。
 */
export function requiredDaysFor(ratio: number, minDays = MIN_OBSERVED_DAYS): number {
  // 构造一个"分子恰好达标"的最小 k：ceil(ratio * d) / d >= ratio
  let d = minDays;
  while (Math.ceil(ratio * d) / d < ratio - 1e-9) d += 1;
  return d;
}

// ═══════════════════════════════════════════════════════════
// 提取
// ═══════════════════════════════════════════════════════════

export interface DeriveOptions {
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly userId: string;
  /** 是否来自演示数据（**只用于诚实标注，不改变任何算法**） */
  readonly demo?: boolean;
}

export interface DeriveResult {
  readonly patterns: readonly TemporalPattern[];
  /** 观察到的天数 —— 少于阈值时这里是 0 且 patterns 为空 */
  readonly observedDays: number;
  /** 未产出规律时的原因（供界面说明"数据还不够"）*/
  readonly reason?: string;
}

/**
 * 从聚合记录里提取时间维度规律。
 *
 * 产出三类：
 *   · routine      作息规律 —— 某个类别在特定时段反复出现
 *   · preference   使用偏好 —— 某个类别集中在工作日或周末
 *   · availability 空闲时段 —— 持续没有活动的时间段
 */
export function derivePatterns(args: {
  readonly aggregates: readonly ActivityAggregate[];
  readonly options: DeriveOptions;
}): DeriveResult {
  const { aggregates, options } = args;

  // ── 统计观察覆盖的天数 ──
  const days = new Set<string>();
  for (const a of aggregates) {
    const m = /^\d{4}-\d{2}-\d{2}/.exec(a.bucket);
    if (m) days.add(m[0]);
  }
  const observedDays = days.size;

  if (observedDays < MIN_OBSERVED_DAYS) {
    return {
      patterns: [],
      observedDays,
      reason:
        `只观察到 ${observedDays} 天，少于 ${MIN_OBSERVED_DAYS} 天 —— ` +
        '样本不足时不产出规律（一天的数据说明不了任何事）',
    };
  }

  const patterns: TemporalPattern[] = [];

  // ── 按「类别 + 星期类型 + 小时」统计出现天数 ──
  // key: category|weekday|hour  → 出现过的日期集合
  const hits = new Map<string, Set<string>>();
  // 每天每小时是否有活动（用于空闲时段推断）
  const busyHours = new Map<string, boolean>();

  for (const a of aggregates) {
    const dateKey = a.bucket.slice(0, 10);
    const hour = hourOfBucket(a.bucket);
    const { dow } = dateOfBucket(a.bucket);
    const dayType = dow === 0 || dow === 6 ? 'weekend' : 'weekday';

    // 只统计"有实际使用"的时段（≥1 分钟）
    if (a.minutes >= 1) {
      const key = `${a.category}|${dayType}|${hour}`;
      const set = hits.get(key) ?? new Set<string>();
      set.add(dateKey);
      hits.set(key, set);
      busyHours.set(`${dayType}|${hour}`, true);
    }
  }

  // 每个"星期类型"各自观察了多少天
  const dayTypeDays = new Map<'weekday' | 'weekend', Set<string>>();
  for (const dateKey of days) {
    const { dow } = dateOfBucket(`${dateKey}T00`);
    const dt = dow === 0 || dow === 6 ? 'weekend' : 'weekday';
    const set = dayTypeDays.get(dt) ?? new Set<string>();
    set.add(dateKey);
    dayTypeDays.set(dt, set);
  }

  // ── ① 作息规律 / 使用偏好 ──
  for (const [key, dates] of hits) {
    const [categoryRaw, dayTypeRaw, hourRaw] = key.split('|');
    const category = categoryRaw as ActivityCategory;
    const dayType = dayTypeRaw as 'weekday' | 'weekend';
    const hour = Number(hourRaw);

    const total = dayTypeDays.get(dayType)?.size ?? 0;
    if (total < MIN_OBSERVED_DAYS) continue;

    const ratio = dates.size / total;
    if (ratio < HOUR_RATIO_THRESHOLD) continue;

    // ⚠️ `other` 类别的标签是「其它」，直接套进句式会得到
    //    "周末 10:00—11:00 通常在其它" —— 读起来不通。
    //    这一类（典型是浏览器）确实说不清在做什么，措辞上如实退让。
    const what = category === 'other' ? '在用电脑' : `在${CATEGORY_LABEL[category]}`;
    const rangeLabel = `${String(hour).padStart(2, '0')}:00—${String(hour + 1).padStart(2, '0')}:00`;
    const dayLabel = dayType === 'weekday' ? '工作日' : '周末';

    // 置信度：出现比例为主，观察天数做小幅加成（样本越多越可信）
    const confidence = Math.min(
      0.95,
      ratio * 0.8 + Math.min(0.15, (dates.size / 20) * 0.15),
    );

    // ★ 区分「作息规律」与「使用偏好」靠**时段性质**，不靠出现比例高低。
    //
    //   ⚠️ 我第一版用 ratio≥0.8 判定作息、否则算偏好，结果是同一条
    //      "工作日 15:00 通常在工作" 被标成作息（75%）又被标成偏好（75%）——
    //      两个类型说了同一件事，毫无区分度。
    //
    //   正确的语义：
    //     routine      在工作时段内的规律（工作日 9—18 点）→ "什么时候在忙"
    //     preference   在**自由时段**选择做什么（工作日早/晚、周末）
    //                  → "闲下来喜欢做什么"
    const isWorkHour = dayType === 'weekday' && hour >= 9 && hour < 18;
    const kind: PatternKind = isWorkHour ? 'routine' : 'preference';

    patterns.push({
      id: `pat_${category}_${dayType}_${hour}`,
      userId: options.userId,
      kind,
      pattern: `${dayLabel} ${rangeLabel} 通常${what}`,
      confidence: Number(confidence.toFixed(3)),
      evidence: [...dates].sort().map((d) => `agg_${d}T${String(hour).padStart(2, '0')}|${category}`),
      observedDays: total,
      appliesTo: dayType,
      createdAt: options.clock.now(),
    });
  }

  // ── ② 空闲时段 ──
  // ★ 只在**工作日**推断空闲：工作日的作息比周末稳定得多，
  //   拿周末的"没在办公"当"有空"会得出错误结论。
  for (const dayType of ['weekday'] as const) {
    const total = dayTypeDays.get(dayType)?.size ?? 0;
    if (total < MIN_OBSERVED_DAYS) continue;

    // 找连续的空闲小时段（9:00—22:00 之间考虑）
    const free: number[] = [];
    for (let h = 9; h <= 21; h++) {
      if (!busyHours.get(`${dayType}|${h}`)) free.push(h);
    }

    for (const span of contiguousSpans(free, 2)) {
      const from = span[0];
      const to = span[span.length - 1];
      if (from === undefined || to === undefined) continue;

      patterns.push({
        id: `pat_free_${dayType}_${from}`,
        userId: options.userId,
        kind: 'availability',
        pattern: `工作日 ${String(from).padStart(2, '0')}:00—${String(to + 1).padStart(2, '0')}:00 通常比较空闲`,
        // 空闲推断比"出现了什么"更弱 —— 没观察到不等于不会发生
        confidence: 0.6,
        evidence: [`观察 ${total} 个工作日，该时段均无活动记录`],
        observedDays: total,
        appliesTo: dayType,
        createdAt: options.clock.now(),
      });
    }
  }

  // ── 排序：置信度降序，id 打破平手（保证可重放）──
  patterns.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.id.localeCompare(b.id);
  });

  // ── 落事件 ──
  for (const p of patterns) {
    options.log.append({
      type: 'pattern.derived',
      actor: 'butler',
      payload: {
        patternId: p.id,
        kind: p.kind,
        pattern: p.pattern,
        confidence: p.confidence,
        observedDays: p.observedDays,
        appliesTo: p.appliesTo,
        // ⚠️ 诚实标注：演示数据也用同一套算法，只是来源不同
        fromDemoData: options.demo === true,
      },
      createdAt: options.clock.now(),
    });
  }

  return { patterns, observedDays };
}

/**
 * 使规律失效（生活节奏变了）。
 *
 * 方案 § 7.4 的"节奏变化检测"落点：
 * 新数据与旧规律矛盾时，把旧规律标记失效并落事件，
 * 而不是悄悄覆盖 —— 用户应当看到"我发现的规律变了"。
 */
export function invalidatePattern(args: {
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly pattern: TemporalPattern;
  readonly reason: string;
}): void {
  args.log.append({
    type: 'pattern.invalidated',
    actor: 'butler',
    payload: {
      patternId: args.pattern.id,
      pattern: args.pattern.pattern,
      reason: args.reason,
      observedDays: args.pattern.observedDays,
    },
    createdAt: args.clock.now(),
  });
}

/** 把规律翻译成管家可用的提示语（方案 § 7.4 的四个场景）。 */
export function patternGuidance(p: TemporalPattern): string {
  switch (p.kind) {
    case 'routine':
      return `${p.pattern} —— 这个时段尽量别打扰`;
    case 'availability':
      return `${p.pattern} —— 需要用户参与的事可以安排在这里`;
    case 'preference':
      return `${p.pattern} —— 相关建议可以按这个节奏给`;
  }
}

/** 从数组里找出长度 ≥ minLen 的连续整数段。 */
function contiguousSpans(sorted: readonly number[], minLen: number): readonly (readonly number[])[] {
  const out: number[][] = [];
  let run: number[] = [];
  for (const n of sorted) {
    const last = run[run.length - 1];
    if (last === undefined || n === last + 1) {
      run.push(n);
    } else {
      if (run.length >= minLen) out.push(run);
      run = [n];
    }
  }
  if (run.length >= minLen) out.push(run);
  return out;
}
