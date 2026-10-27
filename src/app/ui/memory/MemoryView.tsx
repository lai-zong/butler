'use client';

/**
 * 记忆空间 —— 治理，而不是“查看列表”
 *
 * 这个界面要回答四个问题：
 *   ① 它记住了什么（列表 + 搜索）
 *   ② 凭什么记（证据链 + 置信度）
 *   ③ 这条还该不该留（适应度 + 生命周期 + 手动遗忘）
 *   ④ 哪些是试行记忆（系统自主验证，不需要用户审核）
 *
 * ★ 布局是主从式：左边是记忆，右边是它的“档案”。
 *   移动端把档案变成抽屉，避免两栏挤成一条缝。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Badge,
  EmptyState,
  FilterChip,
  InlineError,
  Meter,
  PageHeader,
  Skeleton,
  StatCard,
} from '../components/Common';
import { Icon, type IconName } from '../components/Icon';
import { Modal } from '../components/Modal';
import { DiaryPanel } from './DiaryPanel';
import { MemoryGraphPanel } from './MemoryGraphPanel';
import { useMediaQuery, useNow } from '../lib/hooks.js';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import {
  DOMAIN_LABEL,
  formatDateTime,
  formatNumber,
  formatPercent,
  relativeTime,
  truncate,
} from '../lib/format.js';
import type {
  MemoryConflictView,
  MemoryConflictsResponse,
  MemoryDetailResponse,
  MemoryItem,
  MemoryKind,
  MemoryLifecycle,
  MemoryListResponse,
  MemoryPreset,
  MemoryRevision,
  MemoryStats,
  Overview,
  SessionSummary,
  SessionsResponse,
  ToastMessage,
  ViewId,
} from '../lib/types.js';

type SortKey = 'priority' | 'updated' | 'fitness' | 'confidence' | 'hits';

const KIND_TONE: Record<MemoryKind, 'neutral' | 'accent' | 'info' | 'warn'> = {
  fact: 'neutral',
  preference: 'info',
  principle: 'accent',
  summary: 'warn',
};

const KIND_ICON: Record<MemoryKind, IconName> = {
  fact: 'info',
  preference: 'sparkle',
  principle: 'shield',
  summary: 'quote',
};

const LIFECYCLE_TONE: Record<MemoryLifecycle, 'accent' | 'warn' | 'neutral' | 'outline'> = {
  candidate: 'warn',
  active: 'accent',
  dormant: 'neutral',
  archived: 'outline',
};

const CLASS_TONE: Record<string, 'danger' | 'info' | 'neutral' | 'outline' | 'accent'> = {
  global_constraint: 'accent',
  global_shared: 'info',
  sensitive: 'danger',
  domain: 'neutral',
};

const SORT_OPTIONS: readonly { readonly value: SortKey; readonly label: string }[] = [
  { value: 'priority', label: '试行优先' },
  { value: 'updated', label: '最近更新' },
  { value: 'fitness', label: '适应度' },
  { value: 'confidence', label: '置信度' },
  { value: 'hits', label: '命中次数' },
];

interface MemoryViewProps {
  readonly overview: Overview | null;
  readonly preset: MemoryPreset;
  readonly onNavigate: (view: ViewId) => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onRefreshOverview: () => void;
  /** 首次取数结束（成功或失败）时调用一次，用于控制台的真实进度。 */
  readonly onFirstReady?: () => void;
}

