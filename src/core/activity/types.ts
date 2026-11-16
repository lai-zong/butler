/**
 * 行为观察的数据模型
 *
 * 设计依据：方案 § 7.3 防线一（采集边界）、防线二（分层存储）、§ 4.2
 *
 * ★ 本文件的核心作用：**把"绝不采集什么"写进类型系统**。
 *
 *   方案 § 7.3 防线一明列：
 *     ✅ 采集：前台应用**名称**、会话起止与时长、类型分类、空闲/活跃状态
 *     ❌ 绝不采集：窗口**标题**与内容、键盘输入、网页 URL、文件路径与内容、凭证
 *
 *   ⚠️ 只在文档里写"我们不采集窗口标题"是靠不住的 ——
 *      实现者加一个字段就破功了。所以这里**根本不提供那个字段的位置**：
 *      `ActivityRecord` 里没有任何可以放标题、URL、路径的地方。
 *      想采集也存不下 —— 这是结构性保证，不是纪律要求。
 *
 * ★ 方案 § 7.6 的说明措辞（本项目最有力的立场之一）：
 *   "我们主动舍弃了很多东西。……**这个'主动舍弃'的清单，
 *     比'我们采集了什么'更能说明我们的立场。**"
 */

// ═══════════════════════════════════════════════════════════
// 应用分类
// ═══════════════════════════════════════════════════════════

/**
 * 应用类型分类。
 *
 * ⚠️ 分类**由应用名映射得到**，不来自窗口内容 ——
 *    否则"分类"就成了绕过边界的后门（从标题里读内容来分类）。
 */
export type ActivityCategory =
  | 'work'
  | 'study'
  | 'entertainment'
  | 'communication'
  | 'other';

export const CATEGORY_LABEL: Record<ActivityCategory, string> = {
  work: '工作',
  study: '学习',
  entertainment: '娱乐',
  communication: '沟通',
  other: '其它',
};

/**
 * 应用名 → 分类的映射。
 *
 * ⚠️ 这是**唯一**的分类来源。未知应用一律归 `other`，
 *    不试图"猜"它在干什么（猜测需要看内容，那正是边界之外）。
 */
const APP_CATEGORY: Record<string, ActivityCategory> = {
  // 工作
  excel: 'work', word: 'work', powerpoint: 'work', wps: 'work', outlook: 'work',
  'visual studio': 'work', vscode: 'work', 'code': 'work', sublime: 'work',
  photoshop: 'work', illustrator: 'work', notion: 'work', 'wordpad': 'work',
  // 学习
  anki: 'study', obsidian: 'study', zotero: 'study', 'margin note': 'study',
  kindle: 'study', coursera: 'study', 'khan academy': 'study',
  // 沟通
  wechat: 'communication', qq: 'communication', dingtalk: 'communication',
  feishu: 'communication', lark: 'communication', slack: 'communication',
  telegram: 'communication', discord: 'communication', zoom: 'communication',
  teams: 'communication', 'tencent meeting': 'communication',
  // 娱乐
  steam: 'entertainment', bilibili: 'entertainment', youtube: 'entertainment',
  netflix: 'entertainment', potplayer: 'entertainment', vlc: 'entertainment',
  spotify: 'entertainment', music: 'entertainment', game: 'entertainment',
  // 浏览器不分类 —— 同一次会话里可能在做任何事，
  // 而"看 URL 才知道"正是边界之外。归 other 是诚实的做法。
};

/** 由应用名得到分类。未知一律 `other`。 */
export function categorize(appName: string): ActivityCategory {
  const n = appName.toLowerCase().trim();
  // 完全匹配优先
  const exact = APP_CATEGORY[n];
  if (exact) return exact;
  // 再做包含匹配（"Microsoft Excel" → excel）
  for (const [key, cat] of Object.entries(APP_CATEGORY)) {
    if (n.includes(key)) return cat;
  }
  return 'other';
}

