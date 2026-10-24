'use client';

/**
 * 设置 → 产出物版本。
 *
 * ★ 只读：
 *   版本内容不可变；回退走检查点，不在这里直接改内容。
 *   被取代的旧版本保留，随时可对比。
 *
 * ★ 默认只看 diff：
 *   长文本先收起；要看完整内容点"查看版本内容"，避免一屏铺满。
 */

import { useCallback, useEffect, useState } from 'react';

import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { errorMessage, fetchJson } from '../lib/api.js';
import {
  formatDateTime,
  formatNumber,
  relativeTime,
} from '../lib/format.js';
import type {
  ArtifactDetailView,
  ArtifactKindView,
  ArtifactRevisionView,
  ArtifactStatusView,
  ArtifactsResponse,
  RevisionDiffView,
} from '../lib/types.js';

const KIND_LABEL: Record<ArtifactKindView, string> = {
  text: '文本',
  list: '清单',
  plan: '计划',
  file: '文件',
  code: '代码',
};

const STATUS_LABEL: Record<ArtifactStatusView, string> = {
  draft: '草稿',
  active: '有效',
  superseded: '已取代',
  discarded: '已丢弃',
};

const STATUS_TONE: Record<ArtifactStatusView, 'accent' | 'neutral' | 'info' | 'danger'> = {
  draft: 'info',
  active: 'accent',
  superseded: 'neutral',
  discarded: 'danger',
};

