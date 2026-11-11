/**
 * 使用节奏 —— 纯聚合逻辑
 *
 * 只处理“用户如何使用本项目 Web 界面”的匿名节奏：
 * 页面、时间、是否活跃；不接收任务、工具、消息、记忆或审查内容。
 *
 * ★ 为什么单独成模块：
 *   聚合、时段推断与会话切分都应可测试，且不依赖文件系统 / Next.js。
 *   前端只负责按心跳上报；所有结论都在这里由同一套算法算出。
 */

export const USAGE_PAGE_IDS = [
  'chat',
  'tasks',
  'settings',
  'memory',
  'growth',
] as const;

export type UsagePage = (typeof USAGE_PAGE_IDS)[number];

export const USAGE_PAGE_LABEL: Record<UsagePage, string> = {
  chat: '对话',
  tasks: '定时任务',
  settings: '设置',
  memory: '记忆',
  growth: '演化',
};

export interface UsagePing {
  /** 毫秒时间戳 */
  readonly at: number;
  readonly page: UsagePage;
  /** 页面可见且最近有用户操作；false 表示只是开着页面。 */
  readonly active: boolean;
  /** 可选：当前应用内会话；不参与内容分析。 */
  readonly sessionId?: string;
}

export interface UsageSettings {
  readonly enabled: boolean;
}

export interface UsageDay {
  readonly date: string;
  readonly minutes: number;
  readonly sessions: number;
}

export interface UsagePageStat {
  readonly id: UsagePage;
  readonly label: string;
  readonly visits: number;
  readonly minutes: number;
}

export interface UsageHabit {
  readonly id: string;
  readonly text: string;
  readonly confidence: number;
  readonly observedDays: number;
}

export interface UsageSnapshot {
  readonly enabled: boolean;
  readonly days: number;
  readonly totalMinutes: number;
  readonly visibleMinutes: number;
  readonly activeDays: number;
  readonly sessionCount: number;
  readonly avgSessionMinutes: number;
  readonly daily: readonly UsageDay[];
  readonly pages: readonly UsagePageStat[];
  readonly habits: readonly UsageHabit[];
  readonly trackingSince: number | null;
}

/** 心跳间隔；前端按约 60 秒上报一次。 */
export const USAGE_PING_WEIGHT_MS = 60_000;

/** 两次活跃心跳间隔超过该值，视为两次使用。 */
export const USAGE_SESSION_GAP_MS = 10 * 60_000;

export const USAGE_DEFAULT_DAYS = 7;
export const USAGE_MAX_DAYS = 30;

export function isUsagePage(value: unknown): value is UsagePage {
  return typeof value === 'string' && (USAGE_PAGE_IDS as readonly string[]).includes(value);
}

export function clampUsageDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return USAGE_DEFAULT_DAYS;
  return Math.max(1, Math.min(USAGE_MAX_DAYS, Math.floor(value)));
}

