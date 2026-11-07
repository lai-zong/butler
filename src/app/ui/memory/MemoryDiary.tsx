'use client';

/**
 * 记忆日记 —— 文本列表里的第二种读法。
 *
 * ★ 日记不是记忆节点，而是当天经历的可重放摘要；
 *   从日记提取出来的记忆，才进入星图和文本列表。
 *
 * ★ 这一页只读：删除与治理仍然在记忆详情里，不在日记正文里做。
 */

import { useEffect, useMemo, useState } from 'react';

import { Icon } from '../components/Icon';
import { errorMessage, fetchJson } from '../lib/api.js';
import type { ViewId } from '../lib/types.js';
import type { StarNode } from './starMap.js';

interface DiaryItem {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly rationale?: string;
}

interface DiaryEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly dayKey: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly content: string;
  readonly items: readonly DiaryItem[];
  readonly sourceMessageIds: readonly string[];
  readonly model: string;
  readonly createdAt: number;
}

interface DiaryResponse {
  readonly ok: boolean;
  readonly items?: readonly DiaryEntry[];
  readonly total?: number;
  readonly error?: string;
}

interface MemoryDiaryProps {
  readonly nodes: readonly StarNode[];
  readonly onSelect: (id: string) => void;
  readonly onNavigate: (view: ViewId) => void;
}

const KIND_LABEL: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  principle: '原则',
};

function formatDay(dayKey: string): string {
  const parts = dayKey.split('-').map((part) => Number(part));
  const year = parts[0] ?? Number.NaN;
  const month = parts[1] ?? Number.NaN;
  const day = parts[2] ?? Number.NaN;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return dayKey;
  }
  const date = new Date(year, month - 1, day, 12);
  return `${month} 月 ${day} 日 · ${new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)}`;
}

function excerpt(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

export function MemoryDiary({ nodes, onSelect, onNavigate }: MemoryDiaryProps): JSX.Element {
  const [items, setItems] = useState<readonly DiaryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetchJson<DiaryResponse>('/api/diary');
        if (cancelled) return;
        const next = response.items ?? [];
        setItems(next);
        setSelectedId((current) => {
          if (current !== null && next.some((item) => item.id === current)) return current;
          return next[0]?.id ?? null;
        });
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  );

  if (loading) {
    return (
      <div className="mm-diary-state" aria-live="polite">
        <span className="mm-diary-spinner" aria-hidden="true" />
        <p>正在读取日记…</p>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="mm-diary-state is-error" role="alert">
        <Icon name="alert" size={18} />
        <p>读取日记失败：{error}</p>
        <button type="button" className="mm-btn" onClick={() => setNonce((value) => value + 1)}>
          重试
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="mm-diary-state is-empty">
        <span className="mm-diary-empty-mark" aria-hidden="true">
          <Icon name="memory" size={20} />
        </span>
        <h2>还没有日记</h2>
        <p>
          每天 04:10 会整理前一天的经历。当天不足 4 条用户消息，或记忆模型尚未配置时，
          不会生成日记。
        </p>
        <button type="button" className="mm-btn" onClick={() => onNavigate('chat')}>
          去对话
        </button>
      </div>
    );
  }

  return (
    <div className="mm-diary">
      <aside className="mm-diary-dates" aria-label="日记日期">
        <div className="mm-diary-dates-head">
          <span>最近日记</span>
          <em className="mono">{items.length}</em>
        </div>
        <div className="mm-diary-date-list">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`mm-diary-date${item.id === selected?.id ? ' is-active' : ''}`}
              aria-pressed={item.id === selected?.id}
              onClick={() => setSelectedId(item.id)}
            >
              <span className="mm-diary-date-day mono">{formatDay(item.dayKey)}</span>
              <span className="mm-diary-date-excerpt">{excerpt(item.content, 34)}</span>
              <span className="mm-diary-date-count mono">
                {item.items.length} 条记忆 · {item.sourceMessageIds.length} 条消息
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="mm-diary-body">
        {selected === null ? null : (
          <>
            <header className="mm-diary-head">
              <p className="mm-eyebrow mono">DIARY / {selected.dayKey}</p>
              <h2>{formatDay(selected.dayKey)}</h2>
              <p className="mm-diary-sub">
                {selected.sourceMessageIds.length} 条消息整理 · {selected.items.length} 条记忆
              </p>
            </header>

            <p className="mm-diary-content">{selected.content}</p>

            <section className="mm-diary-extracted" aria-label="从这篇日记提取的记忆">
              <div className="mm-diary-section-head">
                <span className="mono">EXTRACTED</span>
                <h3>从这篇日记提取</h3>
              </div>
              {selected.items.length === 0 ? (
                <p className="mm-diary-muted">这篇日记没有提取出可长期保留的记忆。</p>
              ) : (
                <ul className="mm-diary-items">
                  {selected.items.map((item) => {
                    const memory =
                      nodes.find((node) => node.item.content === item.content) ??
                      nodes.find((node) => node.item.content.startsWith(item.content.slice(0, 24))) ??
                      null;
                    return (
                      <li key={item.id} className="mm-diary-item">
                        <div className="mm-diary-item-main">
                          <p>{item.content}</p>
                          <div className="mm-diary-item-meta mono">
                            <span>{KIND_LABEL[item.kind] ?? item.kind}</span>
                            <span>置信 {Math.round(item.confidence * 100)}%</span>
                            {memory !== null && <span>{memory.item.lifecycleLabel}</span>}
                          </div>
                        </div>
                        {memory === null ? (
                          <span className="mm-diary-unmatched">未进入当前记忆视图</span>
                        ) : (
                          <button
                            type="button"
                            className="mm-diary-open"
                            onClick={() => onSelect(memory.id)}
                          >
                            查看记忆
                            <Icon name="chevronRight" size={12} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
