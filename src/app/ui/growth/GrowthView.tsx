'use client';

/**
 * 演化 —— 记忆变化记录
 *
 * ★ 这一页刻意不做报表。
 *   旧的演化页是生命周期环、适应度分布、原则效果表；它们回答“现在怎么样”，
 *   却回答不了“它是怎样慢慢变成现在这样的”。
 *
 * ★ 所以这里只记录已经发生的变化：
 *   转正、归档、冲突、原则被用上。按时间排成一条呼吸得开的线，
 *   每一张卡片只说一件事，以及它为什么发生。
 *
 * ★ 数据只读，来自 /api/memory/changes；不提供调权 / 唤醒 / 归档按钮 ——
 *   生命周期由系统自动演化，用户仍有删除权（在记忆页）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Icon, type IconName } from '../components/Icon';
import { errorMessage, fetchJson } from '../lib/api.js';
import {
  CLASS_LABEL,
  KIND_LABEL,
  LIFECYCLE_LABEL,
  domainLabel,
  formatClock,
  formatNumber,
  relativeTime,
  truncate,
} from '../lib/format.js';
import { useNow } from '../lib/hooks.js';
import type {
  MemoryChange,
  MemoryChangeKind,
  MemoryChangesResponse,
  MemoryTarget,
} from '../lib/types.js';

interface GrowthViewProps {
  readonly onOpenMemory: (target?: MemoryTarget) => void;
  readonly onRefreshOverview: () => void;
  readonly onFirstReady?: () => void;
}

interface KindMeta {
  readonly label: string;
  readonly icon: IconName;
}

const KIND_META: Record<MemoryChangeKind, KindMeta> = {
  promotion: { label: '转正', icon: 'orbit' },
  archive: { label: '归档', icon: 'database' },
  conflict: { label: '冲突', icon: 'alert' },
  principle: { label: '原则', icon: 'sparkle' },
};

const KIND_ORDER: readonly MemoryChangeKind[] = [
  'promotion',
  'archive',
  'conflict',
  'principle',
];

/** 页码过多时只展示当前页附近的页码，其余用省略号收起。 */
function visiblePages(page: number, pageCount: number): readonly (number | null)[] {
  if (pageCount <= 9) return Array.from({ length: pageCount }, (_, i) => i);
  const keep = new Set<number>([0, pageCount - 1, page - 1, page, page + 1]);
  if (page < 4) [1, 2, 3, 4].forEach((i) => keep.add(i));
  if (page > pageCount - 5) {
    [pageCount - 2, pageCount - 3, pageCount - 4, pageCount - 5].forEach((i) => keep.add(i));
  }
  const sorted = [...keep].filter((i) => i >= 0 && i < pageCount).sort((a, b) => a - b);
  const result: (number | null)[] = [];
  sorted.forEach((value, index) => {
    const previous = sorted[index - 1];
    if (index > 0 && previous !== undefined && value - previous > 1) result.push(null);
    result.push(value);
  });
  return result;
}

/** 加速 → 匀速 → 减速。返回 0–1 的位移进度。 */
function timelineProgress(t: number): number {
  const accel = 0.22;
  const decel = 0.22;
  const cruise = 1 - accel - decel;
  const total = 0.5 * accel + cruise + 0.5 * decel;
  if (t < accel) {
    const u = t / accel;
    return (0.5 * accel * u * u) / total;
  }
  if (t < accel + cruise) {
    return (0.5 * accel + (t - accel)) / total;
  }
  const u = (t - accel - cruise) / decel;
  return (0.5 * accel + cruise + decel * (u - 0.5 * u * u)) / total;
}

