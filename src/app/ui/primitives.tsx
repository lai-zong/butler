/**
 * 基础排版组件（**服务端可用**，不带 'use client'）
 *
 * ★ 只做排版，不做业务：页面拼装时用它们保持一致的间距与层级。
 *   全部是纯展示，所以不需要客户端边界。
 */

import type { ReactNode } from 'react';

export function Page({
  title,
  desc,
  children,
}: {
  readonly title: string;
  readonly desc?: string;
  readonly children: ReactNode;
}): React.ReactElement {
  return (
    <div className="page">
      <header className="page-head">
        <h1>{title}</h1>
        {desc !== undefined && <p>{desc}</p>}
      </header>
      {children}
    </div>
  );
}

export function Section({
  title,
  count,
  hint,
  children,
}: {
  readonly title: string;
  readonly count?: number | undefined;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}): React.ReactElement {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="count">{count}</span>}
        {hint !== undefined && <span className="hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function Stat({
  k,
  v,
  u,
}: {
  readonly k: string;
  readonly v: string | number;
  readonly u?: string;
}): React.ReactElement {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {u !== undefined && <div className="u">{u}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone,
}: {
  readonly children: ReactNode;
  readonly tone?: 'accent' | 'warn' | 'ok' | 'danger' | undefined;
}): React.ReactElement {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function Empty({ children }: { readonly children: ReactNode }): React.ReactElement {
  return <div className="empty">{children}</div>;
}

export function Bars({
  items,
}: {
  readonly items: readonly { readonly label: string; readonly value: number; readonly text: string }[];
}): React.ReactElement {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="bars">
      {items.map((i) => (
        <div className="line" key={i.label}>
          <span className="label">{i.label}</span>
          <span className="bar">
            <i style={{ width: `${Math.round((i.value / max) * 100)}%` }} />
          </span>
          <span className="num">{i.text}</span>
        </div>
      ))}
    </div>
  );
}

export function KV({ rows }: { readonly rows: readonly (readonly [string, ReactNode])[] }): React.ReactElement {
  return (
    <div>
      {rows.map(([k, v], idx) => (
        <div className="kv" key={`${k}-${String(idx)}`}>
          <span className="k">{k}</span>
          <span className="v">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** 把毫秒时长写成人话 */
export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
}

/** 把时间戳写成"今天 14:32 / 10-18 14:32" */
export function clockText(ts: number): string {
  if (ts <= 0) return '—';
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}

