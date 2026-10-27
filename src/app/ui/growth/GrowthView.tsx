'use client';

/**
 * 演化空间 —— 把“越用越懂你”变成看得见的量
 *
 * ★ 这一页最重要的不是图表，而是**诚实**：
 *   演化发生在天与周的尺度上，系统不伪造结果。
 *   所以这里只呈现真实累积出来的生命周期、适应度与事件。
 */

import { useEffect, useRef, useState } from 'react';

import {
  Badge,
  InlineError,
  Meter,
  PageHeader,
  SectionHeading,
  Skeleton,
  StatCard,
} from '../components/Common';
import { Icon } from '../components/Icon';
import { errorMessage, fetchJson } from '../lib/api.js';
import {
  DOMAIN_LABEL,
  formatDateTime,
  formatNumber,
  formatPercent,
  relativeTime,
} from '../lib/format.js';
import type {
  MemoryItem,
  MemoryTarget,
  Overview,
  ProfileDeltaView,
  ProfileDiffResponse,
  ProfilesResponse,
  ProfileSnapshotView,
  ProfileSummary,
  ViewId,
} from '../lib/types.js';

interface GovernanceCounts {
  readonly diaries: number;
  readonly diaryFailed: number;
  readonly trial: number;
  readonly legacyPending: number;
  readonly active: number;
  readonly dormant: number;
  readonly archived: number;
  readonly promoted: number;
  readonly trialArchived: number;
  readonly conflicts: number;
  readonly resolved: number;
  readonly tombstones: number;
}

interface GovernanceEventView {
  readonly seq: number;
  readonly at: number;
  readonly type: string;
  readonly label: string;
  readonly familyLabel: string;
  readonly summary: string;
}

interface GovernanceResponse {
  readonly ok: boolean;
  readonly counts?: GovernanceCounts;
  readonly recent?: readonly GovernanceEventView[];
}

interface GrowthViewProps {
  readonly overview: Overview | null;
  readonly onNavigate: (view: ViewId) => void;
  readonly onOpenMemory: (opts?: MemoryTarget) => void;
  readonly onRefreshOverview: () => void;
  /** overview 可用时调用一次，用于控制台的真实进度。 */
  readonly onFirstReady?: () => void;
}

const LIFECYCLE_COLORS = {
  active: 'var(--accent)',
  candidate: 'var(--warn)',
  dormant: 'var(--ink-3)',
  archived: 'var(--line-strong)',
} as const;