const STORY_PARTS: readonly {
  readonly kind: MemoryChangeKind;
  readonly lead: string;
  readonly unit: string;
  readonly tail: string;
}[] = [
  { kind: 'promotion', lead: '把\u00A0', unit: '条试行', tail: '变成了稳定记忆' },
  { kind: 'archive', lead: '让\u00A0', unit: '条记忆', tail: '退到归档' },
  { kind: 'conflict', lead: '遇到\u00A0', unit: '次说法冲突', tail: '' },
  { kind: 'principle', lead: '让\u00A0', unit: '条原则', tail: '被重新用上' },
];

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function shortDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function ChangeCard({
  change,
  index,
  now,
  onOpenMemory,
  showDay,
}: {
  readonly change: MemoryChange;
  readonly index: number;
  readonly now: number;
  readonly onOpenMemory: (target?: MemoryTarget) => void;
  readonly showDay: boolean;
}): JSX.Element {
  const meta = KIND_META[change.kind];
  const side = index % 2 === 0 ? 'left' : 'right';
  const headingId = `mmc-change-title-${index}`;
  const memory = change.memory;
  const conflict = change.conflict;
  const principle = change.principle;
  const transition = change.transition;
  const winner = conflict?.winner ?? null;
  const resolved = conflict?.resolved === true;

  return (
    <li
      className={`mmc-change is-${change.kind} is-${side}${index === 0 ? ' is-latest' : ''}`}
      data-mmc-index={index}
      style={{ '--mmc-i': Math.min(index, 12) } as CSSProperties}
    >
      <span className="mmc-node" aria-hidden="true">
        <Icon name={meta.icon} size={16} />
        {index === 0 && <i className="mmc-node-pulse" />}
      </span>
      {showDay && <span className="mmc-h-date mono">{shortDay(change.at)}</span>}

      <article className="mmc-change-card" aria-labelledby={headingId}>
        <header className="mmc-change-top">
          <span className="mmc-kind">
            <i aria-hidden="true" />
            {meta.label}
          </span>
          <time className="mmc-time mono" dateTime={new Date(change.at).toISOString()}>
            {formatClock(change.at)}
          </time>
        </header>

        <h3 id={headingId} className="mmc-change-title">
          {change.title}
        </h3>
        {change.kind === 'conflict' && conflict !== null ? (
          <p className={`mmc-conflict-result${conflict.resolved ? ' is-resolved' : ''}`}>
            {conflict.resolved && conflict.winnerContent !== null ? (
              <>
                <span>最终保留</span>
                {truncate(conflict.winnerContent, 86)}
              </>
            ) : (
              '系统会继续观察并自动处理，不需要你操作。'
            )}
          </p>
        ) : (
          <p className="mmc-change-summary">{change.summary}</p>
        )}

        {memory !== null && (
          <p className="mmc-memory-tags mono">
            <span>{CLASS_LABEL[memory.memClass]}</span>
            <span>{KIND_LABEL[memory.kind]}</span>
            <span>{domainLabel(memory.domain)}</span>
          </p>
        )}

        {transition !== null && (
          <div className="mmc-transition" aria-label={`生命周期：${transition.from === null ? '' : LIFECYCLE_LABEL[transition.from] + ' 到 '}${LIFECYCLE_LABEL[transition.to]}`}>
            {transition.from !== null && (
              <>
                <span className={`mmc-life is-${transition.from}`}>{LIFECYCLE_LABEL[transition.from]}</span>
                <span className="mmc-transition-arrow" aria-hidden="true">→</span>
              </>
            )}
            <span className={`mmc-life is-${transition.to}`}>{LIFECYCLE_LABEL[transition.to]}</span>
          </div>
        )}

        {change.kind === 'conflict' && conflict !== null ? (
          <div className="mmc-conflict">
            {conflict.candidateContent !== null && (
              <div
                className={`mmc-conflict-side${
                  resolved && winner === 'new' ? ' is-kept' : ''
                }${resolved && winner !== null && winner !== 'new' ? ' is-dropped' : ''}`}
              >
                <span className="mmc-conflict-label">
                  新的说法
                  {resolved && winner === 'new' && <b>保留</b>}
                </span>
                <p>{conflict.candidateContent}</p>
              </div>
            )}
            {conflict.existingContent !== null && (
              <div
                className={`mmc-conflict-side${
                  resolved && winner === 'existing' ? ' is-kept' : ''
                }${resolved && winner !== null && winner !== 'existing' ? ' is-dropped' : ''}`}
              >
                <span className="mmc-conflict-label">
                  原来的说法
                  {resolved && winner === 'existing' && <b>保留</b>}
                </span>
                <p>{conflict.existingContent}</p>
              </div>
            )}
            {!resolved && (
              <p className="mmc-conflict-wait">
                <Icon name="clock" size={12} /> 系统会继续观察并自动处理，不需要你操作。
              </p>
            )}
          </div>
        ) : change.kind === 'principle' && principle !== null ? (
          <div className="mmc-principle">
            {principle.condition !== null && (
              <div className="mmc-principle-row">
                <span>当</span>
                <p>{principle.condition}</p>
              </div>
            )}
            {principle.action !== null && (
              <div className="mmc-principle-row">
                <span>就</span>
                <p>{principle.action}</p>
              </div>
            )}
            {principle.condition === null && principle.action === null && memory !== null && (
              <p className="mmc-quote">{memory.content}</p>
            )}
            <div className="mmc-effect">
              <span
                className={`mmc-effect-badge${
                  principle.effective === true
                    ? ' is-good'
                    : principle.effective === false
                      ? ' is-warn'
                      : ''
                }`}
              >
                {principle.effective === true
                  ? '已验证有效'
                  : principle.effective === false
                    ? '效果待观察'
                    : '已经应用'}
              </span>
              <span className="mono">
                累计应用 {principle.appliedTotal} 次
              </span>
            </div>
          </div>
        ) : (
          memory !== null && <p className="mmc-quote">{memory.content}</p>
        )}

        {change.note !== null && change.note.length > 0 && (
          <p className="mmc-note">
            <span className="mmc-note-label">
              {change.kind === 'conflict'
                ? resolved
                  ? '裁决'
                  : '原因'
                : change.kind === 'principle'
                  ? '说明'
                  : '为什么'}
            </span>
            {change.note}
          </p>
        )}

        <footer className="mmc-change-foot">
          <span className="mmc-actor">
            {change.actorLabel} · {relativeTime(change.at, now)}
          </span>
          {memory !== null && (
            <button
              type="button"
              className="mmc-open"
              onClick={() => onOpenMemory({ id: memory.id })}
            >
              在记忆里看
              <Icon name="chevronRight" size={12} />
            </button>
          )}
        </footer>
      </article>
    </li>
  );
}