export function ArtifactsPanel(): JSX.Element {
  const [data, setData] = useState<ArtifactsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArtifactDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [diff, setDiff] = useState<RevisionDiffView | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [showContent, setShowContent] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setData(await fetchJson<ArtifactsResponse>('/api/artifacts'));
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

  useEffect(() => {
    if (expanded === null) {
      setDetail(null);
      setFrom(null);
      setTo(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    setShowContent(false);
    void (async () => {
      try {
        const res = await fetchJson<ArtifactDetailView>(
          `/api/artifacts/${encodeURIComponent(expanded)}`,
        );
        if (cancelled) return;
        setDetail(res);
        const versions = res.revisions.map((r) => r.version);
        setFrom(versions[0] ?? null);
        setTo(versions[versions.length - 1] ?? null);
      } catch (err) {
        if (!cancelled) setDetailError(errorMessage(err));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded]);

  useEffect(() => {
    if (expanded === null || detail === null || from === null || to === null || from === to) {
      setDiff(null);
      setDiffLoading(false);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    void (async () => {
      try {
        const res = await fetchJson<ArtifactDetailView>(
          `/api/artifacts/${encodeURIComponent(expanded)}?from=${from}&to=${to}`,
        );
        if (!cancelled) setDiff(res.diff);
      } catch (err) {
        if (!cancelled) setDiffError(errorMessage(err));
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, from, to, detail]);

  const artifacts = data?.artifacts ?? [];
  const selected = detail?.revisions.find((r) => r.version === to) ?? null;

  const toggle = (id: string): void => {
    setExpanded((cur) => (cur === id ? null : id));
  };

  return (
    <section className="panel settings-panel artifacts-panel">
      <SectionHeading
        title="产出物版本"
        description="被取代的旧版本不删除；可以翻出任意两版看差别。"
        actions={
          <div className="artifacts-actions">
            <Badge tone="accent">{artifacts.length} 个产出物</Badge>
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
        <Skeleton rows={4} height={14} />
      ) : error !== null && data === null ? (
        <InlineError message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : (
        <>
          {error !== null && <p className="artifacts-error">{error}</p>}

          {artifacts.length === 0 ? (
            <p className="artifacts-empty">
              还没有产出物。任务生成方案、清单或文件后，这里才会出现记录。
            </p>
          ) : (
            <div className="artifacts-list">
              {artifacts.map((a) => {
                const open = expanded === a.id;
                return (
                  <article key={a.id} className={`artifact-card ${open ? 'is-open' : ''}`}>
                    <button
                      type="button"
                      className="artifact-head"
                      aria-expanded={open}
                      onClick={() => toggle(a.id)}
                    >
                      <span className="artifact-title">
                        <strong>{a.label}</strong>
                        <Badge tone="neutral">{KIND_LABEL[a.kind]}</Badge>
                        <Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
                      </span>
                      <span className="artifact-meta">
                        <span>v{formatNumber(a.currentVersion)}</span>
                        <span>{formatNumber(a.revisionCount)} 个版本</span>
                        <span>{relativeTime(a.updatedAt)}</span>
                      </span>
                      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                    </button>

                    {open && (
                      <div className="artifact-detail">
                        {detailLoading ? (
                          <Skeleton rows={2} height={12} />
                        ) : detailError !== null ? (
                          <InlineError message={detailError} />
                        ) : detail !== null ? (
                          <>
                            <div className="artifact-versions">
                              <label>
                                起始版本
                                <select
                                  value={from ?? ''}
                                  onChange={(e) => {
                                    setFrom(Number(e.target.value));
                                    setShowContent(false);
                                  }}
                                >
                                  {detail.revisions.map((r) => (
                                    <option key={r.version} value={r.version}>v{r.version}</option>
                                  ))}
                                </select>
                              </label>
                              <span aria-hidden="true">→</span>
                              <label>
                                目标版本
                                <select
                                  value={to ?? ''}
                                  onChange={(e) => {
                                    setTo(Number(e.target.value));
                                    setShowContent(false);
                                  }}
                                >
                                  {detail.revisions.map((r) => (
                                    <option key={r.version} value={r.version}>v{r.version}</option>
                                  ))}
                                </select>
                              </label>
                              <span className="artifact-version-hint">
                                {detail.revisions.length} 个版本 · 旧版本保留
                              </span>
                            </div>

                            {from === to ? (
                              <p className="artifact-note">起始与目标是同一版；换一版再比。</p>
                            ) : diffLoading ? (
                              <Skeleton rows={2} height={12} />
                            ) : diffError !== null ? (
                              <InlineError message={diffError} />
                            ) : diff !== null ? (
                              <div className="artifact-diff">
                                <div>
                                  <h5>新增 / ADDED</h5>
                                  {diff.addedLines.length === 0 ? (
                                    <p className="artifact-diff-empty">没有新增行</p>
                                  ) : (
                                    <ul>
                                      {diff.addedLines.map((line) => (
                                        <li key={`a-${line}`} className="is-add">{line}</li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                                <div>
                                  <h5>移除 / REMOVED</h5>
                                  {diff.removedLines.length === 0 ? (
                                    <p className="artifact-diff-empty">没有移除行</p>
                                  ) : (
                                    <ul>
                                      {diff.removedLines.map((line) => (
                                        <li key={`r-${line}`} className="is-del">{line}</li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </div>
                            ) : null}

                            <div className="artifact-content-bar">
                              <span>
                                目标版本 v{to ?? '—'}
                                {selected !== null && (
                                  <> · {selected.reason} · {formatDateTime(selected.createdAt)}</>
                                )}
                              </span>
                              <button
                                type="button"
                                className="text-btn"
                                onClick={() => setShowContent((v) => !v)}
                                disabled={selected === null}
                              >
                                {showContent ? '收起内容' : '查看版本内容'}
                              </button>
                            </div>

                            {showContent && selected !== null && (
                              <div className="artifact-content">
                                {selected.items !== undefined ? (
                                  <ul>
                                    {selected.items.map((item) => <li key={item}>{item}</li>)}
                                  </ul>
                                ) : (
                                  <pre>{selected.content}</pre>
                                )}
                                <p>
                                  作者 {AUTHOR_LABEL[selected.author]} · 证据 {selected.producedBy.length} 条
                                </p>
                              </div>
                            )}
                          </>
                        ) : null}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}

          <p className="artifacts-note">
            只读：版本内容不可变；回退走检查点，不在这里直接改内容。被取代的旧版本保留，可随时对比；
            默认只看 diff，完整内容按需展开。
          </p>
        </>
      )}
    </section>
  );
}

const AUTHOR_LABEL: Record<ArtifactRevisionView['author'], string> = {
  servant: 'servant',
  butler: 'butler',
  user: 'user',
};
