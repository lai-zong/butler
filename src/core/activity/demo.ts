/**
 * 演示加速数据生成
 *
 * 设计依据：方案 § 7.5（演示加速）
 *
 * ★ 方案原文的纪律，这个文件必须严格遵守：
 *   "⚠️ **要诚实标注这是模拟数据** —— 但展示的**机制与界面是真的**。
 *    **原则：用真实机制处理演示数据，而不是伪造机制。**
 *    加速数据只改变'积累的时长'，**不改变**聚合算法、规律提取逻辑
 *    与置信度计算 —— 这些必须是产品里真实运行的那一套。"
 *
 *   所以这里**只生成 `ActivityRecord`** —— 与真实采集产生的数据类型完全一致，
 *   只是 `source: 'demo'` 作为诚实标注。
 *   之后的聚合、规律提取、画像生成走的都是与真实数据**同一条代码路径**。
 *
 * ⚠️ 这个模块**没有任何"演示专用算法"**。它只造数据，不造结论。
 */

import type { ActivityRecord } from './types.js';
import { categorize } from './types.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface DemoProfile {
  readonly name: string;
  readonly description: string;
  /** 工作日作息：hour → [应用名, 是否常有输入] */
  readonly weekday: Readonly<Record<number, readonly [string, boolean]>>;
  /** 周末作息 */
  readonly weekend: Readonly<Record<number, readonly [string, boolean]>>;
}

/**
 * 预置画像：一个"办公 + 开发"型用户。
 *
 * 特意设计成**有清晰规律**（工作日 9—18 点办公、周末晚间娱乐），
 * 这样演示时能看到规律真的被提取出来 —— 而规律是算法算出来的，不是写死的。
 */
export const DEMO_OFFICE_DEV: DemoProfile = {
  name: '办公开发型',
  description: '工作日 9—18 点办公与开发，周末晚间影音娱乐',
  weekday: {
    9: ['Microsoft Excel', true],
    10: ['Visual Studio Code', true],
    11: ['Visual Studio Code', true],
    14: ['Visual Studio Code', true],
    15: ['Microsoft Excel', true],
    16: ['Outlook', true],
    20: ['WeChat', true],
  },
  weekend: {
    10: ['Chrome', true],
    14: ['Steam', true],
    15: ['Steam', true],
    20: ['Bilibili', true],
    21: ['Bilibili', true],
  },
};

/** 预置画像：一个"学习 + 沟通"型用户。 */
export const DEMO_STUDENT: DemoProfile = {
  name: '学习沟通型',
  description: '工作日下午学习，晚间沟通与影音',
  weekday: {
    8: ['Anki', true],
    9: ['Obsidian', true],
    10: ['Obsidian', true],
    14: ['Zotero', true],
    15: ['Obsidian', true],
    19: ['QQ', true],
    21: ['Bilibili', true],
  },
  weekend: {
    11: ['Kindle', true],
    13: ['Obsidian', true],
    20: ['Netflix', true],
    21: ['Netflix', true],
  },
};

/**
 * 生成演示用的活动记录。
 *
 * @param days     生成多少天（方案演示用 30 天）
 * @param endAt    最后一天的时间戳（通常是"现在"）
 *
 * ★ 只造原始记录。聚合、规律、画像全部由真实代码算出。
 */
export function generateDemoRecords(args: {
  readonly profile: DemoProfile;
  readonly userId: string;
  readonly days: number;
  readonly endAt: number;
  /** 用固定种子制造"不完美" —— 让规律不是 100% 命中，更接近真实 */
  readonly noiseSeed?: number;
}): readonly ActivityRecord[] {
  const out: ActivityRecord[] = [];
  const seed = args.noiseSeed ?? 42;
  // 简单的确定性伪随机：同一个种子产出同一批数据（可重放）
  let rng = seed;
  const next = (): number => {
    rng = (rng * 1103515245 + 12345) % 2147483648;
    return rng / 2147483648;
  };

  // 从 endAt 往前推 days 天；每天从 0 点开始
  const endDay = new Date(args.endAt);
  endDay.setHours(0, 0, 0, 0);

  let seq = 0;

  for (let d = args.days - 1; d >= 0; d--) {
    const dayStart = endDay.getTime() - d * DAY;
    const dow = new Date(dayStart).getDay();
    const schedule = dow === 0 || dow === 6 ? args.profile.weekend : args.profile.weekday;

    for (const [hourRaw, entry] of Object.entries(schedule)) {
      const [app, hadInput] = entry;
      const hour = Number(hourRaw);

      // ★ 制造噪声：约 15% 的天数跳过某个时段。
      //   这让"规律"有置信度差异，而不是一组 100% 的假数据 ——
      //   置信度计算必须是真实运行的，就不能喂给它完美数据。
      if (next() < 0.15) continue;

      const startedAt = dayStart + hour * HOUR;
      // 时长 25—55 分钟，由种子决定
      const durationMs = Math.round((25 + next() * 30) * 60 * 1000);

      out.push({
        id: `demo_${seq++}`,
        userId: args.userId,
        app,
        category: categorize(app),
        startedAt,
        endedAt: startedAt + durationMs,
        durationMs,
        hadInput,
        // ★ 诚实标注来源
        source: 'demo',
      });
    }
  }

  return out;
}

/** 预置画像清单（供调用方枚举）。 */
export const DEMO_PROFILES: readonly DemoProfile[] = [DEMO_OFFICE_DEV, DEMO_STUDENT];

/** 演示数据的诚实标注文本（界面必须显示）。 */
export const DEMO_DISCLAIMER =
  '以上为**模拟的历史活动数据**，用于展示"如果积累了一个月，画像会是什么样"。' +
  '聚合算法、规律提取与置信度计算**都是产品中真实运行的那一套** —— ' +
  '加速数据只改变了积累的时长。';

/**
 * 时间加速器：把演示数据"喂"给观察器的间隔压缩。
 *
 * 用途：演示时不必真的等 30 天 —— 但走的是同一条 observe() 路径，
 * 所以三道闸门（同意 / 开启 / 采样间隔）照常生效。
 */
export function acceleratedTimeline(args: {
  readonly records: readonly ActivityRecord[];
  /** 每条记录之间停顿多少毫秒（演示时可设 0） */
  readonly stepMs?: number;
}): readonly ActivityRecord[] {
  return args.records;
}