export function GrowthView({
  onOpenMemory,
  onRefreshOverview,
  onFirstReady,
}: GrowthViewProps): JSX.Element {
  const [data, setData] = useState<MemoryChangesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState<'all' | MemoryChangeKind>('all');

  const now = useNow(30_000);
  const firstReadyRef = useRef(false);
  const onFirstReadyRef = useRef(onFirstReady);
  onFirstReadyRef.current = onFirstReady;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetchJson<MemoryChangesResponse>('/api/memory/changes');
        if (!cancelled) setData(response);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (!firstReadyRef.current) {
            firstReadyRef.current = true;
            onFirstReadyRef.current?.();
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  useEffect(() => {
    if (data === null || filter === 'all') return;
    if (data.counts[filter] === 0) setFilter('all');
  }, [data, filter]);

  const refresh = useCallback((): void => {
    setNonce((value) => value + 1);
    onRefreshOverview();
  }, [onRefreshOverview]);

  const filtered = useMemo(() => {
    if (data === null) return [];
    return filter === 'all'
      ? data.changes
      : data.changes.filter((change) => change.kind === filter);
  }, [data, filter]);

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineRafRef = useRef<number | null>(null);
  const autoScrollingRef = useRef(false);
  const [page, setPage] = useState(0);
  const [layout, setLayout] = useState({ pageSize: 4, cardWidth: 326, pageWidth: 1300 });

  const timelineItems = useMemo(
    () =>
      filtered.map((change, index) => ({
        change,
        index,
        showDay:
          index === 0 ||
          dayKey(change.at) !== dayKey(filtered[index - 1]!.at),
      })),
    [filtered],
  );

  const pageCount = Math.max(1, Math.ceil(timelineItems.length / layout.pageSize));

  const pageGroups = useMemo(
    () =>
      Array.from({ length: pageCount }, (_, pageIndex) =>
        timelineItems.slice(pageIndex * layout.pageSize, (pageIndex + 1) * layout.pageSize),
      ),
    [layout.pageSize, pageCount, timelineItems],
  );

  useEffect(() => {
    const scroller = timelineRef.current;
    if (scroller === null) return;
    const updateLayout = (): void => {
      const width = scroller.clientWidth;
      if (width <= 0) return;
      const pageSize = width < 760 ? 2 : width < 1100 ? 3 : 4;
      const cardWidth = Math.min(342, (width - 24) / pageSize);
      setLayout((current) =>
        current.pageSize === pageSize &&
        Math.abs(current.cardWidth - cardWidth) < 1 &&
        Math.abs(current.pageWidth - width) < 1
          ? current
          : { pageSize, cardWidth, pageWidth: width },
      );
    };
    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [timelineItems.length]);

  const cancelTimelineAnimation = useCallback((): void => {
    if (timelineRafRef.current !== null) {
      cancelAnimationFrame(timelineRafRef.current);
      timelineRafRef.current = null;
    }
    autoScrollingRef.current = false;
  }, []);

  const pageTarget = useCallback(
    (pageIndex: number): number => Math.max(0, pageIndex * layout.pageWidth),
    [layout.pageWidth],
  );

  const goToPage = useCallback(
    (nextPage: number): void => {
      const scroller = timelineRef.current;
      if (scroller === null) return;
      const clamped = Math.max(0, Math.min(pageCount - 1, nextPage));
      cancelTimelineAnimation();
      setPage(clamped);
      const target = pageTarget(clamped);
      const start = scroller.scrollLeft;
      const delta = target - start;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (Math.abs(delta) < 2 || reduceMotion) {
        scroller.scrollLeft = target;
        return;
      }
      const duration = Math.min(900, Math.max(520, Math.abs(delta) * 0.12));
      const startedAt = performance.now();
      autoScrollingRef.current = true;
      const frame = (now: number): void => {
        const progress = Math.min(1, (now - startedAt) / duration);
        scroller.scrollLeft = start + delta * timelineProgress(progress);
        if (progress < 1) {
          timelineRafRef.current = requestAnimationFrame(frame);
        } else {
          timelineRafRef.current = null;
          autoScrollingRef.current = false;
          scroller.scrollLeft = target;
        }
      };
      timelineRafRef.current = requestAnimationFrame(frame);
    },
    [cancelTimelineAnimation, pageCount, pageTarget],
  );

  const handleTimelineScroll = useCallback((): void => {
    if (autoScrollingRef.current) return;
    const scroller = timelineRef.current;
    if (scroller === null || layout.pageWidth <= 0) return;
    const nextPage = Math.max(
      0,
      Math.min(pageCount - 1, Math.round(scroller.scrollLeft / layout.pageWidth)),
    );
    setPage(nextPage);
  }, [layout.pageWidth, pageCount]);

  useEffect(() => {
    cancelTimelineAnimation();
    setPage(0);
    timelineRef.current?.scrollTo({ left: 0 });
  }, [filter, cancelTimelineAnimation]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  useEffect(
    () => () => {
      cancelTimelineAnimation();
    },
    [cancelTimelineAnimation],
  );

  const phrases = useMemo(() => {
    if (data === null) return [];
    return STORY_PARTS.filter((part) => data.counts[part.kind] > 0);
  }, [data]);

  const storyMeta =
    data === null || data.counts.total === 0
      ? '还没有可以记录的变化'
      : `${data.window.from === null ? '' : shortDay(data.window.from)} — ${
          data.window.to === null ? '' : shortDay(data.window.to)
        } · ${data.window.days} 天 · ${formatNumber(data.counts.total)} 次变化${
          data.truncated ? ` · 只显示最近 ${formatNumber(data.counts.total)} 次` : ''
        }`;

  const activePage = Math.min(page, pageCount - 1);
  const pageNumbers = visiblePages(activePage, pageCount);

  return (
    <div className="mmc">
      <header className="mmc-head">
        <div className="mmc-head-text">
          <h1 className="mmc-title">演化</h1>
          <p className="mmc-desc">不是报表。是记忆最近怎样改变了自己。</p>
        </div>
        <div className="mmc-head-actions">
          <button
            type="button"
            className={`mmc-refresh${loading ? ' is-loading' : ''}`}
            onClick={refresh}
            disabled={loading}
            aria-label="重新读取变化记录"
            title="重新读取变化记录"
          >
            <Icon name="refresh" size={14} />
            <span>{loading ? '读取中' : '刷新'}</span>
          </button>
        </div>
      </header>

      {data === null && loading && (
        <div className="mmc-skeleton" role="status" aria-label="正在读取变化记录">
          <div className="mmc-skeleton-hero" />
          <div className="mmc-skeleton-filters" />
          <div className="mmc-skeleton-track">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`mmc-skeleton-card is-${i % 2 === 0 ? 'left' : 'right'}`} />
            ))}
          </div>
        </div>
      )}

      {data === null && !loading && error !== null && (
        <div className="mmc-error" role="alert">
          <span className="mmc-error-mark" aria-hidden="true">
            <Icon name="alert" size={17} />
          </span>
          <div>
            <h2>读取变化记录失败</h2>
            <p>{error}</p>
          </div>
          <button type="button" className="mmc-btn" onClick={refresh}>
            重试
          </button>
        </div>
      )}

      {data !== null && (
        <>
          <section className={`mmc-hero${data.counts.total === 0 ? ' is-empty' : ''}`} aria-label="最近的变化">
            <div className="mmc-hero-orbit" aria-hidden="true">
              <span className="mmc-orbit-ring is-outer" />
              <span className="mmc-orbit-ring is-inner" />
              <i className="mmc-orbit-dot is-promotion" />
              <i className="mmc-orbit-dot is-archive" />
              <i className="mmc-orbit-dot is-conflict" />
              <i className="mmc-orbit-dot is-principle" />
            </div>

            <p className="mmc-story">
              {phrases.length === 0 ? (
                <>最近，它很安静。</>
              ) : (
                <>
                  最近，它
                  {phrases.map((part, index) => (
                    <span key={part.kind} className="mmc-story-part">
                      {index > 0 ? '，' : ''}
                      <span className="mmc-story-clause">
                        {index === phrases.length - 1 && phrases.length > 1 ? '也' : ''}
                        {part.lead}
                        <button
                          type="button"
                          className={`mmc-story-count is-${part.kind}`}
                          onClick={() => setFilter(part.kind)}
                          aria-label={`只看${KIND_META[part.kind].label}，${data.counts[part.kind]} 次变化`}
                        >
                          {formatNumber(data.counts[part.kind])} {part.unit}
                        </button>
                        {part.tail}
                      </span>
                    </span>
                  ))}
                  。
                </>
              )}
            </p>

            <p className="mmc-story-meta mono">
              {storyMeta}
            </p>
          </section>

          <div className="mmc-filters" role="group" aria-label="按变化类型筛选">
            <button
              type="button"
              className={`mmc-filter${filter === 'all' ? ' is-active' : ''}`}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              <i className="mmc-dot is-all" aria-hidden="true" />
              <span>全部</span>
              <em className="mono">{formatNumber(data.counts.total)}</em>
            </button>
            {KIND_ORDER.map((kind) => {
              const count = data.counts[kind];
              const active = filter === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  className={`mmc-filter${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  disabled={count === 0 && !active}
                  onClick={() => setFilter(active ? 'all' : kind)}
                >
                  <i className={`mmc-dot is-${kind}`} aria-hidden="true" />
                  <span>{KIND_META[kind].label}</span>
                  <em className="mono">{formatNumber(count)}</em>
                </button>
              );
            })}
            <span className="mmc-filter-meta mono">
              {data.counts.total === 0
                ? '还没有变化'
                : filtered.length > 0
                  ? `最近一次 · ${relativeTime(filtered[0]!.at, now)}`
                  : '这一类还没有变化'}
            </span>
          </div>

          {error !== null && (
            <div className="mmc-inline-error" role="alert">
              <span>刷新失败：{error}</span>
              <button type="button" className="mmc-btn mmc-btn--small" onClick={refresh}>
                重试
              </button>
            </div>
          )}

          {data.counts.total === 0 ? (
            <section className="mmc-empty" aria-label="还没有变化记录">
              <span className="mmc-empty-orbit" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <h2>记忆还在安静地生长</h2>
              <p>
                当一条试行转正、一条记忆归档、一次矛盾被裁决，或一条原则被用上，
                这里会留下记录。
              </p>
              <div className="mmc-empty-actions">
                <button type="button" className="mmc-btn" onClick={refresh}>
                  再看一眼
                </button>
                <button type="button" className="mmc-btn mmc-btn--ghost" onClick={() => onOpenMemory()}>
                  去记忆里看看
                  <Icon name="chevronRight" size={13} />
                </button>
              </div>
            </section>
          ) : filtered.length === 0 ? (
            <section className="mmc-empty is-filtered" aria-label="这一类还没有变化">
              <span className="mmc-empty-mark" aria-hidden="true">
                <Icon name={KIND_META[filter === 'all' ? 'promotion' : filter].icon} size={17} />
              </span>
              <h2>这一类还没有变化</h2>
              <p>换一条线索看看，或者回到全部变化。</p>
              <button type="button" className="mmc-btn" onClick={() => setFilter('all')}>
                看全部
              </button>
            </section>
          ) : (
            <div className="mmc-h-wrap">
              <div
                className="mmc-h-scroller"
                ref={timelineRef}
                role="region"
                aria-label={`记忆变化时间线，第 ${activePage + 1} 页，共 ${pageCount} 页`}
                tabIndex={0}
                onScroll={handleTimelineScroll}
                onWheel={cancelTimelineAnimation}
                onPointerDown={cancelTimelineAnimation}
                onTouchStart={cancelTimelineAnimation}
              >
                <div
                  className="mmc-h-track"
                  style={
                    {
                      '--mmc-card-w': `${layout.cardWidth}px`,
                      '--mmc-page-w': `${layout.pageWidth}px`,
                    } as CSSProperties
                  }
                >
                  <span className="mmc-h-axis" aria-hidden="true" />
                  {pageGroups.map((entries, pageIndex) => (
                    <section
                      className="mmc-h-page-group"
                      key={`timeline-page-${pageIndex}`}
                      aria-label={`第 ${pageIndex + 1} 页`}
                    >
                      {entries.map((entry) => (
                        <ChangeCard
                          key={entry.change.id}
                          change={entry.change}
                          index={entry.index}
                          now={now}
                          onOpenMemory={onOpenMemory}
                          showDay={entry.showDay}
                        />
                      ))}
                    </section>
                  ))}
                </div>
              </div>
              <div className="mmc-h-controls">
                <button
                  type="button"
                  className="mmc-h-arrow"
                  aria-label="上一页"
                  disabled={activePage === 0}
                  onClick={() => goToPage(activePage - 1)}
                >
                  <Icon name="arrowLeft" size={14} />
                </button>
                <div className="mmc-h-pages" role="group" aria-label="时间线页码">
                  {pageNumbers.map((pageIndex, index) =>
                    pageIndex === null ? (
                      <span className="mmc-h-gap" key={`gap-${index}`} aria-hidden="true">
                        …
                      </span>
                    ) : (
                      <button
                        key={pageIndex}
                        type="button"
                        className={`mmc-h-page${pageIndex === activePage ? ' is-active' : ''}`}
                        aria-label={`第 ${pageIndex + 1} 页`}
                        aria-current={pageIndex === activePage ? 'page' : undefined}
                        onClick={() => goToPage(pageIndex)}
                      >
                        {pageIndex + 1}
                      </button>
                    ),
                  )}
                </div>
                <button
                  type="button"
                  className="mmc-h-arrow"
                  aria-label="下一页"
                  disabled={activePage >= pageCount - 1}
                  onClick={() => goToPage(activePage + 1)}
                >
                  <Icon name="chevronRight" size={14} />
                </button>
              </div>
            </div>
          )}

          <footer className="mmc-foot">
            <p>变化不是结论。它只是记忆最近做过的选择。</p>
            <button type="button" className="mmc-foot-link" onClick={() => onOpenMemory()}>
              去记忆里看看
              <Icon name="chevronRight" size={13} />
            </button>
          </footer>
        </>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {loading
          ? '正在读取变化记录'
          : data === null
            ? ''
            : `共 ${data.counts.total} 次变化`}
      </p>
    </div>
  );
}
