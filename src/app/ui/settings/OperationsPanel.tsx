'use client';

/**
 * 设置 → 操作记忆。
 *
 * ★ 只读：
 *   成功率、尝试次数来自真实工具执行；手改会让"越做越准"变成编造。
 *
 * ★ 默认折叠：
 *   任务文本可能包含路径/文件名；默认只显示摘要，点开才看内容与失败原因。
 *   证据只显示条数，不把事件引用铺开。
 */

import { useCallback, useEffect, useState } from 'react';

import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { errorMessage, fetchJson } from '../lib/api.js';
import {
  formatDuration,
  formatNumber,
  formatPercent,
  relativeTime,
} from '../lib/format.js';
import type {
  OperationKindView,
  OperationsResponse,
} from '../lib/types.js';

const KINDS: readonly { readonly key: OperationKindView; readonly label: string; readonly desc: string }[] = [
  { key: 'method', label: '方法', desc: '这类任务该走哪条路径' },
  { key: 'preference', label: '偏好', desc: '你希望怎么做' },
  { key: 'environment', label: '环境', desc: '这台机器的实际情况' },
];

export function OperationsPanel(): JSX.Element {
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | OperationKindView>('all');
  const [app, setApp] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setData(await fetchJson<OperationsResponse>('/api/operations'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  const operations = data?.operations ?? [];
  const visible = operations.filter(
    (m) => (kind === 'all' || m.kind === kind) && (app === 'all' || m.app === app),
  );

  return (
    <section className="panel settings-panel ops-panel">
      <SectionHeading
        title="操作记忆"
        description="方法 / 偏好 / 环境三类；来自真实工具执行，不是模型自述。"
        actions={
          <div className="ops-actions">
            <Badge tone="accent">{operations.length} 条</Badge>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                setNonce((n) => n + 1);
              }}
            >
              {refreshing ? '刷新中…' : '刷新'}
            </button>
          </div>
        }
      />

      {loading && data === null ? (
        <Skeleton rows={5} height={14} />
      ) : error !== null && data === null ? (
        <InlineError message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : (
        <>
          {error !== null && <p className="ops-error">{error}</p>}

          <div className="ops-summary">
            {KINDS.map((k) => (
              <div key={k.key} className={`ops-sum ops-sum--${k.key}`}>
                <div className="ops-sum-head">
                  <span>{k.label}</span>
                  <span>{k.key.toUpperCase()}</span>
                </div>
                <strong>{formatNumber(data?.counts[k.key] ?? 0)}</strong>
                <p>{k.desc}</p>
              </div>
            ))}
          </div>

          <div className="ops-filters">
            <button
              type="button"
              className={`ops-chip ${kind === 'all' ? 'is-on' : ''}`}
              onClick={() => setKind('all')}
            >
              全部
            </button>
            {KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                className={`ops-chip ${kind === k.key ? 'is-on' : ''}`}
                onClick={() => setKind(k.key)}
              >
                {k.label}
              </button>
            ))}
            <div className="ops-filter-right">
              <span>应用</span>
              <select
                value={app}
                onChange={(e) => setApp(e.target.value)}
                aria-label="按应用筛选"
              >
                <option value="all">全部应用</option>
                {(data?.apps ?? []).map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
              {(kind !== 'all' || app !== 'all') && (
                <button
                  type="button"
                  className="ops-reset"
                  onClick={() => {
                    setKind('all');
                    setApp('all');
                  }}
                >
                  清除
                </button>
              )}
            </div>
          </div>

          {visible.length === 0 ? (
            <p className="ops-empty">
              {operations.length === 0
                ? '还没有操作记忆。桌面/工具任务真实执行后，这里才会出现记录。'
                : '当前筛选下没有记录。'}
            </p>
          ) : (
            <div className="ops-list">
              {visible.map((m) => {
                const open = expanded === m.id;
                return (
                  <article key={m.id} className={`ops-card ${open ? 'is-open' : ''}`}>
                    <button
                      type="button"
                      className="ops-toggle"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : m.id)}
                    >
                      <span className="ops-title">
                        <strong>{m.taskLabel}</strong>
                        <Badge tone={m.kind === 'method' ? 'accent' : 'neutral'}>
                          {m.kindLabel}
                        </Badge>
                        {m.app !== null && <span className="ops-app">{m.app}</span>}
                      </span>
                      <span className="ops-sub">
                        {m.kind === 'method' && m.pathLabel !== null ? (
                          <>
                            <span className="ops-path">{m.pathLabel}</span>
                            {m.effectiveness !== null && (
                              <>
                                <span>
                                  {m.effectiveness.succeeded}/{m.effectiveness.attempts} 成功 ·{' '}
                                  {formatPercent(m.effectiveness.successRate)}
                                </span>
                                <span>平均 {formatDuration(m.effectiveness.avgDurationMs)}</span>
                              </>
                            )}
                            <span>{relativeTime(m.updatedAt, data?.now)}</span>
                          </>
                        ) : (
                          <>
                            <span>{m.content}</span>
                            <span>置信 {formatPercent(m.confidence)}</span>
                            <span>{relativeTime(m.updatedAt, data?.now)}</span>
                          </>
                        )}
                      </span>
                      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                    </button>

                    {m.kind === 'method' && m.effectiveness !== null && (
                      <div className="ops-bar" aria-hidden="true">
                        <span style={{ width: `${Math.round(m.effectiveness.successRate * 100)}%` }} />
                      </div>
                    )}

                    {open && (
                      <div className="ops-detail">
                        {m.kind === 'method' && m.effectiveness !== null ? (
                          <>
                            <DetailCell k="ATTEMPTS" v={`${formatNumber(m.effectiveness.attempts)} 次`} />
                            <DetailCell k="SUCCEEDED" v={`${formatNumber(m.effectiveness.succeeded)} 次`} />
                            <DetailCell k="AVG DURATION" v={formatDuration(m.effectiveness.avgDurationMs)} />
                            <DetailCell k="EVIDENCE" v={`${formatNumber(m.evidenceCount)} 条`} />
                            {m.effectiveness.consecutiveFailures > 0 && (
                              <DetailCell
                                k="CONSECUTIVE FAILURES"
                                v={`${formatNumber(m.effectiveness.consecutiveFailures)} 次`}
                              />
                            )}
                            {m.effectiveness.lastFailure !== null && (
                              <div className="ops-failure">
                                <span>LAST FAILURE</span>
                                <p>{m.effectiveness.lastFailure}</p>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="ops-content">
                              <span>CONTENT</span>
                              <p>{m.content}</p>
                            </div>
                            <DetailCell k="CONFIDENCE" v={formatPercent(m.confidence)} />
                            <DetailCell k="EVIDENCE" v={`${formatNumber(m.evidenceCount)} 条`} />
                            <DetailCell k="UPDATED" v={relativeTime(m.updatedAt, data?.now)} />
                          </>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}

          <p className="ops-note">
            只读：成功率来自真实执行记录，界面不提供手改。任务文本可能含路径，默认折叠，展开才看详情；证据只显示条数。
          </p>
        </>
      )}
    </section>
  );
}

function DetailCell({ k, v }: { readonly k: string; readonly v: string }): JSX.Element {
  return (
    <div className="ops-cell">
      <span>{k}</span>
      <strong className="mono">{v}</strong>
    </div>
  );
}
