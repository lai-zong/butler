'use client';

/**
 * 记忆详情侧栏
 *
 * ★ 星图不展示文字，内容只在这里出现 —— 一条记忆被“点开”之后，
 *   用户看到的是它的全部治理信息，而不是一句孤零零的正文：
 *   依据、适应度、修订历史、以及它为什么和别的星连在一起。
 */

import { useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../components/Icon';
import {
  CLASS_LABEL,
  KIND_LABEL,
  LIFECYCLE_LABEL,
  domainLabel,
  formatDateTime,
  relativeTime,
  truncate,
} from '../lib/format.js';
import { useNow } from '../lib/hooks.js';
import type { MemoryClass, MemoryRevision, MemoryLifecycle } from '../lib/types.js';
import { EDGE_META, rgba, type StarEdge, type StarNode } from './starMap.js';

export interface MemoryConnection {
  readonly edge: StarEdge;
  readonly other: StarNode;
}

interface MemoryDetailProps {
  readonly node: StarNode | null;
  readonly open: boolean;
  readonly revisions: readonly MemoryRevision[];
  readonly revisionsLoading: boolean;
  readonly revisionsError: string | null;
  readonly connections: readonly MemoryConnection[];
  readonly onClose: () => void;
  readonly onSelectNeighbor: (id: string) => void;
  readonly onRetryRevisions: () => void;
  readonly onLocate: () => void;
  readonly onCopyId: () => void;
  /** 返回错误文本；成功返回 null，由调用方负责刷新星图。 */
  readonly onDelete: (id: string, hardConstraint: boolean) => Promise<string | null>;
  readonly panelRef: RefObject<HTMLElement>;
}

const LIFECYCLE_TONE: Record<MemoryLifecycle, string> = {
  active: 'is-active',
  candidate: 'is-candidate',
  dormant: 'is-dormant',
  archived: 'is-archived',
};

const CLASS_TONE: Record<MemoryClass, string> = {
  global_constraint: 'is-danger',
  global_shared: 'is-neutral',
  sensitive: 'is-warn',
  domain: 'is-info',
};

export function MemoryDetail({
  node,
  open,
  revisions,
  revisionsLoading,
  revisionsError,
  connections,
  onClose,
  onSelectNeighbor,
  onRetryRevisions,
  onLocate,
  onCopyId,
  onDelete,
  panelRef,
}: MemoryDetailProps): JSX.Element {
  const now = useNow(30_000);

  return (
    <aside
      id="memory-detail-panel"
      className={`mm-panel${open ? ' is-open' : ''}`}
      aria-label="记忆详情"
      aria-hidden={!open}
      ref={panelRef}
      tabIndex={-1}
    >
      {node === null ? null : (
        <PanelBody
          key={node.id}
          node={node}
          now={now}
          revisions={revisions}
          revisionsLoading={revisionsLoading}
          revisionsError={revisionsError}
          connections={connections}
          onClose={onClose}
          onSelectNeighbor={onSelectNeighbor}
          onRetryRevisions={onRetryRevisions}
          onLocate={onLocate}
          onCopyId={onCopyId}
          onDelete={onDelete}
        />
      )}
    </aside>
  );
}

interface PanelBodyProps extends Omit<MemoryDetailProps, 'open' | 'panelRef' | 'node'> {
  readonly node: StarNode;
  readonly now: number;
}

function PanelBody({
  node,
  now,
  revisions,
  revisionsLoading,
  revisionsError,
  connections,
  onClose,
  onSelectNeighbor,
  onRetryRevisions,
  onLocate,
  onCopyId,
  onDelete,
}: PanelBodyProps): JSX.Element {
  const item = node.item;
  const principle = item.principle;
  const evidenceShown = item.evidence.slice(0, 8);
  const connectionsShown = connections.slice(0, 10);
  const hardConstraint = item.memClass === 'global_constraint';
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const overlayTarget =
    typeof document === 'undefined' ? null : document.querySelector('.mm');

  const confirmDelete = async (): Promise<void> => {
    setDeleting(true);
    setDeleteError(null);
    const error = await onDelete(item.id, hardConstraint);
    setDeleting(false);
    if (error !== null) {
      setDeleteError(error);
      return;
    }
    setDeleteOpen(false);
    onClose();
  };

  return (
    <>
      <header className="md-head">
        <span
          className="md-orb"
          aria-hidden="true"
          style={{
            background: `radial-gradient(circle at 34% 30%, #ffffff 0%, ${node.color} 38%, rgba(6, 13, 15, 0.9) 100%)`,
            boxShadow: `0 0 20px ${node.color}66, 0 0 44px ${node.color}22`,
          }}
        />
        <div className="md-head-main">
          <h2 className="md-title">{item.subject ?? item.kindLabel}</h2>
          <p className="md-sub">
            {LIFECYCLE_LABEL[item.lifecycle]} · {KIND_LABEL[item.kind]} · {node.degree} 条关系
          </p>
        </div>
        <button type="button" className="md-close" onClick={onClose} aria-label="关闭记忆详情">
          <Icon name="close" size={15} />
        </button>
      </header>

      <div className="md-tags">
        <span className={`md-tag ${LIFECYCLE_TONE[item.lifecycle]}`}>
          <i aria-hidden="true" />
          {item.lifecycleLabel}
        </span>
        <span className={`md-tag ${CLASS_TONE[item.memClass]}`}>{CLASS_LABEL[item.memClass]}</span>
        <span className="md-tag is-neutral">{KIND_LABEL[item.kind]}</span>
        {item.domain !== null && (
          <span className="md-tag is-neutral">{domainLabel(item.domain)}</span>
        )}
        <span className="md-tag is-quiet mono">v{item.version}</span>
        {item.hasCredential && (
          <span className="md-tag is-warn">
            <Icon name="lock" size={10} />
            含凭证
          </span>
        )}
      </div>

      <section className="md-section">
        <p className="md-label mono">
          内容
        </p>
        <p className="md-content">{item.content}</p>
        {principle !== null && (
          <div className="md-principle">
            <p>
              <span className="mono">当</span>
              {principle.condition}
            </p>
            <p>
              <span className="mono">则</span>
              {principle.action}
            </p>
          </div>
        )}
        {item.effectiveness !== null && (
          <p className="md-effect">
            已应用 <b>{item.effectiveness.applied}</b> 次 · 成功 <b>{item.effectiveness.succeeded}</b> 次
          </p>
        )}
      </section>

      <section className="md-section" aria-label="指标">
        <p className="md-label mono">
          指标
        </p>
        <div className="md-metrics">
          <Metric label="置信度" value={`${Math.round(item.confidence * 100)}%`} ratio={item.confidence} />
          <Metric label="适应度" value={`${Math.round(item.fitness * 100)}%`} ratio={item.fitness} />
          <Metric label="召回" value={String(item.hitCount)} />
          <Metric label="使用" value={String(item.useCount)} />
          <Metric label="证据" value={String(item.evidenceCount)} />
          <Metric label="版本" value={`v${item.version}`} />
        </div>
      </section>

      <section className="md-section">
        <p className="md-label mono">
          关联
          <em>{connections.length}</em>
        </p>
        {connections.length === 0 ? (
          <p className="md-muted">这颗星暂时是孤立的。</p>
        ) : (
          <ul className="md-links">
            {connectionsShown.map(({ edge, other }) => (
              <li key={`${edge.id}:${other.id}`}>
                <button
                  type="button"
                  className="md-link"
                  title={
                    edge.reason ??
                    `${EDGE_META[edge.type].label} · ${Math.round(edge.weight * 100)}%`
                  }
                  onClick={() => onSelectNeighbor(other.id)}
                >
                  <span
                    className="md-link-orb"
                    aria-hidden="true"
                    style={{ background: other.color, boxShadow: `0 0 8px ${other.color}99` }}
                  />
                  <span className="md-link-main">
                    <span
                      className="md-link-type mono"
                      style={{ color: rgba(EDGE_META[edge.type].rgb, 0.86) }}
                    >
                      {EDGE_META[edge.type].label} · {Math.round(edge.weight * 100)}%
                    </span>
                    <span className="md-link-text">{truncate(other.item.content, 42)}</span>
                  </span>
                  <span className="md-link-go" aria-hidden="true">
                    <Icon name="chevronRight" size={12} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {connections.length > connectionsShown.length && (
          <p className="md-muted">另有 {connections.length - connectionsShown.length} 条关联未展开。</p>
        )}
      </section>

      <section className="md-section">
        <p className="md-label mono">
          证据
          <em>{item.evidenceCount}</em>
        </p>
        {evidenceShown.length === 0 ? (
          <p className="md-muted">没有记录来源。</p>
        ) : (
          <ul className="md-evidence">
            {evidenceShown.map((ev, i) => (
              <li key={`${ev}:${i}`} className="mono" title={ev}>
                {ev}
              </li>
            ))}
          </ul>
        )}
        {item.evidenceCount > evidenceShown.length && (
          <p className="md-muted">还有 {item.evidenceCount - evidenceShown.length} 条证据。</p>
        )}
      </section>

      <section className="md-section">
        <p className="md-label mono">
          修订 <span>HISTORY</span>
          <em>{revisions.length}</em>
        </p>
        {revisionsLoading ? (
          <div className="md-skeleton" aria-label="正在读取修订历史">
            <span />
            <span />
          </div>
        ) : revisionsError !== null ? (
          <div className="md-retry">
            <span>{revisionsError}</span>
            <button type="button" className="text-btn" onClick={onRetryRevisions}>
              重试
            </button>
          </div>
        ) : revisions.length === 0 ? (
          <p className="md-muted">还没有修订过。</p>
        ) : (
          <ol className="md-revisions">
            {revisions.slice(0, 6).map((revision) => (
              <li key={revision.id}>
                <span className="md-rev-dot" aria-hidden="true" />
                <div className="md-rev-main">
                  <p className="md-rev-title">
                    <b className="mono">v{revision.version}</b>
                    {revision.reason}
                  </p>
                  <p className="md-rev-meta">
                    {revision.actor} · {relativeTime(revision.createdAt, now)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="md-foot">
        <dl className="md-meta">
          <div>
            <dt>创建</dt>
            <dd>{formatDateTime(item.createdAt)}</dd>
          </div>
          <div>
            <dt>更新</dt>
            <dd>{relativeTime(item.updatedAt, now)}</dd>
          </div>
          {item.lastHitAt !== null && (
            <div>
              <dt>上次召回</dt>
              <dd>{relativeTime(item.lastHitAt, now)}</dd>
            </div>
          )}
          <div>
            <dt>作用域</dt>
            <dd className="mono">{item.scope}</dd>
          </div>
        </dl>
        <div className="md-actions">
          <button type="button" className="md-action" onClick={onLocate}>
            <Icon name="target" size={13} />
            定位到星图
          </button>
          <button type="button" className="md-action" onClick={onCopyId}>
            <Icon name="copy" size={13} />
            复制 ID
          </button>
        </div>
        <div className="md-danger-zone">
          <button
            type="button"
            className="md-delete"
            onClick={() => {
              setDeleteError(null);
              setDeleteOpen(true);
            }}
          >
            <Icon name="close" size={13} />
            删除这条记忆
          </button>
          {/* 入口处就说清这一步的后果：等用户点开确认框才第一次知道"其实可恢复"，
              会让「删除」在心理上仍然是一次不可逆操作。 */}
          <p className="md-muted">
            {hardConstraint
              ? '硬约束确认后直接销毁，不进入存档区。'
              : '删除会先移入存档区，可恢复。'}
          </p>
        </div>
      </footer>

      {deleteOpen && overlayTarget !== null
        ? createPortal(
        <div
          className="md-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting) setDeleteOpen(false);
          }}
        >
          <div
            className="md-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="md-delete-title"
            aria-describedby="md-delete-desc"
          >
            <h3 id="md-delete-title">
              {hardConstraint ? '删除这条记忆？' : '把这条记忆移入存档区？'}
            </h3>
            {/* 文案直接对应"两步删除"：普通记忆第一步只是移入存档区，
                硬约束仍是"确认即销毁"的唯一例外 —— 两句话必须分开，
                否则用户会以为硬约束也能在存档区找回。 */}
            <p id="md-delete-desc">
              {hardConstraint
                ? '这是硬约束：确认后直接销毁，不进入存档区；历史事件中的原文也会被抹去，无法恢复。'
                : '它会先移入记忆存档区，可恢复；只有在存档区点「彻底删除」才会抹除原文。'}
              你在聊天里自己说过的话不在此列。
            </p>
            {hardConstraint && (
              <p className="md-modal-warning">
                这是一条保护你不受伤的硬约束。删除后，系统可能不再提醒你相关风险。
              </p>
            )}
            {deleteError !== null && (
              <p className="md-modal-error" role="alert">
                {deleteError}
              </p>
            )}
            <div className="md-modal-actions">
              <button
                type="button"
                className="md-modal-cancel"
                disabled={deleting}
                onClick={() => setDeleteOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="md-modal-danger"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting ? '处理中…' : hardConstraint ? '仍然删除' : '移入存档区'}
              </button>
            </div>
          </div>
        </div>,
          overlayTarget,
        )
        : null}
    </>
  );
}

function Metric({
  label,
  value,
  ratio,
}: {
  readonly label: string;
  readonly value: string;
  readonly ratio?: number;
}): JSX.Element {
  return (
    <div className="md-metric">
      <span className="md-metric-label">{label}</span>
      <b className="md-metric-value mono">{value}</b>
      {ratio !== undefined && (
        <span className="md-metric-track" aria-hidden="true">
          <i style={{ width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%` }} />
        </span>
      )}
    </div>
  );
}
