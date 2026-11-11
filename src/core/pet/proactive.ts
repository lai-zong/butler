/**
 * 桌宠主动说话 —— 确定性策略
 *
 * ★ 只决定“现在能不能说、说什么方向”，不调用模型，也不读任务内容。
 *   人格只负责把文字说得像它；频率、安静时段和场景由这里硬性限制。
 */

export type ProactiveTrigger = 'late_night' | 'long_session' | 'return';
export type ProactiveFrequency = 'rare' | 'normal' | 'often';

export interface ProactiveScenarios {
  readonly lateNight: boolean;
  readonly longSession: boolean;
  readonly return: boolean;
}

export interface ProactiveConfig {
  readonly enabled: boolean;
  readonly frequency: ProactiveFrequency;
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly scenarios: ProactiveScenarios;
}

export interface ProactiveUsage {
  /** 当前连续使用时长（分钟）；不足 1 分钟按 0。 */
  readonly sessionMinutes: number;
  /** 最近一次活跃心跳；没有则为 null。 */
  readonly lastActiveAt: number | null;
  /** 当前会话开始前的上一次活跃心跳；没有则为 null。 */
  readonly previousActiveAt: number | null;
}

export interface ProactiveHistoryEntry {
  readonly at: number;
  readonly trigger: ProactiveTrigger;
}

export interface ProactiveDecisionInput {
  readonly now: number;
  readonly config: ProactiveConfig;
  readonly usage: ProactiveUsage;
  readonly history: readonly ProactiveHistoryEntry[];
  /** 用户点了“稍后”后到该时刻前不再说话。 */
  readonly suppressedUntil: number | null;
}

export interface ProactiveDecision {
  readonly speak: boolean;
  readonly reason: string;
  readonly trigger?: ProactiveTrigger;
  readonly text?: string;
  /** 如果本次允许，下一次最早可说话的时间（用于前端展示/节流）。 */
  readonly cooldownUntil?: number;
}

interface FrequencyRule {
  readonly maxPerDay: number;
  readonly minGapMs: number;
}

const FREQUENCY_RULES: Record<ProactiveFrequency, FrequencyRule> = {
  rare: { maxPerDay: 1, minGapMs: 4 * 60 * 60 * 1000 },
  normal: { maxPerDay: 2, minGapMs: 2 * 60 * 60 * 1000 },
  often: { maxPerDay: 4, minGapMs: 60 * 60 * 1000 },
};

const LONG_SESSION_MINUTES = 45;
const RETURN_GAP_MS = 24 * 60 * 60 * 1000;

function parseClock(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 判断本地时间是否在安静时段；跨午夜也支持。 */
export function inQuietHours(now: number, start: string, end: string): boolean {
  const from = parseClock(start);
  const to = parseClock(end);
  if (from === null || to === null || from === to) return false;
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

const TRIGGER_TEXTS: Record<ProactiveTrigger, readonly string[]> = {
  late_night: [
    '还在忙吗？要不要把手上的事收个尾，明天继续。',
    '这个点还在电脑前，今天先到这里也可以。',
    '夜深了，剩下的事记下来，明天再继续吧。',
  ],
  long_session: [
    '这一轮已经有一阵子了，要不要先歇一下？',
    '已经坐了一阵子，起来走两步吧。',
    '先把这一段收个尾，剩下的等会儿再说？',
  ],
  return: [
    '欢迎回来，要继续之前没做完的事吗？',
    '你回来啦，上次那件事还差一点，要接着做吗？',
    '又见面了，之前的事要继续，还是先聊点别的？',
  ],
};

/**
 * 选一句不总是相同的话。
 *
 * 仍然不调用模型：按同一触发类型的历史次数轮换模板；
 * 人味来自“不重复”，不是来自伪造观察。
 */
export function proactiveText(
  trigger: ProactiveTrigger,
  history: readonly ProactiveHistoryEntry[],
): string {
  const list = TRIGGER_TEXTS[trigger];
  const count = history.filter((h) => h.trigger === trigger).length;
  return list[count % list.length] ?? list[0] ?? '还在忙吗？';
}

function triggerText(trigger: ProactiveTrigger, history: readonly ProactiveHistoryEntry[]): string {
  return proactiveText(trigger, history);
}

/**
 * 评估一次主动说话。
 *
 * 优先级：安静时段/开关 > 频率/冷却 > 场景触发。
 * 没有足够使用数据时返回不说 —— 不根据单次心跳编故事。
 */
export function decideProactive(input: ProactiveDecisionInput): ProactiveDecision {
  const { now, config, usage, history } = input;
  if (!config.enabled) return { speak: false, reason: '主动说话已关闭' };
  if (inQuietHours(now, config.quietStart, config.quietEnd)) {
    return { speak: false, reason: '当前处于安静时段' };
  }
  if (input.suppressedUntil !== null && now < input.suppressedUntil) {
    return { speak: false, reason: '用户选择了稍后' };
  }
  if (usage.lastActiveAt === null) {
    return { speak: false, reason: '没有当前使用数据' };
  }
  if (now - usage.lastActiveAt > 15 * 60 * 1000) {
    return { speak: false, reason: '用户当前不在使用' };
  }

  const rule = FREQUENCY_RULES[config.frequency];
  const today = history.filter((h) => sameLocalDay(h.at, now));
  if (today.length >= rule.maxPerDay) {
    return { speak: false, reason: '今天主动说话的次数已到上限' };
  }
  const last = history[history.length - 1];
  if (last !== undefined && now - last.at < rule.minGapMs) {
    return { speak: false, reason: '距离上一次主动说话还太近' };
  }

  const hour = new Date(now).getHours();
  const lateNight = hour >= 23 || hour < 6;
  const longSession = usage.sessionMinutes >= LONG_SESSION_MINUTES;
  const returned =
    usage.previousActiveAt !== null && now - usage.previousActiveAt >= RETURN_GAP_MS;

  let trigger: ProactiveTrigger | null = null;
  if (lateNight && config.scenarios.lateNight) trigger = 'late_night';
  else if (longSession && config.scenarios.longSession) trigger = 'long_session';
  else if (returned && config.scenarios.return) trigger = 'return';

  if (trigger === null) return { speak: false, reason: '当前没有合适的主动场景' };

  return {
    speak: true,
    reason: '命中主动场景',
    trigger,
    text: triggerText(trigger, history),
    cooldownUntil: now + rule.minGapMs,
  };
}
