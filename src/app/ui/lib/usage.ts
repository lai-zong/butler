/**
 * 使用节奏 —— 前端侧的纯逻辑、上报与共享开关
 *
 * ★ 这里**只**处理“本程序页面”的节奏：
 *   页面 id、时间、最近有没有操作。没有任务名、消息、工具、记忆或审查结果，
 *   请求体里也绝不携带它们。
 *
 * ★ 时长、会话、习惯的算法全部在服务端 `core/usage/aggregate.ts`；
 *   前端这里不复制一套口径，只负责按约 60 秒打点、切页立即打点、隐藏即停。
 *
 * ★ 开关（enabled）是一份模块级状态：
 *   设置页/使用节奏页改动后，上报器立刻跟着停/开，不需要整页刷新。
 */

import { ApiError, fetchJson, putJson } from './api.js';
import { clamp } from './format.js';
import type {
  UsagePageId,
  UsagePingResponse,
  UsageResponse,
  UsageSettingsResponse,
} from './types.js';

/** 心跳间隔；对应服务端 `USAGE_PING_WEIGHT_MS`。 */
export const USAGE_PING_INTERVAL_MS = 60_000;

/**
 * “最近有操作”的窗口。
 *
 * 窗口内的心跳计入活跃时长；只是开着但没动过，仍然上报（这样服务端
 * 能算出“在界面前台多久”），但标记 active=false，不计入活跃分钟。
 */
export const USAGE_ACTIVE_WINDOW_MS = 3 * 60_000;

/** 与页面切换打点合并的窗口，避免快速连点把访问次数放大。 */
export const USAGE_SWITCH_COALESCE_MS = 5_000;

/** 服务端以 10 分钟切分“一次使用”；上报的 sessionId 也按同样间隔轮换。 */
export const USAGE_SESSION_GAP_MS = 10 * 60_000;

/** 使用节奏页支持的统计区间（服务端允许 1–30 天）。 */
export const USAGE_RANGE_OPTIONS = [7, 14, 30] as const;

export type UsageRangeDays = (typeof USAGE_RANGE_OPTIONS)[number];

/** 服务端页面 id → 中文名；`pages` 自带 label，这里只兜底。 */
export const USAGE_PAGE_LABEL: Record<UsagePageId, string> = {
  chat: '对话',
  tasks: '定时任务',
  settings: '设置',
  memory: '记忆',
  growth: '演化',
};

// ═══════════════════════════════════════════════════════════
// 展示用的纯函数
// ═══════════════════════════════════════════════════════════

function parseUsageDate(dateKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `2026-11-03` → `周一`；无法解析时返回空串。 */
export function usageWeekday(dateKey: string): string {
  const date = parseUsageDate(dateKey);
  if (date === null) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()] ?? '';
}

/** `2026-11-03` → `11/3`。 */
export function usageMonthDay(dateKey: string): string {
  const date = parseUsageDate(dateKey);
  if (date === null) return dateKey;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 分钟数 → 中文时长；0 也如实显示为 0 分钟。 */
export function formatUsageMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 分钟';
  const total = Math.round(minutes);
  if (total <= 0) return '不到 1 分钟';
  if (total < 60) return `${total} 分钟`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

export interface UsageMinutesParts {
  /** 大号读数，如 `3.7` / `48` */
  readonly value: string;
  /** 单位，如 `小时` / `分钟` */
  readonly unit: string;
  /** 精确描述，如 `3 小时 42 分` */
  readonly exact: string;
}

/** 把分钟拆成“大号数字 + 单位”，给读数位用；不足 1 小时用分钟。 */
export function splitUsageMinutes(minutes: number): UsageMinutesParts {
  const safe = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
  const exact = formatUsageMinutes(safe);
  if (safe < 60) {
    return { value: String(Math.round(safe)), unit: '分钟', exact };
  }
  const hours = safe / 60;
  const value = hours >= 10 ? hours.toFixed(0) : hours.toFixed(1).replace(/\.0$/, '');
  return { value, unit: '小时', exact };
}

/** 习惯置信度：接受 0–1（也容忍 0–100），输出整数百分比。 */
export function usageConfidencePercent(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence <= 0) return 0;
  const ratio = confidence > 1 ? confidence / 100 : confidence;
  return Math.round(clamp(ratio, 0, 1) * 100);
}

