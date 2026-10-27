'use client';

/**
 * 记忆关系图 —— 只读派生投影。
 *
 * 节点是记忆，边来自真实关系；点击节点回到列表详情。
 * 不在这里编辑记忆，也不提供审核/调权入口。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { EmptyState, InlineError, PageHeader, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { errorMessage, fetchJson } from '../lib/api.js';
import { truncate } from '../lib/format.js';
import type { MemoryItem } from '../lib/types.js';

type EdgeType = 'content' | 'semantic' | 'sharedEvidence' | 'conflict' | 'merge' | 'coRecall';

interface GraphNode extends MemoryItem {
  readonly degree: number;
}

interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: EdgeType;
  readonly weight: number;
  readonly reason?: string;
}

interface GraphResponse {
  readonly ok: boolean;
  readonly nodes?: readonly GraphNode[];
  readonly edges?: readonly GraphEdge[];
  readonly error?: string;
  readonly note?: string;
}

interface Position {
  readonly x: number;
  readonly y: number;
}

const W = 1000;
const H = 620;

const KIND_COLOR: Record<string, string> = {
  fact: '#7cc4ff',
  preference: '#ffc266',
  principle: '#45e0c1',
  summary: '#c69cff',
};

const EDGE_COLOR: Record<EdgeType, string> = {
  content: '#5d8f81',
  semantic: '#6aa6d8',
  sharedEvidence: '#b08a5a',
  conflict: '#b56e63',
  merge: '#9a86bd',
  coRecall: '#6fa9d8',
};

const EDGE_LABEL: Record<EdgeType, string> = {
  content: '内容相似',
  semantic: '语义相似',
  sharedEvidence: '共享证据',
  conflict: '冲突',
  merge: '合并来源',
  coRecall: '同轮召回',
};

function layout(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, Position> {
  const sorted = [...nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
  const positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  sorted.forEach((n, i) => {
    const angle = i * golden;
    const radius = 26 + 22 * Math.sqrt(i);
    positions.set(n.id, {
      x: Math.cos(angle) * radius * 1.2,
      y: Math.sin(angle) * radius * 0.92,
      vx: 0,
      vy: 0,
    });
  });

  for (let iter = 0; iter < 220; iter += 1) {
    const cooled = 1 - iter / 260;
    const list = [...positions.entries()];
    for (let i = 0; i < list.length; i += 1) {
      const [ida, a] = list[i]!;
      for (let j = i + 1; j < list.length; j += 1) {
        const [, b] = list[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) {
          dx = 1;
          dy = 0;
          d = 1;
        }
        if (d < 46) {
          const push = (46 - d) * 0.34;
          dx /= d;
          dy /= d;
          a.vx -= dx * push;
          a.vy -= dy * push;
          b.vx += dx * push;
          b.vy += dy * push;
        } else if (d < 240) {
          const force = Math.min(1.8, 1400 / (d * d)) * cooled;
          dx /= d;
          dy /= d;
          a.vx -= dx * force;
          a.vy -= dy * force;
          b.vx += dx * force;
          b.vy += dy * force;
        }
      }
      void ida;
    }
    for (const e of edges) {
      const a = positions.get(e.source);
      const b = positions.get(e.target);
      if (!a || !b) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const force = (d - 92) * 0.012 * cooled;
      dx /= d;
      dy /= d;
      a.vx += dx * force;
      a.vy += dy * force;
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
    for (const p of positions.values()) {
      p.vx -= p.x * 0.0015 * cooled;
      p.vy -= p.y * 0.0015 * cooled;
      p.vx *= 0.8;
      p.vy *= 0.8;
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > 7) {
        p.vx = (p.vx / speed) * 7;
        p.vy = (p.vy / speed) * 7;
      }
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  const values = [...positions.values()];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of values) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const scale = Math.min(820 / Math.max(1, maxX - minX), 540 / Math.max(1, maxY - minY));
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  return new Map(
    [...positions.entries()].map(([id, p]) => [
      id,
      { x: W / 2 + (p.x - mx) * scale, y: H / 2 + (p.y - my) * scale },
    ]),
  );
}

export function MemoryGraphPanel({
  onBack,
  onSelectMemory,
}: {
  readonly onBack: () => void;
  readonly onSelectMemory: (id: string) => void;
}): JSX.Element {
  const [nodes, setNodes] = useState<readonly GraphNode[]>([]);
  const [edges, setEdges] = useState<readonly GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [positions, setPositions] = useState<Map<string, Position>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const dragMovedRef = useRef(false);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson<GraphResponse>('/api/memory/graph')
      .then((r) => {
        if (cancelled) return;
        const ns = r.nodes ?? [];
        const es = r.edges ?? [];
        setNodes(ns);
        setEdges(es);
        setPositions(layout(ns, es));
        setNote(r.note ?? '');
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = ((ev.clientX - rect.left) / rect.width) * W;
      const my = ((ev.clientY - rect.top) / rect.height) * H;
      const oldK = view.k;
      const nextK = Math.max(0.5, Math.min(2.8, oldK * (ev.deltaY < 0 ? 1.12 : 0.9)));
      const wx = (mx - view.x) / oldK;
      const wy = (my - view.y) / oldK;
      setView({ k: nextK, x: mx - wx * nextK, y: my - wy * nextK });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view, loading, nodes.length]);

  useEffect(() => {
    const move = (ev: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag || ev.pointerId !== drag.pointerId || !svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const sx = ((ev.clientX - rect.left) / rect.width) * W;
      const sy = ((ev.clientY - rect.top) / rect.height) * H;
      const wx = (sx - view.x) / view.k;
      const wy = (sy - view.y) / view.k;
      dragMovedRef.current = true;
      setPositions((prev) => {
        const next = new Map(prev);
        next.set(drag.id, {
          x: Math.max(30, Math.min(W - 30, wx - drag.offsetX)),
          y: Math.max(26, Math.min(H - 26, wy - drag.offsetY)),
        });
        return next;
      });
    };
    const up = (): void => {
      dragRef.current = null;
      window.setTimeout(() => {
        dragMovedRef.current = false;
      }, 80);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [view]);

  const visibleEdges = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }, [edges, nodes]);

  const focus = selected ?? hovered;
  const neighbors = useMemo(() => {
    if (focus === null) return new Set<string>();
    const set = new Set<string>();
    for (const e of visibleEdges) {
      if (e.source === focus) set.add(e.target);
      if (e.target === focus) set.add(e.source);
    }
    return set;
  }, [focus, visibleEdges]);

  return (
    <div className="page memory-graph-page">
      <PageHeader
        eyebrow="MEMORY / GRAPH"
        title="记忆图"
        description="节点是记忆，连线是关系。点击节点回到列表查看证据；图只读。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={onBack}>
              <Icon name="arrowLeft" size={15} /> 返回列表
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setView({ x: 0, y: 0, k: 1 });
                setSelected(null);
              }}
            >
              <Icon name="refresh" size={15} /> 适配
            </button>
          </>
        }
      />

      <section className="memory-graph-card">
        <div className="memory-graph-meta">
          <span className="mono">{nodes.length} 节点 / {visibleEdges.length} 连线</span>
          <span className="memory-graph-hint">拖动节点可调整位置；点击查看详情</span>
        </div>

        {loading && <Skeleton rows={6} height={22} />}
        {!loading && error !== null && <InlineError message={error} />}
        {!loading && error === null && nodes.length === 0 && (
          <EmptyState icon="memory" title="还没有可绘制的记忆" description="先让日记沉淀出试行记忆。" />
        )}

        {!loading && error === null && nodes.length > 0 && (
          <svg
            ref={svgRef}
            className="memory-graph-svg"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label="记忆关系图"
            onPointerDown={(ev) => {
              if (ev.target !== ev.currentTarget) return;
              ev.currentTarget.setPointerCapture(ev.pointerId);
              panRef.current = {
                pointerId: ev.pointerId,
                startX: ev.clientX,
                startY: ev.clientY,
                baseX: view.x,
                baseY: view.y,
              };
            }}
            onPointerMove={(ev) => {
              const pan = panRef.current;
              if (!pan || pan.pointerId !== ev.pointerId) return;
              setView({
                ...view,
                x: pan.baseX + (ev.clientX - pan.startX),
                y: pan.baseY + (ev.clientY - pan.startY),
              });
            }}
            onPointerUp={() => {
              panRef.current = null;
            }}
            onPointerCancel={() => {
              panRef.current = null;
            }}
          >
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {visibleEdges.map((e) => {
                const a = positions.get(e.source);
                const b = positions.get(e.target);
                if (!a || !b) return null;
                const active = focus !== null && (e.source === focus || e.target === focus);
                return (
                  <line
                    key={e.id}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={EDGE_COLOR[e.type] ?? '#536b85'}
                    strokeWidth={active ? 2.2 : 1}
                    strokeOpacity={active ? 0.9 : focus === null ? 0.38 : 0.18}
                    strokeDasharray={e.type === 'sharedEvidence' ? '2 4' : e.type === 'coRecall' ? '5 4' : undefined}
                  >
                    <title>{EDGE_LABEL[e.type]}{e.reason ? ` · ${e.reason}` : ''}</title>
                  </line>
                );
              })}

              {nodes.map((n) => {
                const p = positions.get(n.id);
                if (!p) return null;
                const isFocus = focus === n.id;
                const isNeighbor = neighbors.has(n.id);
                const archived = n.lifecycle === 'archived';
                const r = isFocus ? 16 : n.degree >= 3 ? 13.5 : n.degree === 0 ? 8.5 : 10.5;
                return (
                  <g
                    key={n.id}
                    className={`memory-graph-node ${isFocus ? 'is-focus' : ''} ${isNeighbor ? 'is-neighbor' : ''}`}
                    transform={`translate(${p.x} ${p.y})`}
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      if (!svgRef.current) return;
                      const rect = svgRef.current.getBoundingClientRect();
                      const sx = ((ev.clientX - rect.left) / rect.width) * W;
                      const sy = ((ev.clientY - rect.top) / rect.height) * H;
                      const wx = (sx - view.x) / view.k;
                      const wy = (sy - view.y) / view.k;
                      dragMovedRef.current = false;
                      dragRef.current = {
                        id: n.id,
                        pointerId: ev.pointerId,
                        offsetX: wx - p.x,
                        offsetY: wy - p.y,
                      };
                      setSelected(n.id);
                    }}
                    onClick={() => {
                      if (dragMovedRef.current) return;
                      onSelectMemory(n.id);
                    }}
                    onPointerEnter={() => setHovered(n.id)}
                    onPointerLeave={() => setHovered(null)}
                  >
                    <circle
                      r={r}
                      fill={KIND_COLOR[n.kind] ?? '#8097b0'}
                      fillOpacity={archived ? 0.42 : 1}
                      stroke={isFocus ? '#eef8ff' : '#020812'}
                      strokeWidth={isFocus ? 2.4 : 2}
                      strokeDasharray={n.lifecycle === 'candidate' ? '2 3' : undefined}
                    />
                    {(isFocus || n.degree >= 3) && (
                      <>
                        <rect
                          x={r + 7}
                          y={-8}
                          width={Math.min(180, Math.max(34, truncate(n.content, 16).length * 8.5 + 12))}
                          height={16}
                          rx={4}
                          fill="rgba(7,19,35,.9)"
                          stroke="#294760"
                          strokeWidth={0.8}
                        />
                        <text x={r + 13} y={3} className="memory-graph-label">
                          {truncate(n.content, 16)}
                        </text>
                      </>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        {!loading && error === null && nodes.length > 0 && (
          <div className="memory-graph-legend">
            <span>标签提示</span>
            <div>
              <i style={{ background: KIND_COLOR.fact }} /> 事实
              <i style={{ background: KIND_COLOR.preference }} /> 偏好
              <i style={{ background: KIND_COLOR.principle }} /> 原则
            </div>
            <div>
              <b style={{ background: EDGE_COLOR.semantic }} /> 语义相似
              <b style={{ background: EDGE_COLOR.content }} /> 文本相似
              <b style={{ background: EDGE_COLOR.sharedEvidence }} /> 共享证据
              <b style={{ background: EDGE_COLOR.merge }} /> 合并
            </div>
            <span>归档节点更暗 · 试行节点虚线圈</span>
          </div>
        )}

        {note.length > 0 && <p className="memory-graph-note">{note}</p>}
      </section>
    </div>
  );
}