export function GrowthView({
  overview,
  onNavigate,
  onOpenMemory,
  onRefreshOverview,
  onFirstReady,
}: GrowthViewProps): JSX.Element {
  const [ready, setReady] = useState(false);
  const firstReadyRef = useRef(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (overview === null || firstReadyRef.current) return;
    firstReadyRef.current = true;
    onFirstReady?.();
  }, [overview, onFirstReady]);

  // ── 成长对比：快照列表 + 两份快照的 diff ──
  const [governance, setGovernance] = useState<GovernanceResponse | null>(null);
  const [governanceError, setGovernanceError] = useState<string | null>(null);
  const [governanceNonce, setGovernanceNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setGovernanceError(null);
    void (async () => {
      try {
        const res = await fetchJson<GovernanceResponse>('/api/memory/governance');
        if (!cancelled) setGovernance(res);
      } catch (err) {
        if (!cancelled) setGovernanceError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [governanceNonce]);

  const [profiles, setProfiles] = useState<readonly ProfileSummary[]>([]);
  const [profileSkipped, setProfileSkipped] = useState(0);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [profilesNonce, setProfilesNonce] = useState(0);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [diff, setDiff] = useState<ProfileDeltaView | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffNonce, setDiffNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setProfilesLoading(true);
    setProfilesError(null);
    void (async () => {
      try {
        const res = await fetchJson<ProfilesResponse>('/api/profiles');
        if (cancelled) return;
        setProfiles(res.profiles);
        setProfileSkipped(res.skipped);

        const first = res.profiles[0];
        const last = res.profiles[res.profiles.length - 1];
        setFromId((cur) =>
          cur !== null && res.profiles.some((p) => p.id === cur) ? cur : (first?.id ?? null),
        );
        setToId((cur) =>
          cur !== null && res.profiles.some((p) => p.id === cur) ? cur : (last?.id ?? null),
        );
      } catch (err) {
        if (!cancelled) setProfilesError(errorMessage(err));
      } finally {
        if (!cancelled) setProfilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profilesNonce]);

  useEffect(() => {
    if (fromId === null || toId === null || fromId === toId) {
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
        const res = await fetchJson<ProfileDiffResponse>(
          `/api/profiles?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`,
        );
        if (!cancelled) setDiff(res.delta);
      } catch (err) {
        if (!cancelled) setDiffError(errorMessage(err));
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromId, toId, diffNonce]);

  if (overview === null) {
    return (
      <div className="page growth-page">
        <PageHeader
          eyebrow="EVOLUTION / PROFILE"
          title="演化"
          description="记忆不是越堆越多，而是越用越准。"
        />
        <div className="stat-grid stat-grid--4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="panel panel--skeleton">
              <Skeleton rows={2} height={14} />
            </div>
          ))}
        </div>
        <div className="growth-grid">
          <div className="panel panel--skeleton">
            <Skeleton rows={5} height={14} />
          </div>
          <div className="panel panel--skeleton">
            <Skeleton rows={5} height={14} />
          </div>
        </div>
      </div>
    );
  }

  const m = overview.memory;
  const total = m.total;
  const days = overview.totals.daysSinceFirstEvent + 1;
  const maxDaily = Math.max(1, ...overview.daily.map((d) => d.total));
  const events14 = overview.daily.reduce((n, d) => n + d.total, 0);
  const maxBucket = Math.max(1, ...m.fitnessBuckets);
  const passCount = overview.totals.accepted;
  const verdicts = overview.totals.verdicts;
  const passRate = verdicts > 0 ? passCount / verdicts : null;
  const sameSnapshot = fromId !== null && fromId === toId;

  const segments: readonly { key: keyof typeof LIFECYCLE_COLORS; label: string; value: number }[] = [
    { key: 'active', label: '活跃', value: m.active },
    { key: 'candidate', label: '试行', value: m.pending },
    { key: 'dormant', label: '休眠', value: m.dormant },
    { key: 'archived', label: '归档', value: m.archived },
  ];

  let offset = 0;
  const donut = segments.map((s) => {
    const pct = total > 0 ? (s.value / total) * 100 : 0;
    const seg = { ...s, pct, offset };
    offset += pct;
    return seg;
  });

  return (
    <div className="page growth-page">
      <PageHeader
        eyebrow="EVOLUTION / PROFILE"
        title="演化"
        description="记忆不是越堆越多，而是越用越准。无用的会渐进休眠、归档，但不删除。"
        actions={
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRefreshOverview}>
            <Icon name="refresh" size={14} /> 刷新
          </button>
        }
      />

      <section className="growth-hero">
        <div className="growth-hero-text">
          <p className="eyebrow">第 {formatNumber(days)} 天</p>
          <h2>它正在缓慢地变得更懂你。</h2>
          <p className="growth-hero-sub">
            这是真实累积出来的第 {formatNumber(days)} 天。演化的尺度是天与周 —— 系统不会伪造结果。
          </p>
          <div className="hero-lifecycle">
            {segments.map((s) => (
              <button
                key={s.key}
                type="button"
                className="lifecycle-pill"
                onClick={() =>
                  onOpenMemory(
                    s.key === 'candidate'
                      ? { pending: true }
                      : { lifecycle: s.key === 'active' ? 'active' : s.key === 'dormant' ? 'dormant' : 'archived' },
                  )
                }
              >
                <span className="lifecycle-dot" style={{ background: LIFECYCLE_COLORS[s.key] }} />
                <span>{s.label}</span>
                <strong className="mono">{formatNumber(s.value)}</strong>
              </button>
            ))}
          </div>
        </div>

        <div className="growth-spark">
          <div className="growth-spark-head">
            <span>近 14 天事件量</span>
            <strong className="mono">{formatNumber(events14)}</strong>
          </div>
          {events14 === 0 ? (
            <div className="spark-empty">
              <span>还没有活动轨迹</span>
              <small>开始对话后，这里会出现最近 14 天的节奏。</small>
            </div>
          ) : (
            <>
              <div className="spark-bars" role="img" aria-label="近 14 天事件量柱状图">
                {overview.daily.map((d) => (
                  <span
                    key={d.key}
                    className={`spark-bar ${d.total === 0 ? 'is-empty' : ''}`}
                    title={`${d.label} · ${d.total} 条事件`}
                    style={{ height: ready ? `${Math.max(4, (d.total / maxDaily) * 100)}%` : '4%' }}
                  >
                    <i />
                  </span>
                ))}
              </div>
              <div className="spark-labels mono">
                <span>{overview.daily[0]?.label ?? ''}</span>
                <span>今天</span>
              </div>
            </>
          )}
          <div className="spark-legend">
            <span>
              <i className="legend-dot legend-dot--accent" /> 今日发言 {overview.totals.todayUserMessages} 条
            </span>
            <span>工具调用 {formatNumber(overview.totals.toolCalls)} 次</span>
          </div>
        </div>
      </section>

      <div className="stat-grid stat-grid--4">
        <StatCard
          label="平均适应度"
          value={m.avgFitness * 100}
          suffix="%"
          animate={false}
          icon="growth"
          tone="accent"
          note="硬约束不参与衰减，已排除"
        />
        <StatCard
          label="原则应用"
          value={m.principles.applied}
          icon="shield"
          note={`奏效 ${m.principles.succeeded} 次 · 共 ${m.principles.total} 条原则`}
        />
        <StatCard
          label="复核通过"
          value={passCount}
          icon="checkCircle"
          note={
            passRate !== null
              ? `通过率 ${formatPercent(passRate)} · 打回 ${overview.totals.rejected}`
              : '还没有复核记录'
          }
        />
        <StatCard
          label="本周新增记忆"
          value={m.addedLast7Days}
          icon="sparkle"
          note={`近 7 天命中 ${m.hitLast7Days} 条`}
        />
      </div>

      <GrowthCompare
        profiles={profiles}
        skipped={profileSkipped}
        loading={profilesLoading}
        error={profilesError}
        fromId={fromId}
        toId={toId}
        sameSnapshot={sameSnapshot}
        diff={diff}
        diffLoading={diffLoading}
        diffError={diffError}
        onFrom={setFromId}
        onTo={setToId}
        onReload={() => setProfilesNonce((n) => n + 1)}
        onRefreshDiff={() => setDiffNonce((n) => n + 1)}
      />

      <section className="panel growth-governance panel--wide">
        <SectionHeading
          title="自主治理"
          description="日记、试行、自动转正、冲突裁决与归档，全部来自真实事件。"
          actions={
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                setGovernanceNonce((n) => n + 1);
                onRefreshOverview();
              }}
            >
              刷新
              <Icon name="refresh" size={13} />
            </button>
          }
        />
        {governanceError !== null && <InlineError message={governanceError} />}
        {governance?.counts !== undefined && (
          <>
            <div className="governance-stats">
              <div><strong className="mono">{governance.counts.diaries}</strong><span>日记</span></div>
              <div><strong className="mono">{governance.counts.trial}</strong><span>试行记忆</span></div>
              <div><strong className="mono">{governance.counts.promoted}</strong><span>自动转正</span></div>
              <div><strong className="mono">{governance.counts.resolved}</strong><span>冲突裁决</span></div>
              <div><strong className="mono">{governance.counts.trialArchived}</strong><span>试行归档</span></div>
              <div><strong className="mono">{governance.counts.tombstones}</strong><span>硬约束墓碑</span></div>
            </div>
            {governance.counts.legacyPending > 0 && (
              <p className="governance-warning">
                还有 {governance.counts.legacyPending} 条旧待审记忆尚未迁移；它们不参与召回。
              </p>
            )}
            <ul className="governance-recent">
              {(governance.recent ?? []).slice(0, 6).map((e) => (
                <li key={`${e.seq}_${e.type}`}>
                  <span className="mono">{e.label}</span>
                  <span className="governance-summary">{e.summary || e.familyLabel}</span>
                  <span className="governance-time">{relativeTime(e.at, overview.now)}</span>
                </li>
              ))}
              {(governance.recent ?? []).length === 0 && (
                <li className="governance-empty">还没有自动治理记录。</li>
              )}
            </ul>
          </>
        )}
      </section>

      <div className="growth-grid">
        <section className="panel growth-lifecycle">
          <SectionHeading title="生命周期" description="淘汰不等于删除：休眠与归档的内容仍可在命中时唤醒。" />
          <div className="donut-wrap">
            <svg viewBox="0 0 160 160" className="donut" role="img" aria-label="记忆生命周期分布">
              <circle cx="80" cy="80" r="58" className="donut-track" />
              {donut.map((s) =>
                s.pct > 0 ? (
                  <circle
                    key={s.key}
                    cx="80"
                    cy="80"
                    r="58"
                    className="donut-seg"
                    pathLength={100}
                    stroke={LIFECYCLE_COLORS[s.key]}
                    strokeDasharray={ready ? `${Math.max(0, s.pct - 0.6)} ${100 - Math.max(0, s.pct - 0.6)}` : '0 100'}
                    strokeDashoffset={-s.offset}
                  />
                ) : null,
              )}
            </svg>
            <div className="donut-center">
              <strong className="mono">{formatNumber(total)}</strong>
              <span>条记忆</span>
            </div>
          </div>
          <ul className="donut-legend">
            {donut.map((s) => (
              <li key={s.key}>
                <span className="legend-dot" style={{ background: LIFECYCLE_COLORS[s.key] }} />
                <span>{s.label}</span>
                <strong className="mono">{formatNumber(s.value)}</strong>
                <small className="mono">{total > 0 ? formatPercent(s.value / total) : '0%'}</small>
              </li>
            ))}
          </ul>
          <div className="composition">
            <span>事实 {m.byKind.fact}</span>
            <span>偏好 {m.byKind.preference}</span>
            <span>原则 {m.byKind.principle}</span>
            <span>长期状态 {m.byKind.summary}</span>
          </div>
        </section>

        <section className="panel growth-fitness">
          <SectionHeading title="适应度分布" description="由使用频率、效果验证、证据强度与时效共同决定。" />
          <div className={`fitness-bars ${ready ? 'is-ready' : ''}`}>
            {m.fitnessBuckets.map((count, i) => (
              <div key={i} className="fitness-col">
                <span className="fitness-count mono">{count}</span>
                <div className="fitness-track">
                  <span
                    className="fitness-fill"
                    style={{ height: ready ? `${Math.max(count > 0 ? 6 : 2, (count / maxBucket) * 100)}%` : '2%' }}
                  />
                </div>
                <span className="fitness-label mono">
                  {i * 20}–{(i + 1) * 20}
                </span>
              </div>
            ))}
          </div>
          <div className="fitness-note">
            <Icon name="info" size={14} />
            <span>低适应度的记忆会先休眠、再归档；被再次命中时会自动唤醒。</span>
          </div>
        </section>

        <section className="panel growth-principles">
          <SectionHeading
            title="原则"
            description="原则是反思产物，记录“应用过几次、奏效几次”。"
            actions={
              <button type="button" className="text-btn" onClick={() => onOpenMemory({ lifecycle: 'active' })}>
                全部记忆
                <Icon name="chevronRight" size={13} />
              </button>
            }
          />
          {overview.principles.length === 0 ? (
            <p className="panel-empty">还没有形成原则。它需要跨多次对话的反思才能出现。</p>
          ) : (
            <ul className="principle-list">
              {overview.principles.map((p) => (
                <PrincipleRow key={p.id} memory={p} onOpen={() => onOpenMemory({ id: p.id })} />
              ))}
            </ul>
          )}
        </section>

        <section className="panel growth-summaries">
          <SectionHeading
            title="长期状态"
            description="周期复盘生成的聚合记忆，可被召回，也会衰减。"
            actions={
              <button type="button" className="text-btn" onClick={() => onOpenMemory({ lifecycle: 'active' })}>
                全部
                <Icon name="chevronRight" size={13} />
              </button>
            }
          />
          {overview.summaries.length === 0 ? (
            <p className="panel-empty">还没有聚合记忆。它会在每日 / 每周复盘后出现。</p>
          ) : (
            <div className="summary-list">
              {overview.summaries.map((s) => (
                <button key={s.id} type="button" className="summary-card" onClick={() => onOpenMemory({ id: s.id })}>
                  <Icon name="quote" size={16} className="summary-quote" />
                  <p>{s.content}</p>
                  <span className="summary-meta">
                    {s.effectiveness !== null ? `应用 ${s.effectiveness.applied} 次 · ` : ''}
                    {relativeTime(s.updatedAt, overview.now)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="panel growth-observe">
          <SectionHeading
            title="行为观察"
            description="默认关闭。开启后每 5 分钟抽样一次，只记录应用名。"
            actions={
              <Badge tone={overview.observation.granted && overview.observation.enabled ? 'accent' : 'neutral'}>
                {overview.observation.granted
                  ? overview.observation.enabled
                    ? '采集中'
                    : '已同意 · 已暂停'
                  : '未开启'}
              </Badge>
            }
          />
          <div className="observe-stats">
            <div>
              <strong className="mono">{formatNumber(overview.observation.recordedBlocks)}</strong>
              <span>原始采样块</span>
            </div>
            <div>
              <strong className="mono">{formatNumber(overview.observation.aggregates)}</strong>
              <span>聚合记录</span>
            </div>
            <div>
              <strong className="mono">
                {overview.observation.retentionDays === 0 ? '—' : `${overview.observation.retentionDays} 天`}
              </strong>
              <span>原始记录保留</span>
            </div>
          </div>
          <p className="observe-note">
            不采集窗口标题、不采集内容、不做键盘记录。撤回同意会同时清除已采集的数据。
          </p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate('settings')}>
            {overview.observation.granted ? '管理采集设置' : '去设置里开启'}
            <Icon name="chevronRight" size={14} />
          </button>
        </section>

        <section className="panel growth-events panel--wide">
          <SectionHeading
            title="演化日志"
            description="写入、试行、休眠、唤醒 —— 它正在淘汰什么、保留什么。"
            actions={
              <button type="button" className="text-btn" onClick={() => onNavigate('audit')}>
                事件流
                <Icon name="chevronRight" size={13} />
              </button>
            }
          />
          {overview.recentEvolution.length === 0 ? (
            <p className="panel-empty">还没有演化事件。随着使用会出现写入、试行与休眠。</p>
          ) : (
            <ol className="evolution-timeline">
              {overview.recentEvolution.map((e) => (
                <li key={`${e.seq}-${e.type}`}>
                  <span className="evo-dot" aria-hidden="true" />
                  <div className="evo-main">
                    <span className="evo-label">{e.label}</span>
                    {e.summary.length > 0 && <span className="evo-summary">{e.summary}</span>}
                  </div>
                  <span className="evo-time" title={formatDateTime(e.at)}>
                    {relativeTime(e.at, overview.now)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {overview.quiz.created > 0 && (
          <section className="panel growth-quiz">
            <SectionHeading title="练习" description="批改走确定性比对，零模型调用。" />
            <div className="quiz-stats">
              <div>
                <strong className="mono">{overview.quiz.created}</strong>
                <span>套练习</span>
              </div>
              <div>
                <strong className="mono">{overview.quiz.graded}</strong>
                <span>次批改</span>
              </div>
              <div>
                <strong className="mono">
                  {overview.quiz.lastScore !== null
                    ? `${overview.quiz.lastScore.right}/${overview.quiz.lastScore.total}`
                    : '—'}
                </strong>
                <span>最近得分</span>
              </div>
            </div>
          </section>
        )}

        <section className="panel growth-scale">
          <SectionHeading title="使用规模" description="这些数字来自事件流本身，不是估算。" />
          <div className="scale-grid">
            <div>
              <strong className="mono">{formatNumber(overview.totals.sessions)}</strong>
              <span>段对话</span>
            </div>
            <div>
              <strong className="mono">{formatNumber(overview.totals.messages)}</strong>
              <span>条消息</span>
            </div>
            <div>
              <strong className="mono">{formatNumber(overview.totals.events)}</strong>
              <span>条事件</span>
            </div>
            <div>
              <strong className="mono">{formatNumber(overview.totals.toolCalls)}</strong>
              <span>次工具调用</span>
            </div>
          </div>
        </section>
      </div>

      <p className="growth-footnote">
        <Icon name="info" size={14} />
        演化的时间尺度：秒级对话 · 小时级反思 · 天级效果验证 · 周级趋势。加速的是时间，不是机制。
      </p>
    </div>
  );
}

function GrowthCompare({
  profiles,
  skipped,
  loading,
  error,
  fromId,
  toId,
  sameSnapshot,
  diff,
  diffLoading,
  diffError,
  onFrom,
  onTo,
  onReload,
  onRefreshDiff,
}: {
  readonly profiles: readonly ProfileSummary[];
  readonly skipped: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly fromId: string | null;
  readonly toId: string | null;
  readonly sameSnapshot: boolean;
  readonly diff: ProfileDeltaView | null;
  readonly diffLoading: boolean;
  readonly diffError: string | null;
  readonly onFrom: (id: string) => void;
  readonly onTo: (id: string) => void;
  readonly onReload: () => void;
  readonly onRefreshDiff: () => void;
}): JSX.Element {
  const complete = profiles.length >= 2;

  return (
    <section className="panel growth-compare" aria-labelledby="growth-compare-title">
      <SectionHeading
        title={<span id="growth-compare-title">成长对比</span>}
        description="两份画像快照并排 —— 看得见的成长，而不是口头声称。"
        actions={
          <div className="compare-actions">
            <Badge tone={complete ? 'accent' : 'neutral'}>
              {profiles.length} 份完整快照
            </Badge>
            <button type="button" className="text-btn" onClick={onReload} disabled={loading}>
              <Icon name="refresh" size={13} /> 刷新
            </button>
          </div>
        }
      />

      {loading ? (
        <Skeleton rows={4} height={16} />
      ) : error !== null ? (
        <InlineError message={error} onRetry={onReload} />
      ) : !complete ? (
        <GrowthCompareEmpty count={profiles.length} skipped={skipped} />
      ) : (
        <>
          <div className="compare-pickers">
            <label className="compare-pick">
              起始快照
              <select
                value={fromId ?? ''}
                onChange={(e) => onFrom(e.target.value)}
                aria-label="起始快照"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{profileOptionLabel(p)}</option>
                ))}
              </select>
            </label>
            <span className="compare-arrow" aria-hidden="true">→</span>
            <label className="compare-pick">
              目标快照
              <select
                value={toId ?? ''}
                onChange={(e) => onTo(e.target.value)}
                aria-label="目标快照"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{profileOptionLabel(p)}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="text-btn compare-run"
              onClick={onRefreshDiff}
              disabled={sameSnapshot || diffLoading}
            >
              对比
            </button>
          </div>

          {sameSnapshot ? (
            <p className="compare-note">起始与目标选了同一份快照 —— 换一份再比。</p>
          ) : diffLoading ? (
            <Skeleton rows={4} height={16} />
          ) : diffError !== null ? (
            <InlineError message={diffError} onRetry={onRefreshDiff} />
          ) : diff !== null ? (
            <>
              <div className="compare-headline" role="status" aria-live="polite">
                <span className="compare-mark" aria-hidden="true">
                  <Icon name="growth" size={15} />
                </span>
                <div>
                  <strong>{diff.headline}</strong>
                  <div className="compare-headline-sub">
                    原则 {formatNumber(diff.from.principles)} → {formatNumber(diff.to.principles)} · 生活节奏{' '}
                    {formatNumber(diff.from.temporalPatterns)} → {formatNumber(diff.to.temporalPatterns)}
                  </div>
                </div>
              </div>

              <div className="compare-cols">
                <SnapshotCard snapshot={diff.from} />
                <SnapshotCard snapshot={diff.to} />
                <DeltaCard delta={diff} />
              </div>

              <p className="compare-foot">
                <Icon name="info" size={13} />
                数据来自事件流中的 profile.snapshot；旧版本只有计数的快照会被跳过并标注，不补造。
              </p>
            </>
          ) : null}

          {skipped > 0 && (
            <p className="compare-skipped">
              另有 {formatNumber(skipped)} 份旧版本快照只有计数，无法参与对比。
            </p>
          )}
        </>
      )}
    </section>
  );
}

function GrowthCompareEmpty({
  count,
  skipped,
}: {
  readonly count: number;
  readonly skipped: number;
}): JSX.Element {
  return (
    <div className="compare-empty">
      <span className="compare-empty-mark" aria-hidden="true">
        <Icon name="growth" size={18} />
      </span>
      <strong>{count === 0 ? '还没有完整快照' : '只有 1 份完整快照'}</strong>
      <p>
        {count === 0
          ? '周复盘会自动生成画像快照；有了两份之后，这里才能并排对比。'
          : '有了第一份快照，还不足以对比；下一轮周复盘后会生成第二份。'}
        旧版本只记了计数的快照会被跳过，不补造。
      </p>
      {skipped > 0 && (
        <span className="compare-empty-hint">
          已有 {formatNumber(count)} 份完整快照 · {formatNumber(skipped)} 份旧快照不可对比
        </span>
      )}
    </div>
  );
}

function SnapshotCard({ snapshot }: { readonly snapshot: ProfileSnapshotView }): JSX.Element {
  const total = snapshot.facts + snapshot.preferences + snapshot.principles;
  const domains = Object.entries(snapshot.perDomain).filter(
    ([, v]) => v.memories > 0 || v.principles > 0,
  );

  return (
    <article className="compare-snap">
      <div className="compare-snap-head">
        <strong>会话 {formatNumber(snapshot.sessionCount)}</strong>
        <span className="mono">{formatDateTime(snapshot.capturedAt)}</span>
      </div>
      <div className="compare-big">
        <b>{formatNumber(total)}</b>
        <span>条记忆</span>
      </div>
      <div className="compare-rows">
        <CompareRow label="事实" value={snapshot.facts} />
        <CompareRow label="偏好" value={snapshot.preferences} />
        <CompareRow label="原则" value={snapshot.principles} />
        <CompareRow
          label="生活节奏"
          value={snapshot.temporalPatterns}
          empty={snapshot.temporalPatterns === 0}
        />
      </div>
      {domains.length > 0 ? (
        <div className="compare-domains">
          {domains.map(([id, v]) => (
            <span key={id}>{DOMAIN_LABEL[id] ?? id} {formatNumber(v.memories)}</span>
          ))}
        </div>
      ) : (
        <p className="compare-domains-empty">还没有领域记忆</p>
      )}
      <p className="compare-summary">{snapshot.summary}</p>
    </article>
  );
}

function CompareRow({
  label,
  value,
  empty = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly empty?: boolean;
}): JSX.Element {
  return (
    <div className="compare-row">
      <span>{label}</span>
      <b className="mono">{empty ? '—' : formatNumber(value)}</b>
    </div>
  );
}

function DeltaCard({ delta }: { readonly delta: ProfileDeltaView }): JSX.Element {
  const cells: readonly { readonly label: string; readonly value: number }[] = [
    { label: '事实', value: delta.facts },
    { label: '偏好', value: delta.preferences },
    { label: '原则', value: delta.principles },
    { label: '节奏', value: delta.temporalPatterns },
  ];

  return (
    <aside className="compare-delta">
      <h4>变化 / DELTA</h4>
      <div className="compare-delta-grid">
        {cells.map((c) => (
          <div key={c.label} className="compare-cell">
            <span>{c.label}</span>
            <b className={`mono ${c.value === 0 ? 'is-zero' : ''}`}>{signed(c.value)}</b>
          </div>
        ))}
      </div>

      <h5>新学到的原则</h5>
      {delta.newPrinciples.length === 0 ? (
        <p className="compare-empty-line">这次对比没有新增原则。</p>
      ) : (
        <ul className="compare-new">
          {delta.newPrinciples.slice(0, 4).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {delta.newPrinciples.length > 4 && (
        <p className="compare-more">还有 {formatNumber(delta.newPrinciples.length - 4)} 条</p>
      )}

      <p className="compare-applied">
        其中 {formatNumber(delta.appliedPrinciples.length)} 条已经在实际任务中被用到 —— 学过的东西真的在用。
      </p>
    </aside>
  );
}

function signed(n: number): string {
  return n > 0 ? `+${formatNumber(n)}` : formatNumber(n);
}

function profileOptionLabel(p: ProfileSummary): string {
  return `会话 ${formatNumber(p.sessionCount)} · ${formatDateTime(p.capturedAt)}`;
}

function PrincipleRow({ memory, onOpen }: { readonly memory: MemoryItem; readonly onOpen: () => void }): JSX.Element {
  const rate =
    memory.effectiveness !== null && memory.effectiveness.applied > 0
      ? memory.effectiveness.succeeded / memory.effectiveness.applied
      : null;
  return (
    <li>
      <button type="button" className="principle-row" onClick={onOpen}>
        <span className="principle-main">
          <span className="principle-content">{memory.content}</span>
          <span className="principle-meta">
            {memory.principle !== null && <span>当{memory.principle.condition}</span>}
            <span>
              应用 {memory.effectiveness?.applied ?? 0} · 奏效 {memory.effectiveness?.succeeded ?? 0}
              {rate !== null ? ` · ${formatPercent(rate)}` : ''}
            </span>
          </span>
        </span>
        <span className="principle-fitness">
          <span className="mono">{formatPercent(memory.fitness)}</span>
          <Meter value={memory.fitness} tone={memory.fitness >= 0.5 ? 'accent' : 'warn'} />
        </span>
      </button>
    </li>
  );
}