/** 最近一次操作是否仍在活跃窗口内。 */
export function isRecentlyActive(
  now: number,
  lastInteractionAt: number,
  windowMs = USAGE_ACTIVE_WINDOW_MS,
): boolean {
  return now - lastInteractionAt <= windowMs;
}

/** 两次打点间隔超过会话阈值（或从未打过点）→ 需要新的 sessionId。 */
export function shouldRotateUsageSession(lastPingAt: number, now: number): boolean {
  return lastPingAt <= 0 || now - lastPingAt > USAGE_SESSION_GAP_MS;
}

/** 柱状图的最大值（至少 1，避免除零）。 */
export function usageChartPeak(daily: readonly { readonly minutes: number }[]): number {
  let peak = 0;
  for (const day of daily) {
    if (Number.isFinite(day.minutes) && day.minutes > peak) peak = day.minutes;
  }
  return Math.max(1, peak);
}

/** 某天的柱高百分比（0–100）；有记录但很短的日子至少留一点可见高度。 */
export function usageBarPercent(minutes: number, peak: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  const ratio = minutes / Math.max(1, peak);
  return Math.min(100, Math.max(3, ratio * 100));
}

/** “11 月 3 日 — 11 月 9 日”；区间为空时返回空串。 */
export function usageRangeLabel(
  daily: readonly { readonly date: string }[],
): string {
  if (daily.length === 0) return '';
  const first = daily[0];
  const last = daily[daily.length - 1];
  if (first === undefined || last === undefined) return '';
  const fmt = (key: string): string => {
    const date = parseUsageDate(key);
    return date === null ? key : `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  };
  return `${fmt(first.date)} — ${fmt(last.date)}`;
}

/** 会话 id 只在本次页面生命周期内使用，不含任何用户信息。 */
export function createUsageSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // 某些旧浏览器会在非安全上下文里抛错；走下面的兜底
  }
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ═══════════════════════════════════════════════════════════
// 接口
// ═══════════════════════════════════════════════════════════

export async function fetchUsage(days: number): Promise<UsageResponse> {
  return fetchJson<UsageResponse>(`/api/usage?days=${days}`);
}

/**
 * 心跳结果：
 *   recorded   已记录
 *   disabled   记录已关闭（服务端拒绝落盘）
 *   unsupported 接口不存在（后端尚未部署）→ 本次页面生命周期不再尝试
 *   failed     网络/其它错误 → 等下一个心跳再说
 */
export type UsagePingResult = 'recorded' | 'disabled' | 'unsupported' | 'failed';

export async function sendUsagePing(
  page: UsagePageId,
  sessionId: string | null,
  active: boolean,
): Promise<UsagePingResult> {
  try {
    const res = await fetchJson<UsagePingResponse>('/api/usage/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page,
        active,
        ...(sessionId !== null ? { sessionId } : {}),
      }),
      // 页面切走时请求也能尽量发完；不含任何内容，体积很小。
      keepalive: true,
    });
    return res.recorded ? 'recorded' : 'disabled';
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
      return 'unsupported';
    }
    return 'failed';
  }
}

/** 改开关；返回服务端确认后的值。 */
export async function saveUsageEnabled(enabled: boolean): Promise<boolean> {
  const res = await putJson<UsageSettingsResponse>('/api/usage/settings', { enabled });
  return res.enabled;
}

/** 清除统计；只删页面心跳，不动会话、记忆、任务与审查。 */
export async function clearUsageStats(): Promise<void> {
  await fetchJson<{ readonly ok: boolean }>('/api/usage', { method: 'DELETE' });
}

// ═══════════════════════════════════════════════════════════
// 共享开关：使用节奏页改动后，上报器立即跟随
// ═══════════════════════════════════════════════════════════

type UsageEnabledListener = (enabled: boolean) => void;

let usageEnabled: boolean | null = null;
const usageEnabledListeners = new Set<UsageEnabledListener>();

export function getUsageEnabled(): boolean | null {
  return usageEnabled;
}

export function setUsageEnabled(next: boolean): void {
  if (usageEnabled === next) return;
  usageEnabled = next;
  for (const listener of usageEnabledListeners) listener(next);
}

export function subscribeUsageEnabled(listener: UsageEnabledListener): () => void {
  usageEnabledListeners.add(listener);
  return () => {
    usageEnabledListeners.delete(listener);
  };
}
