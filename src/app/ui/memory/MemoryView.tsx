'use client';

/**
 * 记忆空间 —— 一片可以走进去的星空
 *
 * ★ 默认读法是星图，而不是列表：
 *   每条记忆是一颗球，球与球之间的连线才是这一页真正的内容。
 *   需要逐条阅读正文时，再切到「文本」目录 —— 两种视图共用同一批记忆、
 *   同一套搜索 / 生命周期筛选和同一个详情侧栏。
 *
 * ★ 2D 与 3D 共用同一批星体、同一份关系，只换投影。
 *   切换时位置做补间，所以你会看到星群“展开 / 压平”，而不是换一张图。
 *
 * ★ 星图球面上不写文字；正文只在「文本」目录和右侧详情里出现。
 *   这样页面的第一眼永远是结构，而不是一张需要逐条阅读的长列表。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../components/Icon';
import { errorMessage, fetchJson } from '../lib/api.js';
import {
  LIFECYCLE_LABEL,
  formatNumber,
  truncate,
} from '../lib/format.js';
import type {
  MemoryDetailResponse,
  MemoryGraphResponse,
  MemoryLifecycle,
  MemoryPreset,
  MemoryRevision,
  Overview,
  ToastMessage,
  ViewId,
} from '../lib/types.js';
import {
  EDGE_META,
  LIFECYCLE_COLOR,
  LIFECYCLE_ORDER,
  buildStarMap,
  edgeLegend,
  matchesQuery,
  rgba,
  type MapMode,
  type StarEdge,
  type StarNode,
} from './starMap.js';
import { MemoryCanvas, type MemoryCanvasHandle } from './MemoryCanvas';
import { MemoryDetail, type MemoryConnection } from './MemoryDetail';
import { MemoryModelSettings } from './MemoryModelSettings';
import { MemoryText } from './MemoryText';

/** 星图两种投影 + 文本目录。 */
type MemoryViewMode = MapMode | 'text';

interface MemoryViewProps {
  readonly overview: Overview | null;
  readonly preset: MemoryPreset;
  readonly onNavigate: (view: ViewId) => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onRefreshOverview: () => void;
  /** 首次取数结束（无论成败）调用一次，用于控制台的启动进度。 */
  readonly onFirstReady?: () => void;
}

const EDGE_PRIORITY: Record<StarEdge['type'], number> = {
  conflict: 0,
  semantic: 1,
  content: 2,
  sharedEvidence: 3,
  merge: 4,
  coRecall: 5,
};

const EMPTY_MAP = buildStarMap([], []);

