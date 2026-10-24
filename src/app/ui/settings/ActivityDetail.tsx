'use client';

/**
 * 设置 → 隐私与行为观察 → 明细
 *
 * 只展示已经落盘的数据；删除会写事件，重启后不会“复活”。
 * 原始记录与聚合来自 ActivityObserver 的事件回放；规律来自 pattern.derived。
 */

import { useCallback, useEffect, useState } from 'react';

import { Badge, InlineError, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson } from '../lib/api.js';
import { formatDateTime, formatDuration, formatNumber, formatPercent } from '../lib/format.js';
import type { ActivityDetailResponse, ToastMessage } from '../lib/types.js';

const SOURCE_LABEL: Record<ActivityDetailResponse['raw'][number]['source'], string> = {
  sample: '采样',
  session: '会话',
  demo: '演示',
};

interface ActivityDetailProps {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}

export function ActivityDetail({ notify }: ActivityDetailProps): JSX.Element {
  const [data, setData] = useState<ActivityDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchJson<ActivityDetailResponse>('/api/activity'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteRecord = async (id: string): Promise<void> => {
    setDeleting(id);
    setError(null);
    try {
      const res = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(`删除失败（HTTP ${res.status}）`);
      notify('已删除这条原始记录', 'success');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDeleting(null);
    }
  };

  const clearAll = async (): Promise<void> => {
    setClearing(true);
    setError(null);
    try {
      const res = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`清除失败（HTTP ${res.status}）`);
      const body = (await res.json()) as {
        readonly deletedRecords?: number;
        readonly deletedAggregates?: number;
        readonly deletedPatterns?: number;
      };
      notify(
        `已清除 ${formatNumber(body.deletedRecords ?? 0)} 条原始记录、` +
          `${formatNumber(body.deletedAggregates ?? 0)} 条聚合、` +
          `${formatNumber(body.deletedPatterns ?? 0)} 条规律`,
        'success',
      );
      setClearOpen(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setClearing(false);
    }
  };

  if (loading && data === null) return <Skeleton rows={3} height={14} />;
  if (error !== null && data === null) return <InlineError message={error} onRetry={() => void load()} />;
  if (data === null) return <p className="activity-empty">暂时读不到观察数据。</p>;

  if (!data.consent.granted) {
    return (
      <div className="activity-detail">
        <p className="activity-empty">
          还没有同意采集。开启后这里才会出现原始记录、聚合与规律。
        </p>
      </div>
    );
  }

  const shownRaw = data.raw.slice(0, 30);

  return (
    <div className="activity-detail">
      <div className="activity-detail-head">
        <div>
          <p className="mini-label">观察明细</p>
          <span className="activity-counts">
            原始 {formatNumber(data.raw.length)} · 聚合 {formatNumber(data.aggregates.length)} · 规律{' '}
            {formatNumber(data.patterns.length)}
          </span>
        </div>
        <div className="activity-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            <Icon name="refresh" size={13} /> 刷新
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClearOpen(true)}>
            <Icon name="trash" size={13} /> 全部清除
          </button>
        </div>
      </div>

      {error !== null && <p className="activity-error">{error}</p>}

      <section className="activity-block">
        <h4>原始记录</h4>
        {data.raw.length === 0 ? (
          <p className="activity-empty">还没有原始记录。</p>
        ) : (
          <ul className="activity-raw-list">
            {shownRaw.map((r) => (
              <li key={r.id}>
                <span className="activity-time mono">{formatDateTime(r.startedAt).slice(5, 16)}</span>
                <strong>{r.app}</strong>
                <Badge tone="neutral">{r.categoryLabel}</Badge>
                <span className="activity-meta mono">
                  {formatDuration(r.durationMs)} · {SOURCE_LABEL[r.source]}
                  {r.hadInput ? ' · 有输入' : ''}
                </span>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  aria-label={`删除 ${r.app} 这条记录`}
                  disabled={deleting !== null}
                  onClick={() => void deleteRecord(r.id)}
                >
                  <Icon name="trash" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {data.raw.length > shownRaw.length && (
          <p className="activity-note">只显示最近 {shownRaw.length} 条；更早的记录仍保存在本地。</p>
        )}
      </section>

      <section className="activity-block">
        <h4>聚合结果</h4>
        {data.aggregates.length === 0 ? (
          <p className="activity-empty">还没有聚合结果；每小时聚合任务运行后出现。</p>
        ) : (
          <ul className="activity-agg-list">
            {[...data.aggregates]
              .sort((a, b) => b.bucket.localeCompare(a.bucket))
              .slice(0, 14)
              .map((a) => (
                <li key={a.id}>
                  <span className="mono">{a.bucket.replace('T', ' ')}:00</span>
                  <span>{a.category}</span>
                  <span className="mono">{a.minutes} 分钟</span>
                  <span className="activity-apps">{a.topApps.join('、') || '—'}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className="activity-block">
        <h4>时间规律</h4>
        {data.patterns.length === 0 ? (
          <p className="activity-empty">观察天数不足，还没有稳定规律。</p>
        ) : (
          <ul className="activity-pattern-list">
            {data.patterns.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>{p.pattern}</strong>
                  <span className="activity-meta">
                    观察 {p.observedDays} 天 · 置信度 {formatPercent(p.confidence)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="activity-note">
        不采集窗口标题、网页地址、文件路径或输入内容；原始记录到期自动清除，长期只保留聚合与规律。
      </p>

      <Modal
        open={clearOpen}
        onClose={() => {
          if (!clearing) setClearOpen(false);
        }}
        title="清除全部行为观察数据？"
        description="原始记录、聚合结果和时间规律都会被清除；这条清除动作会留在事件流里。"
        footer={
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" disabled={clearing} onClick={() => setClearOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn-danger" disabled={clearing} onClick={() => void clearAll()}>
              {clearing ? '清除中…' : '确认清除'}
            </button>
          </div>
        }
      >
        <p className="activity-empty">
          共 {formatNumber(data.raw.length)} 条原始记录、{formatNumber(data.aggregates.length)} 条聚合、
          {formatNumber(data.patterns.length)} 条规律。
        </p>
      </Modal>
    </div>
  );
}