export function MemoryView({
  overview,
  preset,
  onNavigate,
  notify,
  onRefreshOverview,
  onFirstReady,
}: MemoryViewProps): JSX.Element {
  const [items, setItems] = useState<readonly MemoryItem[]>([]);
  const [conflicts, setConflicts] = useState<readonly MemoryConflictView[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const firstReadyRef = useRef(false);
  const onFirstReadyRef = useRef(onFirstReady);
  onFirstReadyRef.current = onFirstReady;

  const [q, setQ] = useState('');
  const [lifecycle, setLifecycle] = useState<MemoryLifecycle | null>(null);
  const [kind, setKind] = useState<MemoryKind | null>(null);
  const [memClass, setMemClass] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('priority');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const [diaryOpen, setDiaryOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [forgetTarget, setForgetTarget] = useState<MemoryItem | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [hardConfirm, setHardConfirm] = useState(false);

  const [grantOpen, setGrantOpen] = useState(false);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [grantSessions, setGrantSessions] = useState<readonly SessionSummary[]>([]);
  const [grantTaskId, setGrantTaskId] = useState('');
  const [grantPurpose, setGrantPurpose] = useState('');
  const [grantTtlMin, setGrantTtlMin] = useState(30);


  const narrow = useMediaQuery('(max-width: 1179px)');
  const now = useNow(30_000);
  const loadToken = useRef(0);
  const lastPreset = useRef(0);

  const effectiveStats = stats ?? overview?.memory ?? null;

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim().length > 0) sp.set('q', q.trim());
    if (lifecycle !== null) sp.set('lifecycle', lifecycle);
    if (kind !== null) sp.set('kind', kind);
    if (memClass !== null) sp.set('memClass', memClass);
    if (domain !== null) sp.set('domain', domain);
    sp.set('sort', sort);
    return sp.toString();
  }, [q, lifecycle, kind, memClass, domain, sort]);

  const load = useCallback(async (): Promise<void> => {
    const token = ++loadToken.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJson<MemoryListResponse>(`/api/memory?${query}`);
      if (token !== loadToken.current) return;
      setItems(res.items);
      setStats(res.stats);
      setTotal(res.total);
      setTruncated(res.truncated);

      // 冲突关系来自事件流，不是 MemoryEntry 字段；失败不影响列表。
      try {
        const c = await fetchJson<MemoryConflictsResponse>('/api/memory/conflicts');
        if (token === loadToken.current) setConflicts(c.conflicts);
      } catch {
        if (token === loadToken.current) setConflicts([]);
      }
    } catch (err) {
      if (token !== loadToken.current) return;
      setError(errorMessage(err));
    } finally {
      if (token === loadToken.current) {
        setLoading(false);
        if (!firstReadyRef.current) {
          firstReadyRef.current = true;
          onFirstReadyRef.current?.();
        }
      }
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), q.trim().length > 0 ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [load, q]);

  const loadDetail = useCallback(
    async (id: string): Promise<void> => {
      setDetailLoading(true);
      try {
        const res = await fetchJson<MemoryDetailResponse>(`/api/memory?id=${encodeURIComponent(id)}`);
        setDetail(res);
      } catch (err) {
        notify(errorMessage(err), 'danger');
      } finally {
        setDetailLoading(false);
      }
    },
    [notify],
  );

  // 从别处带来的意图：试行 / 单条详情 / 某条筛选
  useEffect(() => {
    if (preset.nonce === 0 || lastPreset.current === preset.nonce) return;
    lastPreset.current = preset.nonce;

    setQ(preset.q ?? '');
    setKind(null);
    setMemClass(null);
    setDomain(null);
    setSort('priority');

    if (preset.pending === true) {
      setLifecycle('candidate');
    } else if (preset.lifecycle !== undefined) {
      setLifecycle(preset.lifecycle);
    } else if (preset.id !== undefined) {
      setLifecycle(null);
    }

    if (preset.id !== undefined) {
      setSelectedId(preset.id);
      setDetail(null);
      void loadDetail(preset.id);
      if (narrow) setSheetOpen(true);
    }
  }, [preset, narrow, loadDetail]);

  function select(item: MemoryItem): void {
    setSelectedId(item.id);
    setDetail(null);
    void loadDetail(item.id);
    if (narrow) setSheetOpen(true);
  }

  async function forget(): Promise<void> {
    const target = forgetTarget;
    if (target === null || forgetting) return;
    const isHard = target.memClass === 'global_constraint';
    if (isHard && !hardConfirm) return;
    setForgetting(true);
    try {
      await postJson('/api/memory/forget', {
        id: target.id,
        ...(isHard ? { hardConstraintConfirmation: 'confirmed' } : {}),
      });
      notify(
        isHard
          ? '硬约束已删除，并留下不可还原的墓碑。'
          : '已删除，并从相关审计事件里抹除了原文。',
        'success',
      );
      setForgetTarget(null);
      setHardConfirm(false);
      if (selectedId === target.id) {
        setSelectedId(null);
        setDetail(null);
        setSheetOpen(false);
      }
      await load();
      onRefreshOverview();
    } catch (err) {
      notify(errorMessage(err), 'danger');
    } finally {
      setForgetting(false);
    }
  }

  const selectedItem = detail?.item ?? items.find((i) => i.id === selectedId) ?? null;
  const conflictByMemory = useMemo(
    () => new Map(conflicts.map((c) => [c.memoryId, c])),
    [conflicts],
  );
  const selectedConflict =
    selectedItem !== null ? conflictByMemory.get(selectedItem.id) : undefined;

  async function openGrant(): Promise<void> {
    if (selectedItem === null || selectedItem.memClass !== 'sensitive') return;
    setGrantOpen(true);
    setGrantError(null);
    setGrantPurpose('');
    setGrantTtlMin(30);
    setGrantTaskId('');
    try {
      const res = await fetchJson<SessionsResponse>('/api/sessions');
      setGrantSessions(res.sessions);
      setGrantTaskId(res.sessions[0]?.id ?? '');
      if (res.sessions.length === 0) {
        setGrantError('还没有任务会话。先在对话里开始一轮，再回来授权。');
      }
    } catch (err) {
      setGrantError(errorMessage(err));
    }
  }

  async function submitGrant(): Promise<void> {
    if (selectedItem === null || grantBusy) return;
    const taskId = grantTaskId.trim();
    const purpose = grantPurpose.trim();
    if (taskId.length === 0) {
      setGrantError('请选择一个任务会话');
      return;
    }
    if (purpose.length === 0) {
      setGrantError('请填写用途；它会写入审计');
      return;
    }
    setGrantBusy(true);
    setGrantError(null);
    try {
      await postJson('/api/memory/grant', {
        memoryId: selectedItem.id,
        taskId,
        purpose,
        ttlMs: grantTtlMin * 60_000,
      });
      setGrantOpen(false);
      notify(`已授权 ${grantTtlMin} 分钟；任务结束或取消会自动撤销。`, 'success');
      await load();
      await loadDetail(selectedItem.id);
    } catch (err) {
      setGrantError(errorMessage(err));
    } finally {
      setGrantBusy(false);
    }
  }

  const hasFilters =
    q.trim().length > 0 ||
    lifecycle !== null ||
    kind !== null ||
    memClass !== null ||
    domain !== null;

  function clearFilters(): void {
    setQ('');
    setLifecycle(null);
    setKind(null);
    setMemClass(null);
    setDomain(null);
    setSort('priority');
  }

  const detailNode = (
    <MemoryDetail
      item={selectedItem}
      revisions={detail?.revisions ?? []}
      loading={detailLoading}
      onForget={() => {
        if (selectedItem !== null) {
          setHardConfirm(false);
          setForgetTarget(selectedItem);
        }
      }}
      onGrant={() => void openGrant()}
      {...(selectedConflict !== undefined ? { conflict: selectedConflict } : {})}
      now={now}
    />
  );

  if (graphOpen) {
    return (
      <MemoryGraphPanel
        onBack={() => setGraphOpen(false)}
        onSelectMemory={(id) => {
          setGraphOpen(false);
          setSelectedId(id);
          setDetail(null);
          void loadDetail(id);
          if (narrow) setSheetOpen(true);
        }}
      />
    );
  }

  if (diaryOpen) {
    return <DiaryPanel onBack={() => setDiaryOpen(false)} />;
  }

  return (
    <div className="page memory-page">
      <PageHeader
        eyebrow="MEMORY / GOVERNANCE"
        title="记忆"
        description={
          effectiveStats !== null
            ? `它现在记得 ${formatNumber(effectiveStats.total)} 条。每一条都能追问来源，最终由你决定是否删除。`
            : '每一条记忆都能追问来源，最终由你决定是否删除。'
        }
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setGraphOpen(true)}>
              <Icon name="memory" size={15} /> 图谱
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setDiaryOpen(true)}>
              <Icon name="quote" size={15} /> 日记
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void load()} disabled={loading}>
              <Icon name="refresh" size={15} className={loading ? 'spin' : ''} /> 刷新
            </button>
          </>
        }
      />

      <div className="stat-grid stat-grid--4">
        <StatCard
          label="全部记忆"
          value={effectiveStats?.total ?? 0}
          icon="memory"
          note={
            effectiveStats !== null
              ? `近 7 天新增 ${effectiveStats.addedLast7Days} 条`
              : undefined
          }
        />
        <StatCard
          label="活跃"
          value={effectiveStats?.active ?? 0}
          icon="checkCircle"
          tone="accent"
          note={effectiveStats !== null ? `近 7 天命中 ${effectiveStats.hitLast7Days} 条` : undefined}
        />
        <StatCard
          label="试行记忆"
          value={effectiveStats?.pending ?? 0}
          icon="clock"
          note="系统自主观察，不需要审核"
          onClick={() => setLifecycle('candidate')}
        />
        <StatCard
          label="平均适应度"
          value={(effectiveStats?.avgFitness ?? 0) * 100}
          suffix="%"
          decimals={0}
          animate={false}
          icon="growth"
          note="按使用与效果持续调整"
        />
      </div>

      <div className="memory-layout">
        <section className="memory-list-pane">
          <div className="memory-toolbar">
            <div className="search-field">
              <Icon name="search" size={16} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索内容、主体、原则条件…"
                aria-label="搜索记忆"
              />
              {q.length > 0 && (
                <button type="button" className="icon-btn icon-btn--sm" onClick={() => setQ('')} aria-label="清空搜索">
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>

            <div className="filter-row">
              <FilterChip
                active={lifecycle === null}
                count={effectiveStats?.total}
                onClick={() => setLifecycle(null)}
              >
                全部
              </FilterChip>
              <FilterChip
                active={lifecycle === 'candidate'}
                count={effectiveStats?.byLifecycle.candidate}
                onClick={() => setLifecycle('candidate')}
              >
                试行
              </FilterChip>
              <FilterChip
                active={lifecycle === 'active'}
                count={effectiveStats?.byLifecycle.active}
                onClick={() => setLifecycle('active')}
              >
                活跃
              </FilterChip>
              <FilterChip
                active={lifecycle === 'dormant'}
                count={effectiveStats?.byLifecycle.dormant}
                onClick={() => setLifecycle('dormant')}
              >
                休眠
              </FilterChip>
              <FilterChip
                active={lifecycle === 'archived'}
                count={effectiveStats?.byLifecycle.archived}
                onClick={() => setLifecycle('archived')}
              >
                归档
              </FilterChip>
            </div>

            <div className="select-row">
              <Select
                label="类型"
                value={kind ?? ''}
                onChange={(v) => setKind(v === '' ? null : (v as MemoryKind))}
                options={[
                  { value: '', label: '全部类型' },
                  { value: 'fact', label: '事实' },
                  { value: 'preference', label: '偏好' },
                  { value: 'principle', label: '原则' },
                  { value: 'summary', label: '长期状态' },
                ]}
              />
              <Select
                label="领域"
                value={domain ?? ''}
                onChange={(v) => setDomain(v === '' ? null : v)}
                options={[
                  { value: '', label: '全部领域' },
                  ...Object.entries(DOMAIN_LABEL)
                    .filter(([id]) => id !== 'butler')
                    .map(([id, label]) => ({ value: id, label })),
                ]}
              />
              <Select
                label="类别"
                value={memClass ?? ''}
                onChange={(v) => setMemClass(v === '' ? null : v)}
                options={[
                  { value: '', label: '全部类别' },
                  { value: 'global_constraint', label: '硬约束' },
                  { value: 'global_shared', label: '共享事实' },
                  { value: 'sensitive', label: '敏感域' },
                  { value: 'domain', label: '领域记忆' },
                ]}
              />
              <Select
                label="排序"
                value={sort}
                onChange={(v) => setSort(v as SortKey)}
                options={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
              {hasFilters && (
                <button type="button" className="text-btn clear-filters" onClick={clearFilters}>
                  <Icon name="close" size={13} /> 清除筛选
                </button>
              )}
            </div>
          </div>

          <div className="list-meta">
            <span>
              {loading ? '正在读取…' : `${formatNumber(total)} 条`}
              {hasFilters && !loading ? '（已筛选）' : ''}
            </span>
            {truncated && <span className="list-meta-warn">仅显示前 500 条</span>}
          </div>

          {error !== null && <InlineError message={error} onRetry={() => void load()} />}

          {loading && items.length === 0 && (
            <div className="memory-skeleton">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="mem-card-skeleton">
                  <Skeleton rows={2} height={14} />
                </div>
              ))}
            </div>
          )}

          {!loading && items.length === 0 && error === null && (
            <div className="memory-empty">
              {hasFilters ? (
                <EmptyState
                  icon="filter"
                  title="没有匹配的记忆"
                  description="换一个关键词，或清除筛选看看全部。"
                  action={
                    <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                      清除筛选
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  icon="memory"
                  title="还没有记住任何事"
                  description={
                    <>
                      对话结束后，管家会从这一轮里提取事实、偏好和原则。
                      <br />
                      候选需要你确认，未确认的内容不会进入召回。
                    </>
                  }
                  action={
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate('chat')}>
                      去对话
                      <Icon name="chevronRight" size={14} />
                    </button>
                  }
                />
              )}
            </div>
          )}

          <div className="memory-cards">
            {items.map((item, i) => (
              <MemoryCard
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                index={i}
                conflict={conflictByMemory.has(item.id)}
                onSelect={() => select(item)}
                now={now}
              />
            ))}
          </div>
        </section>

        {!narrow && <aside className="memory-detail-pane">{detailNode}</aside>}
      </div>

      {narrow && (
        <Modal
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title="记忆档案"
          description="来源、版本与去留都在这里。"
          variant="sheet"
        >
          {detailNode}
        </Modal>
      )}

      <Modal
        open={forgetTarget !== null}
        onClose={() => {
          setForgetTarget(null);
          setHardConfirm(false);
        }}
        title={
          forgetTarget?.memClass === 'global_constraint' ? '删除全局硬约束？' : '彻底删除这条记忆？'
        }
        description={
          forgetTarget?.memClass === 'global_constraint'
            ? '这是安全边界。删除后系统不再自动规避这条约束，必须由你二次确认。'
            : '这会从记忆库里移除内容，无法恢复到删除前的状态。'
        }
        footer={
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setForgetTarget(null);
                setHardConfirm(false);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void forget()}
              disabled={
                forgetting ||
                (forgetTarget?.memClass === 'global_constraint' && !hardConfirm)
              }
            >
              {forgetting
                ? '删除中…'
                : forgetTarget?.memClass === 'global_constraint'
                  ? '确认删除硬约束'
                  : '彻底删除'}
            </button>
          </div>
        }
      >
        {forgetTarget !== null && (
          <div className="forget-confirm">
            <p className="forget-content">{forgetTarget.content}</p>
            {forgetTarget.memClass === 'global_constraint' ? (
              <>
                <p className="forget-note">
                  删除后会留下不可还原的墓碑；系统以后不会再自动遵守这条约束。
                </p>
                <label className="hard-confirm">
                  <input
                    type="checkbox"
                    checked={hardConfirm}
                    onChange={(e) => setHardConfirm(e.target.checked)}
                  />
                  <span>我确认删除这条硬约束，并理解后果。</span>
                </label>
              </>
            ) : (
              <p className="forget-note">
                事件日志里只会留下“这条被删除过”的事实，不会保留内容本身。
              </p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        title="授权给当前任务"
        description="敏感域记忆默认不可读；只对指定任务、指定时间开放。"
        footer={
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setGrantOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void submitGrant()} disabled={grantBusy}>
              {grantBusy ? '授权中…' : `授权 ${grantTtlMin} 分钟`}
            </button>
          </div>
        }
      >
        {grantError !== null && <p className="grant-error">{grantError}</p>}
        {selectedItem !== null && (
          <div className="grant-current">
            <span>将要开放</span>
            <strong>{truncate(selectedItem.content, 80)}</strong>
          </div>
        )}
        <div className="grant-form">
          <label className="grant-field">
            <span>任务</span>
            <select
              value={grantTaskId}
              onChange={(e) => setGrantTaskId(e.target.value)}
              disabled={grantBusy || grantSessions.length === 0}
              aria-label="选择任务会话"
            >
              {grantSessions.length === 0 && <option value="">没有可用会话</option>}
              {grantSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} · {relativeTime(s.updatedAt, now)}
                </option>
              ))}
            </select>
          </label>
          <label className="grant-field">
            <span>用途（写入审计）</span>
            <textarea
              value={grantPurpose}
              onChange={(e) => setGrantPurpose(e.target.value)}
              maxLength={200}
              placeholder="例如：晚餐订位需要读取“安静、靠窗”的偏好"
              disabled={grantBusy}
            />
          </label>
          <label className="grant-field">
            <span>有效期</span>
            <select
              value={grantTtlMin}
              onChange={(e) => setGrantTtlMin(Number(e.target.value))}
              disabled={grantBusy}
            >
              <option value={30}>30 分钟</option>
              <option value={120}>2 小时</option>
              <option value={1440}>24 小时</option>
            </select>
          </label>
        </div>
        <p className="grant-note">任务结束或取消时自动撤销；授权记录包含 taskId、用途与到期时间，可在审计中查看。</p>
      </Modal>

    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 卡片