// ═══════════════════════════════════════════════════════════
// 原始活动记录（短期）
// ═══════════════════════════════════════════════════════════

/**
 * 一次前台应用会话。
 *
 * ★ 注意这里**没有**的字段（有意为之，见文件头）：
 *   标题、URL、文件路径、按键、截图、内容摘要。
 *
 * ⚠️ 也没有"坐标""窗口大小"这类可以间接推断内容的信息。
 */
export interface ActivityRecord {
  readonly id: string;
  readonly userId: string;
  /** 前台应用名（不含版本号、不含文档名） */
  readonly app: string;
  readonly category: ActivityCategory;
  readonly startedAt: number;
  readonly endedAt: number;
  /** 时长（毫秒）。由 endedAt − startedAt 得出并冗余存储，便于聚合 */
  readonly durationMs: number;
  /**
   * 这段时间内是否有用户输入（**只记布尔值，不记内容**）。
   *
   * 用途：区分"真的在忙"与"窗口开着但人不在"。
   * 这正是方案要求的"系统空闲/活跃状态"。
   */
  readonly hadInput: boolean;
  /** 采样方式 */
  readonly source: 'sample' | 'session' | 'demo';
}

// ═══════════════════════════════════════════════════════════
// 聚合结果（长期）
// ═══════════════════════════════════════════════════════════

/**
 * 按小时聚合的活动。
 *
 * ★ 这是"长期只保留聚合结果"的载体 —— 原始记录 7 天后清除，
 *   聚合结果长期保留。方案 § 7.3 防线二。
 */
export interface ActivityAggregate {
  readonly id: string;
  readonly userId: string;
  /** 小时桶，形如 '2026-10-13T14' */
  readonly bucket: string;
  readonly category: ActivityCategory;
  readonly minutes: number;
  /** 仅应用名，不含窗口标题或内容 */
  readonly topApps: readonly string[];
}

/** 由时间戳构造小时桶键。 */
export function bucketOf(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/** 由桶键反解出小时（用于规律提取）。 */
export function hourOfBucket(bucket: string): number {
  const m = /T(\d{2})$/.exec(bucket);
  return m?.[1] !== undefined ? Number(m[1]) : 0;
}

/** 由桶键反解出日期（用于判断工作日/周末）。 */
export function dateOfBucket(bucket: string): { readonly day: number; readonly dow: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(bucket);
  if (!m) return { day: 0, dow: 0 };
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return { day: d.getDate(), dow: d.getDay() };
}

// ═══════════════════════════════════════════════════════════
// 时间维度规律
// ═══════════════════════════════════════════════════════════

/**
 * - `routine`      作息规律："工作日 9—18 点为专注时段"
 * - `preference`   使用偏好："周末晚间偏好影音娱乐"
 * - `availability` 空闲时段："周末上午通常比较空闲"
 */
export type PatternKind = 'routine' | 'preference' | 'availability';

export const PATTERN_KIND_LABEL: Record<PatternKind, string> = {
  routine: '作息规律',
  preference: '使用偏好',
  availability: '空闲时段',
};

export interface TemporalPattern {
  readonly id: string;
  readonly userId: string;
  readonly kind: PatternKind;
  /** 自然语言描述："工作日 9—18 点为专注时段" */
  readonly pattern: string;
  readonly confidence: number;
  /** 支撑的聚合记录引用（证据链） */
  readonly evidence: readonly string[];
  /** ★ 观察了多少天才得出 —— 少于阈值不该产出规律 */
  readonly observedDays: number;
  readonly appliesTo: 'weekday' | 'weekend' | 'all';
  readonly createdAt: number;
}

/** 规律类型的中文标签（界面用）。 */
export const APPLIES_TO_LABEL: Record<TemporalPattern['appliesTo'], string> = {
  weekday: '工作日',
  weekend: '周末',
  all: '每天',
};