export function MemoryView({
  overview,
  preset,
  onNavigate,
  notify,
  onRefreshOverview,
  onFirstReady,
}: MemoryViewProps): JSX.Element {
  const [mode, setMode] = useState<MemoryViewMode>('3d');
  const [autoRotate, setAutoRotate] = useState(true);
  const [filter, setFilter] = useState<'all' | MemoryLifecycle>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [announce, setAnnounce] = useState('');
  const [layoutCustomized, setLayoutCustomized] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);

  const [graph, setGraph] = useState<MemoryGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [revisions, setRevisions] = useState<readonly MemoryRevision[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [revisionsError, setRevisionsError] = useState<string | null>(null);
  const [revisionNonce, setRevisionNonce] = useState(0);

  const canvasRef = useRef<MemoryCanvasHandle | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const lastSelectedRef = useRef<StarNode | null>(null);
  const firstReadyRef = useRef(false);
  const firstReadyCallbackRef = useRef(onFirstReady);
  firstReadyCallbackRef.current = onFirstReady;
  const appliedPresetRef = useRef(0);
  const pendingSelectRef = useRef<string | null>(null);
  /** 进入文本模式时记住上一次星图投影，文本期间隐藏的画布继续用它。 */
  const lastStarModeRef = useRef<MapMode>('3d');
  useEffect(() => {
    if (mode !== 'text') lastStarModeRef.current = mode;
  }, [mode]);
  const isText = mode === 'text';
  const canvasMode: MapMode = isText ? lastStarModeRef.current : mode;

  const starMap = useMemo(() => (graph === null ? EMPTY_MAP : buildStarMap(graph.nodes, graph.edges)), [graph]);
  const nodes = starMap.nodes;

  const nodeById = useMemo(() => {
    const map = new Map<string, StarNode>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);

  const selectedNode = selectedId === null ? null : nodeById.get(selectedId) ?? null;

  const panelNode = selectedNode ?? lastSelectedRef.current;

  const counts = useMemo(() => {
    const result: Record<MemoryLifecycle, number> = {
      active: 0,
      candidate: 0,
      dormant: 0,
      archived: 0,
    };
    for (const node of nodes) result[node.item.lifecycle] += 1;
    return result;
  }, [nodes]);

  const legend = useMemo(() => edgeLegend(starMap.edges), [starMap]);

  const connections = useMemo<readonly MemoryConnection[]>(() => {
    if (selectedNode === null) return [];
    const index = starMap.index.get(selectedNode.id);
    if (index === undefined) return [];
    const list: MemoryConnection[] = [];
    for (const edge of starMap.edges) {
      if (edge.a !== index && edge.b !== index) continue;
      const other = nodes[edge.a === index ? edge.b : edge.a];
      if (other === undefined) continue;
      list.push({ edge, other });
    }
    list.sort(
      (u, v) =>
        EDGE_PRIORITY[u.edge.type] - EDGE_PRIORITY[v.edge.type] || v.edge.weight - u.edge.weight,
    );
    return list;
  }, [selectedNode, starMap, nodes]);

  const totalMemories = overview?.memory.total ?? graph?.total.nodes ?? nodes.length;
  const pending = overview?.memory.pending ?? counts.candidate;
  const truncated = totalMemories > nodes.length;
  const filteredNodes = useMemo(() => {
    const q = query.trim();
    return nodes.filter((node) => {
      if (filter !== 'all' && node.item.lifecycle !== filter) return false;
      if (q.length > 0 && !matchesQuery(node.item, q)) return false;
      return true;
    });
  }, [nodes, filter, query]);

  // ── 取星图 ──
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetchJson<MemoryGraphResponse>('/api/memory/graph');
        if (!cancelled) setGraph(response);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (!firstReadyRef.current) {
            firstReadyRef.current = true;
            firstReadyCallbackRef.current?.();
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const selectNode = useCallback(
    (id: string): void => {
      const node = nodeById.get(id);
      if (node === undefined) return;
      setSelectedId(id);
      setFocusNonce((value) => value + 1);
      setAnnounce(
        `已打开记忆：${node.item.lifecycleLabel} · ${node.item.kindLabel}。${truncate(node.item.content, 48)}`,
      );
    },
    [nodeById],
  );

  const clearSelection = useCallback((): void => {
    setSelectedId(null);
    setAnnounce('已收起记忆详情。');
  }, []);

  const changeMode = useCallback((next: MemoryViewMode): void => {
    setMode(next);
    try {
      window.localStorage.setItem('butler.memory.view', next);
    } catch {
      // 隐私模式下不可写，忽略
    }
  }, []);

  const refresh = useCallback((): void => {
    setNonce((value) => value + 1);
    onRefreshOverview();
  }, [onRefreshOverview]);

  const locateSelected = useCallback((): void => {
    if (selectedId === null) return;
    // 文本目录里的“定位到星图”先把视图切回 2D，再让镜头找到它。
    if (mode === 'text') changeMode('2d');
    setFocusNonce((value) => value + 1);
  }, [selectedId, mode, changeMode]);

  const resetLayout = useCallback((): void => {
    canvasRef.current?.resetLayout();
    if (selectedId !== null) setFocusNonce((value) => value + 1);
    notify('已恢复自动排布', 'success');
  }, [selectedId, notify]);

  const copyId = useCallback((): void => {
    if (selectedId === null) return;
    void (async () => {
      try {
        await navigator.clipboard.writeText(selectedId);
        notify('记忆 ID 已复制', 'success');
      } catch {
        notify('复制失败，请手动选择 ID', 'danger');
      }
    })();
  }, [selectedId, notify]);

  const deleteMemory = useCallback(
    async (id: string, hardConstraint: boolean): Promise<string | null> => {
      try {
        const response = await fetch('/api/memory/forget', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            ...(hardConstraint ? { hardConstraintConfirmation: 'confirmed' } : {}),
          }),
        });
        const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
        if (!response.ok) {
          return typeof payload?.error === 'string'
            ? payload.error
            : `删除失败（HTTP ${response.status}）`;
        }
        setSelectedId(null);
        setAnnounce('记忆已删除。');
        setNonce((value) => value + 1);
        onRefreshOverview();
        notify('这条记忆已删除，无法恢复。', 'success');
        return null;
      } catch (err) {
        return errorMessage(err);
      }
    },
    [notify, onRefreshOverview],
  );

  // ── 记住上次使用的投影 / 文本模式 ──
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('butler.memory.view');
      if (saved === '2d' || saved === '3d' || saved === 'text') setMode(saved);
    } catch {
      // 忽略
    }
  }, []);

  // ── 从其它空间带过来的意图 ──
  useEffect(() => {
    if (preset.nonce === 0 || appliedPresetRef.current === preset.nonce) return;
    appliedPresetRef.current = preset.nonce;
    if (preset.lifecycle !== undefined) setFilter(preset.lifecycle);
    else if (preset.pending === true) setFilter('candidate');
    else setFilter('all');
    setQuery(preset.q ?? '');
    if (preset.id !== undefined && preset.id.length > 0) {
      if (nodeById.has(preset.id)) selectNode(preset.id);
      else if (graph !== null) {
        notify('这条记忆不在当前星图中（星图只展示最近 200 条）。', 'warning');
      } else {
        pendingSelectRef.current = preset.id;
      }
    }
  }, [preset, nodeById, selectNode, graph, notify]);

  // 图还没到时先把目标 id 存着，到了再选中。
  useEffect(() => {
    if (graph === null) return;
    const id = pendingSelectRef.current;
    if (id === null) return;
    pendingSelectRef.current = null;
    if (nodeById.has(id)) selectNode(id);
    else notify('这条记忆不在当前星图中（星图只展示最近 200 条）。', 'warning');
  }, [graph, nodeById, selectNode, notify]);

  // 刷新后选中的星可能已经不在了。
  useEffect(() => {
    if (graph === null || selectedId === null) return;
    if (!graph.nodes.some((node) => node.id === selectedId)) setSelectedId(null);
  }, [graph, selectedId]);

  useEffect(() => {
    if (selectedNode !== null) lastSelectedRef.current = selectedNode;
  }, [selectedNode]);

  // ── 详情：修订历史按需取 ──
  useEffect(() => {
    if (selectedId === null) return;
    const controller = new AbortController();
    setRevisions([]);
    setRevisionsError(null);
    setRevisionsLoading(true);
    void (async () => {
      try {
        const response = await fetchJson<MemoryDetailResponse>(
          `/api/memory?id=${encodeURIComponent(selectedId)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setRevisions(response.revisions);
      } catch (err) {
        if (!controller.signal.aborted) setRevisionsError(errorMessage(err));
      } finally {
        if (!controller.signal.aborted) setRevisionsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selectedId, revisionNonce, graph]);

  // 面板关闭时不可聚焦：aria-hidden 挡不住 Tab，inert 可以。
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    panel.toggleAttribute('inert', selectedId === null);
    return () => {
      panel.removeAttribute('inert');
    };
  }, [selectedId]);

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);

  // Esc 收起详情。范围只在这一页，不影响别处。
  useEffect(() => {
    if (selectedId === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        setSelectedId(null);
        setAnnounce('已收起记忆详情。');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (filteredNodes.length === 0) return;
      const currentIndex =
        selectedId === null ? -1 : filteredNodes.findIndex((node) => node.id === selectedId);

      const pick = (index: number): void => {
        const next = filteredNodes[(index + filteredNodes.length) % filteredNodes.length];
        if (next !== undefined) selectNode(next.id);
      };

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          pick(currentIndex + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          pick(currentIndex <= 0 ? filteredNodes.length - 1 : currentIndex - 1);
          break;
        case 'Home':
          event.preventDefault();
          pick(0);
          break;
        case 'End':
          event.preventDefault();
          pick(filteredNodes.length - 1);
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          if (currentIndex < 0) pick(0);
          else locateSelected();
          break;
        case 'Escape':
          if (selectedId !== null) {
            event.preventDefault();
            clearSelection();
          }
          break;
        default:
          break;
      }
    },
    [filteredNodes, selectedId, selectNode, locateSelected, clearSelection],
  );

  const handleRefresh = useCallback((): void => {
    refresh();
    notify('正在重新读取记忆关系…');
  }, [refresh, notify]);

  const hasNodes = nodes.length > 0;

  return (
    <section
      className={`mm${isText ? ' is-text' : ''}`}
      aria-label={isText ? '记忆文本' : '记忆星图'}
    >
      <div className="mm-aura" aria-hidden="true" />

      <MemoryCanvas
        ref={canvasRef}
        nodes={nodes}
        edges={starMap.edges}
        mode={canvasMode}
        selectedId={selectedId}
        filter={filter}
        query={query}
        focusNonce={focusNonce}
        autoRotate={autoRotate}
        panelOpen={selectedId !== null}
        backdropOnly={isText}
        onSelect={selectNode}
        onClearSelection={clearSelection}
        onKeyDown={handleKeyDown}
        onManualLayoutChange={setLayoutCustomized}
      />

      {/* 文本目录放在画布之后、详情之前：
          键盘用户从某一行按 Tab 就能直接进入详情。 */}
      {isText && hasNodes && (
        <MemoryText
          nodes={filteredNodes}
          counts={counts}
          total={nodes.length}
          filter={filter}
          query={query}
          selectedId={selectedId}
          onFilter={setFilter}
          onQuery={setQuery}
          onSelect={selectNode}
          onNavigate={onNavigate}
        />
      )}

      {/* 详情在 DOM 里紧跟星图 / 文本目录：键盘用户按 Tab 就能进入详情。 */}
      <MemoryDetail
        node={panelNode}
        open={selectedId !== null}
        revisions={revisions}
        revisionsLoading={revisionsLoading}
        revisionsError={revisionsError}
        connections={connections}
        onClose={clearSelection}
        onSelectNeighbor={selectNode}
        onRetryRevisions={() => setRevisionNonce((value) => value + 1)}
        onLocate={locateSelected}
        onCopyId={copyId}
        onDelete={deleteMemory}
        panelRef={panelRef}
      />

      <header className="mm-head">
        <div className="mm-head-row">
          <h1 className="mm-title">{isText ? '记忆文本' : '记忆星图'}</h1>
          <span className="mm-head-count mono">
            {isText
              ? `${formatNumber(nodes.length)} 条记忆`
              : `${formatNumber(nodes.length)} 星 · ${formatNumber(starMap.edges.length)} 线`}
          </span>
          <button
            type="button"
            className="mm-guide-btn"
            aria-haspopup="dialog"
            onClick={() => setGuideOpen(true)}
          >
            <Icon name="info" size={12} />
            说明
          </button>
          <button
            type="button"
            className="mm-guide-btn"
            aria-haspopup="dialog"
            onClick={() => setModelSettingsOpen(true)}
          >
            <Icon name="settings" size={12} />
            模型设置
          </button>
        </div>
        <p className="mm-sub">
          {isText
            ? '文字目录：候选优先，按更新时间排列。点击行查看完整档案。'
            : '每条记忆是一颗球，连线是它们之间的关系。'}
          {truncated &&
            (isText
              ? ` 显示最近 ${formatNumber(nodes.length)} 条。`
              : ` 星图展示最近 ${formatNumber(nodes.length)} 条。`)}
        </p>
        {!isText && query.trim().length > 0 && (
          <button type="button" className="mm-query" onClick={() => setQuery('')}>
            <Icon name="search" size={12} />
            <span>仅显示「{truncate(query, 16)}」</span>
            <Icon name="close" size={11} />
          </button>
        )}
        {mode === '2d' && layoutCustomized && (
          <button
            type="button"
            className="mm-layout-reset"
            title="回到自动星座布局"
            onClick={resetLayout}
          >
            <Icon name="refresh" size={12} />
            <span>已手动排布 · 恢复自动</span>
          </button>
        )}
      </header>

      <div className="mm-headbar">
        <div className="mm-metrics">
          <span>
            <i>记忆</i>
            <b className="mono">{formatNumber(totalMemories)}</b>
          </span>
          <span>
            <i>关系</i>
            <b className="mono">{formatNumber(starMap.edges.length)}</b>
          </span>
          <span>
            <i>试行</i>
            <b className={`mono${pending > 0 ? ' is-warn' : ''}`}>{formatNumber(pending)}</b>
          </span>
        </div>

        <div
          className={`mm-mode${mode === '3d' ? ' is-3d' : ''}${mode === 'text' ? ' is-text' : ''}`}
          role="group"
          aria-label="切换视图"
        >
          <button
            type="button"
            className={mode === '2d' ? 'is-active' : ''}
            aria-pressed={mode === '2d'}
            onClick={() => changeMode('2d')}
          >
            <b>2D</b>
            <span>星图</span>
          </button>
          <button
            type="button"
            className={mode === '3d' ? 'is-active' : ''}
            aria-pressed={mode === '3d'}
            onClick={() => changeMode('3d')}
          >
            <b>3D</b>
            <span>星云</span>
          </button>
          <button
            type="button"
            className={mode === 'text' ? 'is-active' : ''}
            aria-pressed={mode === 'text'}
            onClick={() => changeMode('text')}
          >
            <b>文本</b>
            <span>列表</span>
          </button>
        </div>

        <button
          type="button"
          className={`mm-icon-btn${loading ? ' is-spinning' : ''}`}
          onClick={handleRefresh}
          disabled={loading}
          aria-label="重新读取记忆关系"
          title="重新读取记忆关系"
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>

      {hasNodes && !isText && (
        <aside className="mm-legend" aria-label="图例与筛选">
          <p className="mm-legend-title mono">星体</p>
          <div className="mm-filters" role="group" aria-label="按生命周期筛选">
            <button
              type="button"
              className={`mm-filter${filter === 'all' ? ' is-active' : ''}`}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              <i className="mm-filter-dot mm-filter-dot--all" aria-hidden="true" />
              <span>全部</span>
              <em className="mono">{nodes.length}</em>
            </button>
            {LIFECYCLE_ORDER.map((lifecycle) => {
              const count = counts[lifecycle];
              const active = filter === lifecycle;
              return (
                <button
                  key={lifecycle}
                  type="button"
                  className={`mm-filter${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  disabled={count === 0 && !active}
                  title={
                    lifecycle === 'candidate'
                      ? '2 个独立日期证据 + 置信度 ≥65% 自动转正；14 天未转正归档。'
                      : lifecycle === 'archived'
                        ? '归档不等于删除；相关场景命中时仍可能被唤醒。'
                        : undefined
                  }
                  onClick={() => setFilter(active ? 'all' : lifecycle)}
                >
                  <i
                    className="mm-filter-dot"
                    aria-hidden="true"
                    style={{
                      background: LIFECYCLE_COLOR[lifecycle],
                      boxShadow: `0 0 8px ${LIFECYCLE_COLOR[lifecycle]}88`,
                    }}
                  />
                  <span>{LIFECYCLE_LABEL[lifecycle]}</span>
                  <em className="mono">{count}</em>
                </button>
              );
            })}
          </div>

          <p className="mm-legend-title mono">关系</p>
          {legend.length === 0 ? (
            <p className="mm-legend-empty">还没有形成关系。</p>
          ) : (
            <ul className="mm-link-legend">
              {legend.map((entry) => {
                const meta = EDGE_META[entry.type];
                const color = rgba(meta.rgb, 0.8);
                return (
                  <li key={entry.type}>
                    <span
                      className={`mm-line${meta.dashed ? ' is-dashed' : ''}`}
                      aria-hidden="true"
                      style={{
                        background: meta.dashed
                          ? `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 6px)`
                          : color,
                      }}
                    />
                    <span>{meta.label}</span>
                    <em className="mono">{entry.count}</em>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mm-legend-note">球越大，适应度越高；虚线圈表示还在试行。</p>
          {graph !== null && graph.note.includes('降级') && (
            <p className="mm-legend-warn">嵌入模型不可用，内容边按文本相似降级。</p>
          )}
        </aside>
      )}

      {hasNodes && !isText && (
        <p className="mm-hint">
          <span>
            <kbd>拖动</kbd>
            {mode === '3d' ? '旋转星云' : '移动星球 · 空白平移'}
          </span>
          <span>
            <kbd>滚轮</kbd>缩放
          </span>
          <span>
            <kbd>点击</kbd>打开记忆
          </span>
          <span>
            <kbd>方向键</kbd>切换
          </span>
        </p>
      )}

      {hasNodes && !isText && (
        <div className="mm-controls">
          {mode === '3d' && (
            <button
              type="button"
              className={`mm-ctl mm-ctl--text${autoRotate ? ' is-on' : ''}`}
              aria-pressed={autoRotate}
              onClick={() => setAutoRotate((value) => !value)}
              title={autoRotate ? '停止自转' : '开始自转'}
            >
              <Icon name="orbit" size={14} />
              <span>自转</span>
            </button>
          )}
          <div className="mm-ctl-group">
            <button
              type="button"
              className="mm-ctl"
              onClick={() => canvasRef.current?.zoomBy(1.25)}
              aria-label="放大"
              title="放大"
            >
              <Icon name="plus" size={15} />
            </button>
            <button
              type="button"
              className="mm-ctl"
              onClick={() => canvasRef.current?.zoomBy(0.8)}
              aria-label="缩小"
              title="缩小"
            >
              <Icon name="minus" size={15} />
            </button>
            <button
              type="button"
              className="mm-ctl"
              onClick={() => canvasRef.current?.resetView()}
              aria-label="复位视角"
              title="复位视角"
            >
              <Icon name="target" size={15} />
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div className="mm-loading" role="status">
          <span className="mm-loading-orbit" aria-hidden="true">
            <i />
          </span>
          正在校准星图…
        </div>
      )}

      {error !== null && (
        <div className="mm-error" role="alert">
          <p>读取星图失败：{error}</p>
          <button type="button" className="mm-btn" onClick={handleRefresh}>
            重试
          </button>
        </div>
      )}

      {!loading && error === null && !hasNodes && (
        <div className="mm-empty">
          <span className="mm-empty-orbit" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <p className="mm-empty-title">{isText ? '还没有可读的记忆' : '星图还是空的'}</p>
          <p className="mm-empty-desc">
            {isText
              ? '当管家记住第一件事，这里会出现可读的文本。'
              : '当管家记住第一件事，这里会长出第一颗星。'}
          </p>
          <div className="mm-empty-actions">
            <button type="button" className="mm-btn mm-btn--primary" onClick={() => onNavigate('chat')}>
              去对话
            </button>
            <button type="button" className="mm-btn" onClick={handleRefresh}>
              刷新
            </button>
          </div>
        </div>
      )}

      {/* 星图的文字替身：给读屏与键盘用户一条不依赖像素的入口。文本模式下
          可见的目录已经承担了这件事，不再重复。 */}
      {!isText && (
        <div className="sr-only">
          <h2>记忆列表（星图的文字版本）</h2>
          <ul>
            {nodes.map((node) => (
              <li key={node.id}>
                <button type="button" tabIndex={-1} onClick={() => selectNode(node.id)}>
                  {node.item.lifecycleLabel} · {node.item.kindLabel}：{node.item.content}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {guideOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="mm-guide-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setGuideOpen(false);
              }}
            >
              <div
                className="mm-guide"
                role="dialog"
                aria-modal="true"
                aria-labelledby="mm-guide-title"
              >
                <header className="mm-guide-head">
                  <div>
                    <p className="mm-eyebrow mono">MEMORY / LIFECYCLE</p>
                    <h2 id="mm-guide-title">记忆会经历哪些状态</h2>
                  </div>
                  <button
                    type="button"
                    className="mm-guide-close"
                    aria-label="关闭说明"
                    onClick={() => setGuideOpen(false)}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </header>
                <dl className="mm-guide-list">
                  <div>
                    <dt className="is-active">活跃</dt>
                    <dd>已经通过证据验证，会参与日常召回。</dd>
                  </div>
                  <div>
                    <dt className="is-candidate">试行</dt>
                    <dd>
                      系统还在收集证据。满足 2 个独立日期证据且置信度 ≥65% 时自动转正，
                      14 天未转正会自动归档。你不需要手动批准。
                    </dd>
                  </div>
                  <div>
                    <dt className="is-dormant">休眠</dt>
                    <dd>长期没有被用到；相关场景再次命中时会自动唤醒，不需要你操作。</dd>
                  </div>
                  <div>
                    <dt className="is-archived">归档</dt>
                    <dd>
                      不再主动出现在日常对话中，但相关场景命中时仍可能被唤醒。
                      归档不等于删除，数据仍然保留。
                    </dd>
                  </div>
                  <div>
                    <dt className="is-danger">删除</dt>
                    <dd>
                      从记忆库永久删除，历史事件中的原文也会被抹去，无法恢复。
                      这是唯一会真正移除记忆的操作。
                    </dd>
                  </div>
                </dl>
                <p className="mm-guide-foot">试行与归档由系统自动处理，不需要你参与决策。</p>
              </div>
            </div>,
            document.querySelector('.mm') ?? document.body,
          )
        : null}

      <MemoryModelSettings
        open={modelSettingsOpen}
        onClose={() => setModelSettingsOpen(false)}
        notify={notify}
        onChanged={onRefreshOverview}
      />

      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}
