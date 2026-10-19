'use client';

/**
 * 审计空间 —— 把“凭什么”摊开
 *
 * 两个视图：
 *   · 依据：召回 / 约束注入 / 硬拦截 / 授权 / 越权尝试（人话）
 *   · 事件流：原始事实（可按族筛选、按 seq 看完整 payload）
 *
 * ★ 设计上刻意把“结论”和“原文”分开：
 *   先给人能读的摘要，想看证据时再追到那条事件。
 *   一上来铺 JSON 不叫可审计，叫把负担丢给用户。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Badge,
  Collapse,
  EmptyState,
  FilterChip,
  InlineError,
  PageHeader,
  SectionHeading,
  Skeleton,
  StatCard,
} from '../components/Common';
import { Icon } from '../components/Icon';
import { errorMessage, fetchJson } from '../lib/api.js';
import {
  formatDateTime,
  formatNumber,
  formatPercent,
  relativeTime,
} from '../lib/format.js';
import type {
  AuditResponse,
  EventItem,
  EventsResponse,
  RawEvent,
  ToastMessage,
  TurnAudit,
  MemoryTarget,
} from '../lib/types.js';

interface AuditViewProps {
  readonly range: { readonly fromSeq: number; readonly toSeq: number } | null;
  readonly onClearRange: () => void;
  readonly onOpenMemory: (opts?: MemoryTarget) => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}

type Tab = 'evidence' | 'events';

const FAMILIES: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'memoryLifecycle', label: '记忆' },
  { value: 'execution', label: '执行' },
  { value: 'supervision', label: '监督' },
  { value: 'memoryPartition', label: '分权' },
  { value: 'evolution', label: '演化' },
  { value: 'reflection', label: '反思' },
  { value: 'reasoning', label: '推理与工具' },
  { value: 'context', label: '上下文' },
  { value: 'chat', label: '会话' },
  { value: 'lifecycle', label: '安全与生命周期' },
  { value: 'mcp', label: 'MCP' },
  { value: 'legacy', label: '历史' },
];

const GRANT_TONE: Record<string, 'accent' | 'warn' | 'danger' | 'neutral'> = {
  requested: 'neutral',
  approved: 'accent',
  denied: 'danger',
  used: 'accent',
  expired: 'warn',
};

export function AuditView({
  range,
  onClearRange,
  onOpenMemory,
  notify,
}: AuditViewProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('evidence');
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState<string | null>(null);

  const [events, setEvents] = useState<readonly EventItem[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventTotal, setEventTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [family, setFamily] = useState('all');
  const [eventQuery, setEventQuery] = useState('');
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  const [rawEvents, setRawEvents] = useState<Record<number, RawEvent>>({});
  const [rawLoading, setRawLoading] = useState<number | null>(null);

  const nextBeforeRef = useRef<number | null>(null);

  const loadAudit = useCallback(async (): Promise<void> => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const url =
        range !== null ? `/api/audit?from=${range.fromSeq}&to=${range.toSeq}` : '/api/audit';
      const res = await fetchJson<AuditResponse>(url);
      setAudit(res);
    } catch (err) {
      setAuditError(errorMessage(err));
    } finally {
      setAuditLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  const loadEvents = useCallback(
    async (mode: 'replace' | 'append'): Promise<void> => {
      setEventsLoading(true);
      setEventsError(null);
      const sp = new URLSearchParams();
      if (family !== 'all') sp.set('family', family);
      if (eventQuery.trim().length > 0) sp.set('q', eventQuery.trim());
      sp.set('limit', '60');
      if (mode === 'append' && nextBeforeRef.current !== null) {
        sp.set('before', String(nextBeforeRef.current));
      }
      try {
        const res = await fetchJson<EventsResponse>(`/api/events?${sp.toString()}`);
        setEvents((prev) => (mode === 'append' ? [...prev, ...res.items] : res.items));
        setEventTotal(res.total);
        setHasMore(res.hasMore);
        nextBeforeRef.current = res.nextBefore;
      } catch (err) {
        setEventsError(errorMessage(err));
      } finally {
        setEventsLoading(false);
      }
    },
    [family, eventQuery],
  );

  useEffect(() => {
    if (tab !== 'events') return;
    const timer = window.setTimeout(() => {
      nextBeforeRef.current = null;
      void loadEvents('replace');
    }, eventQuery.trim().length > 0 ? 260 : 0);
    return () => window.clearTimeout(timer);
  }, [tab, family, eventQuery, loadEvents]);

  async function toggleEvent(seq: number): Promise<void> {
    if (expandedSeq === seq) {
      setExpandedSeq(null);
      return;
    }
    setExpandedSeq(seq);
    if (rawEvents[seq] !== undefined) return;
    setRawLoading(seq);
    try {
      const res = await fetchJson<{ readonly ok: boolean; readonly event: RawEvent }>(
        `/api/events?seq=${seq}`,
      );
      setRawEvents((prev) => ({ ...prev, [seq]: res.event }));
    } catch (err) {
      notify(errorMessage(err), 'danger');
    } finally {
      setRawLoading(null);
    }
  }

  async function copyJson(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(audit?.audit ?? {}, null, 2));
      notify('已复制审计 JSON', 'success');
    } catch {
      notify('复制失败', 'warning');
    }
  }

  const a: TurnAudit | null = audit?.audit ?? null;
  const recalls = a?.recalls.reduce((n, r) => n + r.count, 0) ?? 0;
  const injections = a?.injections.length ?? 0;
  const hardChecks = a?.hardChecks.length ?? 0;
  const rejectedWrites = a?.writeAttempts.filter((w) => w.rejected).length ?? 0;
  const grants = a?.grants.length ?? 0;

  return (
    <div className="page audit-page">
      <PageHeader
        eyebrow="AUDIT / EVIDENCE"
        title="审计"
        description="它凭什么这么说：召回、注入、拦截与授权，全部可追到原始事件。"
        actions={
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyJson()}>
              <Icon name="copy" size={14} /> 复制 JSON
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                void loadAudit();
                if (tab === 'events') void loadEvents('replace');
              }}
            >
              <Icon name="refresh" size={14} className={auditLoading ? 'spin' : ''} /> 刷新
            </button>
          </>
        }
      />

      {range !== null && (
        <div className="scope-banner">
          <span className="scope-icon">
            <Icon name="audit" size={17} />
          </span>
          <div>
            <strong>正在查看某一轮的完整依据</strong>
            <p className="mono">
              seq {range.fromSeq} – {range.toSeq}
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClearRange}>
            查看全部
          </button>
        </div>
      )}

      <div className="stat-grid stat-grid--4">
        <StatCard label="召回记忆" value={recalls} icon="memory" note={a?.recalls.length ? `${a.recalls.length} 次召回` : '本轮暂无召回'} />
        <StatCard label="约束注入" value={injections} icon="lock" note="每一条都能看到理由" />
        <StatCard
          label="硬约束拦截"
          value={hardChecks}
          icon="shield"
          tone={hardChecks > 0 ? 'danger' : 'default'}
          note={hardChecks > 0 ? '确定性判定，不经模型' : '本轮没有拦截'}
        />
        <StatCard
          label="越权写入"
          value={rejectedWrites}
          icon="lock"
          tone={rejectedWrites > 0 ? 'warn' : 'default'}
          note={`授权事件 ${grants} 条`}
        />
      </div>

      <div className="seg-tabs" role="tablist" aria-label="审计视图">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'evidence'}
          className={tab === 'evidence' ? 'is-active' : ''}
          onClick={() => setTab('evidence')}
        >
          依据
          <span className="seg-count">{audit?.scope === 'turn' ? '本轮' : '全部'}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'events'}
          className={tab === 'events' ? 'is-active' : ''}
          onClick={() => setTab('events')}
        >
          事件流
          {eventTotal > 0 && <span className="seg-count">{formatNumber(eventTotal)}</span>}
        </button>
      </div>

      {tab === 'evidence' && (
        <div className="audit-panel">
          {auditLoading && (
            <div className="audit-loading">
              <Skeleton rows={3} height={16} />
              <div className="chat-loading-gap" />
              <Skeleton rows={2} height={16} />
            </div>
          )}

          {auditError !== null && !auditLoading && (
            <InlineError message={auditError} onRetry={() => void loadAudit()} />
          )}

          {!auditLoading && auditError === null && a !== null && (
            <>
              {audit?.hasContent ? (
                <div className="audit-summary-line">
                  <Icon name="info" size={14} />
                  <span>{a.summary}</span>
                  <span className="mono audit-summary-range">
                    seq {a.fromSeq}–{a.toSeq}
                  </span>
                </div>
              ) : (
                <div className="audit-clean">
                  <span className="audit-clean-icon">
                    <Icon name="checkCircle" size={18} />
                  </span>
                  <div>
                    <strong>这一段是干净的</strong>
                    <p>没有召回、注入、拦截或授权。干净也是一条可核对的事实。</p>
                  </div>
                  <span className="mono audit-summary-range">
                    seq {a.fromSeq}–{a.toSeq}
                  </span>
                </div>
              )}

              {!audit?.hasContent && <div className="audit-clean-space" aria-hidden="true" />}

              {a.recalls.length > 0 && (
                <section className="audit-section">
                  <SectionHeading title="召回" description="这一轮把哪些记忆带进了上下文。" />
                  <div className="evidence-stack">
                    {a.recalls.map((r) => (
                      <article key={r.seq} className="evidence-card">
                        <header>
                          <span className="evidence-seq mono">#{r.seq}</span>
                          <span className="evidence-time">{formatDateTime(r.at)}</span>
                          <Badge tone="outline">{r.count} 条</Badge>
                        </header>
                        <ul className="recall-list">
                          {r.items.map((it, i) => (
                            <li key={`${it.memoryId}-${i}`}>
                              <div className="recall-top">
                                <Badge tone={it.memClass === 'global_constraint' ? 'accent' : 'neutral'}>
                                  {it.memClassLabel}
                                </Badge>
                                <button
                                  type="button"
                                  className="memory-link mono"
                                  onClick={() => onOpenMemory({ id: it.memoryId })}
                                >
                                  {it.memoryId}
                                  <Icon name="chevronRight" size={12} />
                                </button>
                                <span className="recall-relevance mono">
                                  {it.forced ? '强制召回' : `相关 ${formatPercent(it.relevance)}`}
                                </span>
                              </div>
                              <div className="recall-bar" aria-hidden="true">
                                <span style={{ width: `${it.forced ? 100 : it.relevancePercent}%` }} />
                              </div>
                            </li>
                          ))}
                        </ul>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {a.injections.length > 0 && (
                <section className="audit-section">
                  <SectionHeading title="约束注入" description="它是在知道了什么的前提下动的手。" />
                  <div className="evidence-stack">
                    {a.injections.map((inj) => (
                      <article key={inj.seq} className="evidence-card evidence-card--inject">
                        <header>
                          <span className="evidence-seq mono">#{inj.seq}</span>
                          <Badge tone={inj.negotiable ? 'neutral' : 'accent'}>
                            {inj.negotiable ? '可协商' : '不可协商'}
                          </Badge>
                          <Badge tone="outline">{inj.sourceLabel}</Badge>
                          <span className="evidence-time">{inj.domainLabel}</span>
                          {inj.memoryId.length > 0 && (
                            <button
                              type="button"
                              className="memory-link mono"
                              onClick={() => onOpenMemory({ id: inj.memoryId })}
                            >
                              {inj.memoryId}
                              <Icon name="chevronRight" size={12} />
                            </button>
                          )}
                        </header>
                        <p className="inject-content">{inj.content}</p>
                        {inj.reason.length > 0 && <p className="inject-reason">理由：{inj.reason}</p>}
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {a.hardChecks.length > 0 && (
                <section className="audit-section">
                  <SectionHeading
                    title="硬约束"
                    description="由代码机械判定，不交给模型 —— 这一条决定了它能不能动手。"
                  />
                  <div className="evidence-stack">
                    {a.hardChecks.map((h) => (
                      <article key={h.seq} className="evidence-card evidence-card--danger">
                        <header>
                          <span className="evidence-seq mono">#{h.seq}</span>
                          <Badge tone="danger">拦截</Badge>
                          {h.deterministic && <Badge tone="accent">确定性判定</Badge>}
                          <span className="evidence-time">{formatDateTime(h.at)}</span>
                        </header>
                        <p className="hard-content">{h.content}</p>
                        {h.unhandledByLabels.length > 0 && (
                          <p className="hard-unhandled">未被处理：{h.unhandledByLabels.join('、')}</p>
                        )}
                        {h.note.length > 0 && <p className="hard-note">{h.note}</p>}
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {a.grants.length > 0 && (
                <section className="audit-section">
                  <SectionHeading title="敏感域授权" description="逐次授权，按任务失效。" />
                  <ol className="timeline">
                    {a.grants.map((g) => (
                      <li key={g.seq} className={`timeline-item timeline-item--${GRANT_TONE[g.kind] ?? 'neutral'}`}>
                        <span className="timeline-dot" aria-hidden="true" />
                        <div className="timeline-body">
                          <div className="timeline-top">
                            <Badge tone={GRANT_TONE[g.kind] ?? 'neutral'}>{g.kindLabel}</Badge>
                            <span className="timeline-domain">{g.toDomainLabel}</span>
                            <span className="evidence-time">{formatDateTime(g.at)}</span>
                          </div>
                          <p className="mono timeline-memory">{g.memoryId}</p>
                          {g.reason.length > 0 && <p className="timeline-reason">{g.reason}</p>}
                          {g.expired && <p className="timeline-expired">授权已过期</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {a.writeAttempts.length > 0 && (
                <section className="audit-section">
                  <SectionHeading title="越权写入尝试" description="全局层只允许管家写入；其它来源的尝试应全部被拒。" />
                  <ul className="write-list">
                    {a.writeAttempts.map((w) => (
                      <li key={w.seq}>
                        <span className="mono evidence-seq">#{w.seq}</span>
                        <Badge tone={w.rejected ? 'accent' : 'danger'}>{w.rejected ? '已拒绝' : '未拒绝'}</Badge>
                        <span className="mono">{w.actor}</span>
                        <span>{w.reason}</span>
                        <button
                          type="button"
                          className="memory-link mono"
                          onClick={() => onOpenMemory({ id: w.memoryId })}
                        >
                          {w.memoryId}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'events' && (
        <div className="audit-panel">
          <div className="event-toolbar">
            <div className="search-field">
              <Icon name="search" size={16} />
              <input
                value={eventQuery}
                onChange={(e) => setEventQuery(e.target.value)}
                placeholder="搜索事件类型、摘要…"
                aria-label="搜索事件"
              />
              {eventQuery.length > 0 && (
                <button type="button" className="icon-btn icon-btn--sm" onClick={() => setEventQuery('')} aria-label="清空">
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
            <div className="filter-row event-families">
              {FAMILIES.map((f) => (
                <FilterChip key={f.value} active={family === f.value} onClick={() => setFamily(f.value)}>
                  {f.label}
                </FilterChip>
              ))}
            </div>
          </div>

          {eventsError !== null && <InlineError message={eventsError} onRetry={() => void loadEvents('replace')} />}

          {eventsLoading && events.length === 0 && (
            <div className="audit-loading">
              <Skeleton rows={6} height={14} />
            </div>
          )}

          {!eventsLoading && events.length === 0 && eventsError === null && (
            <EmptyState
              icon="audit"
              title="没有匹配的事件"
              description="换一个筛选条件，或去对话里产生一些记录。"
            />
          )}

          <ol className="event-feed">
            {events.map((e) => {
              const open = expandedSeq === e.seq;
              const raw = rawEvents[e.seq];
              return (
                <li key={e.id} className={`event-row ${open ? 'is-open' : ''}`}>
                  <div className="event-rail">
                    <span className="event-dot" aria-hidden="true" />
                    <span className="event-seq mono">{e.seq}</span>
                  </div>
                  <div className="event-main">
                    <button
                      type="button"
                      className="event-head"
                      onClick={() => void toggleEvent(e.seq)}
                      aria-expanded={open}
                    >
                      <span className="event-label">{e.label}</span>
                      <span className="event-type mono">{e.type}</span>
                      <span className="event-actor">{e.actorLabel}</span>
                      <span className="event-time">{relativeTime(e.at)}</span>
                      <Badge tone={e.legacy ? 'warn' : 'outline'}>{e.familyLabel}</Badge>
                      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                    </button>
                    {e.summary.length > 0 && <p className="event-summary">{e.summary}</p>}

                    <Collapse open={open}>
                      <div className="event-detail">
                        <div className="event-detail-head">
                          <span className="mini-label">完整事件 · seq {e.seq}</span>
                          {raw !== undefined && (
                            <button
                              type="button"
                              className="text-btn"
                              onClick={() => {
                                void navigator.clipboard
                                  .writeText(JSON.stringify(raw, null, 2))
                                  .then(() => notify('已复制事件 JSON', 'success'))
                                  .catch(() => notify('复制失败', 'warning'));
                              }}
                            >
                              <Icon name="copy" size={12} /> 复制
                            </button>
                          )}
                        </div>
                        {rawLoading === e.seq && <Skeleton rows={3} height={12} />}
                        {raw !== undefined && (
                          <pre className="code-block event-json">{JSON.stringify(raw, null, 2)}</pre>
                        )}
                      </div>
                    </Collapse>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="event-foot">
            <span className="list-meta">
              {eventsLoading ? '读取中…' : `已加载 ${formatNumber(events.length)} / ${formatNumber(eventTotal)}`}
            </span>
            {hasMore && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={eventsLoading}
                onClick={() => void loadEvents('append')}
              >
                加载更多
              </button>
            )}
          </div>

          <p className="event-note">
            事件是唯一真相源。每条都能按 seq 追到完整 payload；界面上的摘要只是它的投影。
          </p>
        </div>
      )}
    </div>
  );
}