function dayKey(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function roundMinutes(ms: number): number {
  return Math.max(0, Math.round((ms / 60_000) * 10) / 10);
}

function confidence(ratio: number, days: number): number {
  return Number(Math.min(0.95, ratio * 0.8 + Math.min(0.15, (days / 20) * 0.15)).toFixed(2));
}

/**
 * 把心跳合成使用快照。
 *
 * 活跃时长按相邻活跃心跳的间隔累计，单次最多计 60 秒；
 * 这样页面切换不会因为多打了一个点而凭空多出一分钟。
 */
export function aggregateUsage(
  pings: readonly UsagePing[],
  options: { readonly now: number; readonly days?: number; readonly enabled?: boolean },
): UsageSnapshot {
  const days = clampUsageDays(options.days);
  const now = options.now;
  const from = now - days * 24 * 60 * 60 * 1000;

  const window = pings
    .filter((p) => Number.isFinite(p.at) && p.at >= from && p.at <= now + 60_000)
    .slice()
    .sort((a, b) => a.at - b.at);

  const active = window.filter((p) => p.active);
  const activeWeights = new Map<UsagePing, number>();
  for (let i = 0; i < active.length; i++) {
    const current = active[i];
    if (current === undefined) continue;
    const next = active[i + 1];
    const gap = next === undefined ? USAGE_PING_WEIGHT_MS : next.at - current.at;
    const weight =
      gap > 0 ? Math.min(USAGE_PING_WEIGHT_MS, gap) : USAGE_PING_WEIGHT_MS;
    activeWeights.set(current, weight);
  }

  const activeMs = [...activeWeights.values()].reduce((sum, n) => sum + n, 0);
  const visibleMs = window.length * USAGE_PING_WEIGHT_MS;

  const activeDates = new Set(active.map((p) => dayKey(p.at)));
  const activeDays = activeDates.size;

  // 会话：按活跃心跳切分；页面切换不会切会话。
  const sessions: { start: number; ms: number }[] = [];
  for (let i = 0; i < active.length; i++) {
    const current = active[i];
    if (current === undefined) continue;
    const previous = active[i - 1];
    const weight = activeWeights.get(current) ?? USAGE_PING_WEIGHT_MS;
    if (previous === undefined || current.at - previous.at > USAGE_SESSION_GAP_MS) {
      sessions.push({ start: current.at, ms: weight });
    } else {
      const last = sessions[sessions.length - 1];
      if (last !== undefined) last.ms += weight;
    }
  }
  const sessionCount = sessions.length;
  const avgSessionMinutes =
    sessionCount === 0 ? 0 : Math.round(roundMinutes(sessions.reduce((s, x) => s + x.ms, 0)) / sessionCount);

  // 每天：按开始日期归属；同一天多个会话可累加。
  const dailyMap = new Map<string, { minutes: number; sessions: number }>();
  for (const session of sessions) {
    const key = dayKey(session.start);
    const cur = dailyMap.get(key) ?? { minutes: 0, sessions: 0 };
    cur.minutes += session.ms;
    cur.sessions += 1;
    dailyMap.set(key, cur);
  }

  const daily: UsageDay[] = [];
  const todayStart = startOfDay(now);
  for (let i = days - 1; i >= 0; i--) {
    const at = todayStart - i * 24 * 60 * 60 * 1000;
    const key = dayKey(at);
    const cur = dailyMap.get(key);
    daily.push({
      date: key,
      minutes: roundMinutes(cur?.minutes ?? 0),
      sessions: cur?.sessions ?? 0,
    });
  }

  // 页面：首次出现算一次访问；分钟数按活跃心跳归属。
  const pageMap = new Map<UsagePage, { visits: number; ms: number }>();
  for (let i = 0; i < active.length; i++) {
    const ping = active[i];
    if (ping === undefined) continue;
    const cur = pageMap.get(ping.page) ?? { visits: 0, ms: 0 };
    const previous = active[i - 1];
    if (previous === undefined || previous.page !== ping.page) cur.visits += 1;
    cur.ms += activeWeights.get(ping) ?? USAGE_PING_WEIGHT_MS;
    pageMap.set(ping.page, cur);
  }
  const pages = [...pageMap.entries()]
    .map(([id, v]) => ({ id, label: USAGE_PAGE_LABEL[id], visits: v.visits, minutes: roundMinutes(v.ms) }))
    .sort((a, b) => b.minutes - a.minutes || b.visits - a.visits || a.id.localeCompare(b.id));

  const habits: UsageHabit[] = [];
  if (activeDays >= 3) {
    // 两小时窗口，选择覆盖天数最多的一个；要求至少覆盖 60% 的活跃日。
    let best: { start: number; days: number } | null = null;
    for (let start = 0; start <= 22; start++) {
      const hitDays = new Set(
        active
          .filter((p) => {
            const hour = new Date(p.at).getHours();
            return hour >= start && hour < start + 2;
          })
          .map((p) => dayKey(p.at)),
      ).size;
      if (best === null || hitDays > best.days) best = { start, days: hitDays };
    }
    if (best !== null) {
      const ratio = best.days / activeDays;
      if (best.days >= 3 && ratio >= 0.6) {
        const fromHour = String(best.start).padStart(2, '0');
        const toHour = String(best.start + 2).padStart(2, '0');
        habits.push({
          id: 'usual-window',
          text: `常在 ${fromHour}:00–${toHour}:00 使用`,
          confidence: confidence(ratio, activeDays),
          observedDays: activeDays,
        });
      }
    }
  }

  if (sessionCount >= 3 && avgSessionMinutes > 0) {
    habits.push({
      id: 'session-length',
      text: `单次使用通常约 ${avgSessionMinutes} 分钟`,
      confidence: Number(Math.min(0.9, 0.55 + Math.min(0.25, sessionCount / 40)).toFixed(2)),
      observedDays: activeDays,
    });
  }

  const topPage = pages[0];
  if (topPage !== undefined && topPage.visits >= 3 && activeDays >= 3) {
    habits.push({
      id: 'favorite-page',
      text: `常打开「${topPage.label}」`,
      confidence: confidence(topPage.visits / Math.max(1, active.length), activeDays),
      observedDays: activeDays,
    });
  }

  return {
    enabled: options.enabled ?? true,
    days,
    totalMinutes: roundMinutes(activeMs),
    visibleMinutes: roundMinutes(visibleMs),
    activeDays,
    sessionCount,
    avgSessionMinutes,
    daily,
    pages,
    habits,
    trackingSince: window[0]?.at ?? null,
  };
}