// ═══════════════════════════════════════════════════════════

function MemoryCard({
  item,
  selected,
  index,
  conflict,
  onSelect,
  now,
}: {
  readonly item: MemoryItem;
  readonly selected: boolean;
  readonly index: number;
  readonly conflict: boolean;
  readonly onSelect: () => void;
  readonly now: number;
}): JSX.Element {
  const candidate = item.lifecycle === 'candidate';
  return (
    <article
      className={`mem-card ${selected ? 'is-selected' : ''} ${candidate ? 'is-candidate' : ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}
    >
      <button type="button" className="mem-card-hit" onClick={onSelect} aria-label={`查看记忆：${truncate(item.content, 40)}`} />

      <div className="mem-card-head">
        <span className="mem-kind">
          <Icon name={KIND_ICON[item.kind]} size={12} />
          {item.kindLabel}
        </span>
        <Badge tone={CLASS_TONE[item.memClass] ?? 'neutral'}>{item.memClassLabel}</Badge>
        <Badge tone={LIFECYCLE_TONE[item.lifecycle]}>
          {item.lifecycle === 'candidate' ? '试行' : item.lifecycleLabel}
        </Badge>
        {conflict && <Badge tone="warn">可能冲突</Badge>}
        {item.domainLabel !== null && <span className="mem-domain">{item.domainLabel}</span>}
        <span className="mem-time">{relativeTime(item.updatedAt, now)}</span>
      </div>

      <p className="mem-content">{item.content}</p>

      <div className="mem-meta-row">
        <span className="mem-fitness">
          <span className="mini-meter" aria-hidden="true">
            <i style={{ width: `${Math.round(item.fitness * 100)}%` }} />
          </span>
          适应度 {formatPercent(item.fitness)}
        </span>
        <span>置信 {formatPercent(item.confidence)}</span>
        <span>{item.hitCount} 次命中</span>
        {item.kind === 'principle' && item.effectiveness !== null && (
          <span>
            应用 {item.effectiveness.applied} · 奏效 {item.effectiveness.succeeded}
          </span>
        )}
        {item.hasCredential && (
          <span className="mem-lock">
            <Icon name="lock" size={11} /> 可用不可见
          </span>
        )}
      </div>

    </article>
  );
}

// ═══════════════════════════════════════════════════════════
// 详情
// ═══════════════════════════════════════════════════════════

function MemoryDetail({
  item,
  revisions,
  loading,
  onForget,
  onGrant,
  conflict,
  now,
}: {
  readonly item: MemoryItem | null;
  readonly revisions: readonly MemoryRevision[];
  readonly loading: boolean;
  readonly onForget: () => void;
  readonly onGrant: () => void;
  readonly conflict?: MemoryConflictView;
  readonly now: number;
}): JSX.Element {
  if (item === null) {
    return (
      <div className="detail-empty">
        <EmptyState
          icon="memory"
          title="选一条记忆"
          description="选中后，这里会显示它的来源、版本与去留。"
        />
      </div>
    );
  }

  const hard = item.memClass === 'global_constraint';
  const sensitive = item.memClass === 'sensitive';
  const candidate = item.lifecycle === 'candidate';
  const successRate =
    item.effectiveness !== null && item.effectiveness.applied > 0
      ? item.effectiveness.succeeded / item.effectiveness.applied
      : null;

  return (
    <div className="memory-detail">
      <div className="detail-head">
        <div className="detail-badges">
          <Badge tone={KIND_TONE[item.kind]}>{item.kindLabel}</Badge>
          <Badge tone={CLASS_TONE[item.memClass] ?? 'neutral'}>{item.memClassLabel}</Badge>
          <Badge tone={LIFECYCLE_TONE[item.lifecycle]}>
          {item.lifecycle === 'candidate' ? '试行' : item.lifecycleLabel}
        </Badge>
        </div>
      </div>

      <p className="detail-content">{item.content}</p>
      {item.subject !== null && <p className="detail-subject">主体 · {item.subject}</p>}

      {sensitive && (
        <div className="detail-grant">
          <div>
            <strong>敏感域记忆 · 默认不可读</strong>
            <p>只对指定任务、指定时间开放；任务结束或取消时自动撤销。</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={onGrant}>
            <Icon name="lock" size={14} /> 授权给当前任务
          </button>
        </div>
      )}

      {conflict !== undefined && (
        <div className="detail-conflict">
          <div className="detail-conflict-head">
            <span className="badge-warn">可能冲突</span>
            <small>{conflict.detector === 'model' ? '自动检测 · 模型' : '自动检测 · 显式否定'}</small>
          </div>
          <p className="detail-conflict-reason">发现可能冲突：{conflict.reason}</p>
          <p className="detail-conflict-other">另一条：{truncate(conflict.other.content, 100)}</p>
          <p className="detail-footnote">
            冲突由系统自动裁决并留下审计记录；用户不再手动决定保留哪一条。
          </p>
        </div>
      )}

      {candidate && (
        <div className="detail-review">
          <p>这是试行记忆，由系统自动验证；不需要你审核。用户只保留删除权。</p>
        </div>
      )}

      <div className="detail-metrics">
        <div className="detail-metric">
          <span>置信度</span>
          <strong className="mono">{formatPercent(item.confidence)}</strong>
          <Meter value={item.confidence} tone="muted" />
        </div>
        <div className="detail-metric">
          <span>适应度</span>
          <strong className="mono">{formatPercent(item.fitness)}</strong>
          <Meter value={item.fitness} tone={item.fitness >= 0.5 ? 'accent' : 'warn'} />
        </div>
      </div>

      <dl className="detail-grid">
        <div>
          <dt>领域</dt>
          <dd>{item.domainLabel ?? '全局'}</dd>
        </div>
        <div>
          <dt>范围</dt>
          <dd>{item.scope === 'global' ? '全局' : item.scope === 'domain' ? '领域' : '单次会话'}</dd>
        </div>
        <div>
          <dt>命中 / 使用</dt>
          <dd className="mono">{item.hitCount} / {item.useCount}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd className="mono">v{item.version}</dd>
        </div>
        <div>
          <dt>创建</dt>
          <dd>{formatDateTime(item.createdAt)}</dd>
        </div>
        <div>
          <dt>更新</dt>
          <dd>{relativeTime(item.updatedAt, now)}</dd>
        </div>
      </dl>

      {item.principle !== null && (
        <div className="detail-section">
          <p className="mini-label">原则结构</p>
          <div className="principle-box">
            <p>
              <span>当</span>
              {item.principle.condition}
            </p>
            <p>
              <span>则</span>
              {item.principle.action}
            </p>
            {item.principle.fromVerdict !== null && (
              <small>来自一次冲突裁决</small>
            )}
          </div>
        </div>
      )}

      {item.effectiveness !== null && (
        <div className="detail-section">
          <p className="mini-label">效果跟踪</p>
          <div className="effect-row">
            <div>
              <strong className="mono">{item.effectiveness.applied}</strong>
              <span>次应用</span>
            </div>
            <div>
              <strong className="mono">{item.effectiveness.succeeded}</strong>
              <span>次奏效</span>
            </div>
            <div>
              <strong className="mono">{successRate !== null ? formatPercent(successRate) : '—'}</strong>
              <span>成功率</span>
            </div>
          </div>
          {item.effectiveness.lastAppliedAt > 0 && (
            <p className="detail-footnote">上次应用：{relativeTime(item.effectiveness.lastAppliedAt, now)}</p>
          )}
        </div>
      )}

      <div className="detail-section">
        <p className="mini-label">证据链 · {item.evidenceCount} 条事件</p>
        {item.evidence.length > 0 ? (
          <ul className="evidence-list">
            {item.evidence.slice(0, 8).map((id) => (
              <li key={id} className="mono">
                {id}
              </li>
            ))}
          </ul>
        ) : (
          <p className="detail-footnote">这条记忆没有留下事件引用。</p>
        )}
        {item.grantCount > 0 && (
          <p className="detail-footnote">敏感域授权记录：{item.grantCount} 次</p>
        )}
      </div>

      {loading && <Skeleton rows={2} height={12} />}

      {revisions.length > 0 && (
        <div className="detail-section">
          <p className="mini-label">版本历史 · {revisions.length}</p>
          <ul className="revision-list">
            {revisions.slice(0, 6).map((r) => (
              <li key={r.id}>
                <span className="revision-dot" aria-hidden="true" />
                <div>
                  <p>
                    v{r.version} · {r.reason.length > 0 ? r.reason : '修订'}
                  </p>
                  <small>
                    {r.actor} · {relativeTime(r.createdAt, now)}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="detail-danger">
        <div>
          <p>遗忘权</p>
          <small>
            {hard
              ? '硬约束需要二次确认才能删除；删除后留下不可还原的墓碑。'
              : '删除内容，并抹除审计事件里的原文。'}
          </small>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-ghost-danger"
          title={hard ? '删除硬约束需要二次确认' : '彻底删除'}
          onClick={onForget}
        >
          <Icon name="trash" size={14} /> 删除
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 小部件
// ═══════════════════════════════════════════════════════════

function Select({
  label,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}): JSX.Element {
  return (
    <span className="select-wrap">
      <span className="select-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={13} className="select-chevron" />
    </span>
  );
}
