/**
 * 界面格式化 —— 纯函数，不依赖 React
 *
 * ★ 时间与数字的呈现统一在这里：
 *   如果每个组件各写一份“几分钟前”，同一个界面里会出现三种说法。
 */

import type { MemoryClass, MemoryKind, MemoryLifecycle } from './types.js';

export const KIND_LABEL: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  principle: '原则',
  summary: '长期状态',
};

export const CLASS_LABEL: Record<MemoryClass, string> = {
  global_constraint: '硬约束',
  global_shared: '共享事实',
  sensitive: '敏感域',
  domain: '领域记忆',
};

export const LIFECYCLE_LABEL: Record<MemoryLifecycle, string> = {
  candidate: '试行',
  active: '活跃',
  dormant: '休眠',
  archived: '归档',
};

export const DOMAIN_LABEL: Record<string, string> = {
  life: '生活',
  health: '健康',
  study: '学习',
  work: '办公',
  code: '代码',
  butler: '管家',
};

export const TIER_LABEL: Record<string, string> = {
  readOnly: '只读',
  normal: '普通',
  highRisk: '高风险',
  dangerous: '危险',
};

export function domainLabel(id: string | null | undefined): string {
  if (id === null || id === undefined || id.length === 0) return '全局';
  return DOMAIN_LABEL[id] ?? id;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

export function formatPercent(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function formatUptime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '刚启动';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function formatDateFull(ts: number): string {
  const d = new Date(ts);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] ?? '';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${week}`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')} ${formatClock(ts)}`;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) return '刚刚';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2 * 24 * 60 * 60_000) return '昨天';
  if (diff < 7 * 24 * 60 * 60_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  if (diff < 30 * 24 * 60 * 60_000) return `${Math.floor(diff / (7 * 86_400_000))} 周前`;
  return formatDate(ts);
}

export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  if (h < 23) return '晚上好';
  return '夜深了';
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 去掉 markdown 记号，用于列表摘要。 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shortId(id: string, head = 10): string {
  return id.length > head ? `${id.slice(0, head)}…` : id;
}

/** 适应度的语义色：低 → 暖灰，高 → 墨绿。 */
export function fitnessTone(fitness: number): 'low' | 'mid' | 'high' {
  if (fitness >= 0.7) return 'high';
  if (fitness >= 0.4) return 'mid';
  return 'low';
}

export function lifecycleTone(lifecycle: MemoryLifecycle): 'candidate' | 'active' | 'dormant' | 'archived' {
  return lifecycle;
}

export function plurals(n: number, unit: string): string {
  return `${formatNumber(n)} ${unit}`;
}

export function todayRange(now = new Date()): { readonly start: number; readonly label: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { start, label: formatDateFull(now.getTime()) };
}
