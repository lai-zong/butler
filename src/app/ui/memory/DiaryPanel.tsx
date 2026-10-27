'use client';

/**
 * 日记视图 —— 看“当天发生了什么”，以及从日记里沉淀了哪些记忆候选。
 *
 * ★ 日记不是记忆节点，也不是可编辑文档；
 *   这是只读的经历摘要，修改/删除走记忆治理，不在日记里做。
 */

import { useEffect, useState } from 'react';

import { EmptyState, InlineError, PageHeader, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { fetchJson } from '../lib/api.js';
import { formatDateTime, truncate } from '../lib/format.js';

export interface DiaryItemView {
  readonly id: string;
  readonly kind: 'fact' | 'preference' | 'principle';
  readonly content: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly rationale?: string;
}

export interface DiaryViewItem {
  readonly id: string;
  readonly sessionId: string;
  readonly dayKey: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly content: string;
  readonly items: readonly DiaryItemView[];
  readonly sourceMessageIds: readonly string[];
  readonly model: string;
  readonly createdAt: number;
}

interface DiaryResponse {
  readonly ok: boolean;
  readonly items?: readonly DiaryViewItem[];
  readonly error?: string;
}

export function DiaryPanel({ onBack }: { readonly onBack: () => void }): JSX.Element {
  const [items, setItems] = useState<readonly DiaryViewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson<DiaryResponse>('/api/diary')
      .then((r) => {
        if (cancelled) return;
        setItems(r.items ?? []);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '读取日记失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page diary-page">
      <PageHeader
        eyebrow="MEMORY / DIARY"
        title="日记"
        description="每天一篇经历摘要。记忆条目从日记里提取，日记本身不是记忆节点。"
        actions={
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            <Icon name="arrowLeft" size={15} /> 返回记忆
          </button>
        }
      />

      {loading && (
        <div className="diary-stack">
          <Skeleton height={150} />
          <Skeleton height={150} />
        </div>
      )}

      {!loading && error !== null && <InlineError message={error} />}

      {!loading && error === null && items.length === 0 && (
        <EmptyState
          icon="quote"
          title="还没有日记"
          description="每个活跃作用域每天最多生成一篇；没有足够内容的日期不会生成空日记。"
        />
      )}

      {!loading && error === null && items.length > 0 && (
        <div className="diary-stack">
          {items.map((d) => (
            <article className="diary-card" key={d.id}>
              <header className="diary-card-head">
                <div>
                  <p className="diary-day">{d.dayKey}</p>
                  <p className="diary-meta">
                    {formatDateTime(d.startAt)} — {formatDateTime(d.endAt)}
                    <span>·</span>
                    {d.sourceMessageIds.length} 条来源消息
                  </p>
                </div>
                <span className="diary-count">{d.items.length} 条提取</span>
              </header>

              <div className="diary-body">
                {d.content.split(/\n{2,}/).map((p, i) => (
                  <p key={`${d.id}_p${i}`}>{p}</p>
                ))}
              </div>

              {d.items.length > 0 && (
                <div className="diary-items">
                  <p className="diary-items-title">从这一天提取</p>
                  {d.items.map((item) => (
                    <div className="diary-item" key={item.id}>
                      <span className="diary-item-kind">{item.kind}</span>
                      <span className="diary-item-text">{truncate(item.content, 160)}</span>
                      <span className="diary-item-confidence">
                        {Math.round(item.confidence * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
