'use client';

/**
 * 小组件 —— 排版与状态的基本积木
 *
 * ★ 这里的每一个都只做一件事，且不感知业务：
 *   PageHeader / StatCard / Meter / Chip / EmptyState / Skeleton…
 *   业务视图用它们拼装，换页面时视觉不会散。
 */

import type { ReactNode } from 'react';

import { useCountUp } from '../lib/hooks.js';
import { clamp } from '../lib/format.js';
import { Icon, type IconName } from './Icon';

// ═══════════════════════════════════════════════════════════
// 页头
// ═══════════════════════════════════════════════════════════

interface PageHeaderProps {
  readonly eyebrow?: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps): JSX.Element {
  return (
    <header className="page-head">
      <div className="page-head-main">
        {eyebrow !== undefined && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="page-title">{title}</h1>
        {description !== undefined && <p className="page-desc">{description}</p>}
      </div>
      {actions !== undefined && <div className="page-head-actions">{actions}</div>}
    </header>
  );
}

// ═══════════════════════════════════════════════════════════
// 数字卡
// ═══════════════════════════════════════════════════════════

type StatTone = 'default' | 'accent' | 'warn' | 'danger';

interface StatCardProps {
  readonly label: string;
  readonly value: number | string;
  readonly suffix?: string;
  readonly note?: ReactNode;
  readonly icon?: IconName;
  readonly tone?: StatTone;
  readonly decimals?: number;
  readonly onClick?: () => void;
  /** 传 false 时显示原始值（百分比等已格式化字符串） */
  readonly animate?: boolean;
}

export function StatCard({
  label,
  value,
  suffix,
  note,
  icon,
  tone = 'default',
  decimals = 0,
  onClick,
  animate = true,
}: StatCardProps): JSX.Element {
  const numeric = typeof value === 'number';
  const animated = useCountUp(numeric && animate ? value : 0);
  const shown = numeric
    ? animate
      ? decimals > 0
        ? animated.toFixed(decimals)
        : Math.round(animated).toLocaleString('zh-CN')
      : decimals > 0
        ? value.toFixed(decimals)
        : value.toLocaleString('zh-CN')
    : value;

  const inner = (
    <>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon !== undefined && (
          <span className={`stat-icon stat-icon--${tone}`}>
            <Icon name={icon} size={16} />
          </span>
        )}
      </div>
      <div className="stat-value">
        <span>{shown}</span>
        {suffix !== undefined && <small>{suffix}</small>}
      </div>
      {note !== undefined && <div className="stat-note">{note}</div>}
    </>
  );

  if (onClick !== undefined) {
    return (
      <button type="button" className={`stat-card stat-card--${tone} is-clickable`} onClick={onClick}>
        {inner}
      </button>
    );
  }

  return <div className={`stat-card stat-card--${tone}`}>{inner}</div>;
}

// ═══════════════════════════════════════════════════════════
// 标签 / 过滤
// ═══════════════════════════════════════════════════════════

type BadgeTone = 'neutral' | 'accent' | 'warn' | 'danger' | 'info' | 'outline';

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
  readonly title?: string;
}): JSX.Element {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

interface FilterChipProps {
  readonly children: ReactNode;
  readonly active?: boolean;
  readonly count?: number | undefined;
  readonly onClick?: () => void;
  readonly title?: string;
}

export function FilterChip({ children, active = false, count, onClick, title }: FilterChipProps): JSX.Element {
  return (
    <button
      type="button"
      className={`filter-chip ${active ? 'is-active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
      title={title}
    >
      <span>{children}</span>
      {count !== undefined && <span className="filter-chip-count">{count}</span>}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════
// 进度条
// ═══════════════════════════════════════════════════════════

type MeterTone = 'accent' | 'warn' | 'danger' | 'muted';

export function Meter({
  value,
  tone = 'accent',
  label,
  showValue = false,
}: {
  readonly value: number;
  readonly tone?: MeterTone;
  readonly label?: string;
  readonly showValue?: boolean;
}): JSX.Element {
  const pct = clamp(value, 0, 1) * 100;
  return (
    <div className="meter-wrap">
      {(label !== undefined || showValue) && (
        <div className="meter-meta">
          {label !== undefined && <span>{label}</span>}
          {showValue && <span className="mono">{Math.round(pct)}%</span>}
        </div>
      )}
      <div className={`meter meter--${tone}`} role="presentation">
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 空状态 / 加载 / 错误
// ═══════════════════════════════════════════════════════════

export function EmptyState({
  icon = 'sparkle',
  title,
  description,
  action,
  compact = false,
}: {
  readonly icon?: IconName;
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly compact?: boolean;
}): JSX.Element {
  return (
    <div className={`empty-state ${compact ? 'is-compact' : ''}`}>
      <span className="empty-icon">
        <Icon name={icon} size={compact ? 20 : 24} />
      </span>
      <h3>{title}</h3>
      {description !== undefined && <p>{description}</p>}
      {action !== undefined && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Skeleton({
  rows = 3,
  height = 16,
  className = '',
}: {
  readonly rows?: number;
  readonly height?: number;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={`skeleton-group ${className}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span
          key={i}
          className="skeleton"
          style={{ height, width: i === rows - 1 ? '62%' : '100%' }}
        />
      ))}
    </div>
  );
}

export function InlineError({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="inline-error" role="alert">
      <span className="inline-error-icon">
        <Icon name="alert" size={17} />
      </span>
      <span>{message}</span>
      {onRetry !== undefined && (
        <button type="button" className="text-btn" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 其它
// ═══════════════════════════════════════════════════════════

export function SectionHeading({
  title,
  description,
  actions,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description !== undefined && <p>{description}</p>}
      </div>
      {actions !== undefined && <div className="section-actions">{actions}</div>}
    </div>
  );
}

export function Collapse({
  open,
  children,
  className = '',
}: {
  readonly open: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={`collapse ${open ? 'is-open' : ''} ${className}`}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}

export function Kbd({ children }: { readonly children: ReactNode }): JSX.Element {
  return <kbd className="kbd">{children}</kbd>;
}
