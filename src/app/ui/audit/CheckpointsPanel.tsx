'use client';

/**
 * 审计 → 检查点
 *
 * 只读预览回答“会丢什么”；执行回退必须经过二次确认。
 * 回退会截断事件流并重建运行时，因此服务端还会再次检查是否有对话/定时任务在跑。
 */

import { useCallback, useEffect, useState } from 'react';

import { Badge, EmptyState, InlineError, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson } from '../lib/api.js';
import { formatDateTime, formatNumber } from '../lib/format.js';
import type {
  CheckpointPreviewResponse,
  CheckpointRollbackResponse,
  CheckpointsResponse,
  ToastMessage,
} from '../lib/types.js';

interface CheckpointsPanelProps {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}

const KIND_LABEL: Record<string, string> = {
  goal: '理解目标',
  recall: '召回完成',
  route: '路由决策',
  plan: '任务分解',
  stepStart: '步骤开始',
  stepDone: '步骤完成',
  conflict: '检出冲突',
  verdict: '裁决完成',
  deliver: '汇总交付',
  manual: '手动标记',
};

function shortTime(at: number): string {
  return formatDateTime(at).slice(5, 16);
}

export function CheckpointsPanel({ notify }: CheckpointsPanelProps): JSX.Element {
  const [data, setData] = useState<CheckpointsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CheckpointPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const loadList = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJson<CheckpointsResponse>('/api/checkpoints');
      setData(res);
      setSelectedId((current) => {
        if (current !== null && res.checkpoints.some((c) => c.id === current)) return current;
        return res.checkpoints[0]?.id ?? null;
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId === null) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setPreviewLoading(true);
    setPreviewError(null);
    void fetchJson<CheckpointPreviewResponse>(
      `/api/checkpoints?id=${encodeURIComponent(selectedId)}`,
    )
      .then((res) => {
        if (!cancelled) setPreview(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(errorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, previewNonce]);

  const selected = data?.checkpoints.find((c) => c.id === selectedId) ?? null;
  const selectedPlan = preview?.preview ?? null;
  const affectedArtifacts = selectedPlan?.artifactImpact.filter((a) => a.action === 'supersede') ?? [];
  const keptArtifacts = selectedPlan?.artifactImpact.filter((a) => a.action === 'keep') ?? [];
  const reviewMemories = selectedPlan?.memoryImpact.filter((m) => m.action === 'review') ?? [];

  const runRollback = async (): Promise<void> => {
    if (selected === null) return;
    setRollingBack(true);
    setRollbackError(null);
    try {
      const res = await fetch('/api/checkpoints/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selected.id, confirm: true }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        readonly error?: string;
        readonly discardedEvents?: number;
      } & Partial<CheckpointRollbackResponse>;
      if (!res.ok) {
        throw new Error(body.error ?? `回退失败（HTTP ${res.status}）`);
      }
      notify(
        `已回退到「${selected.label}」，丢弃 ${formatNumber(body.discardedEvents ?? 0)} 条事件` +
          ((body.reviewedMemories ?? 0) > 0 ? `，${formatNumber(body.reviewedMemories ?? 0)} 条记忆待复核` : ''),
        'success',
      );
      window.setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      setRollbackError(errorMessage(err));
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <div className="ckpt-view">
      <div className="ckpt-toolbar">
        <span className="ckpt-eyebrow mono">CHECKPOINTS / {formatNumber(data?.total ?? 0)}</span>
        <span className="ckpt-readonly">
          <Icon name="lock" size={12} /> 回退需二次确认
        </span>
      </div>

      {loading && data === null ? (
        <Skeleton rows={5} height={16} />
      ) : error !== null ? (
        <InlineError message={error} onRetry={() => void loadList()} />
      ) : data === null || data.total === 0 ? (
        <EmptyState
          title="还没有检查点"
          description="对话执行时会自动留下关键存档点；完成一轮后这里会出现。"
        />
      ) : (
        <div className="ckpt-layout">
          <section className="ckpt-panel" aria-label="检查点列表">
            <header className="ckpt-panel-head">
              <div>
                <span className="ckpt-eyebrow mono">CHECKPOINTS</span>
                <h2>检查点</h2>
              </div>
              <span className="ckpt-count">
                有效 {formatNumber(data.valid)} / {formatNumber(data.total)}
              </span>
            </header>
            <ol className="ckpt-list">
              {data.checkpoints.map((c) => {
                const active = c.id === selectedId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`ckpt-row ${active ? 'is-active' : ''}`}
                      onClick={() => setSelectedId(c.id)}
                    >
                      <span className="ckpt-time mono">{shortTime(c.createdAt)}</span>
                      <span className="ckpt-main">
                        <span className="ckpt-title">{c.label}</span>
                        <span className="ckpt-sub mono">
                          seq {c.seq} · {KIND_LABEL[c.kind] ?? c.kind}
                        </span>
                      </span>
                      <span className={`ckpt-state ${c.invalidatedBy !== null ? 'is-invalid' : ''}`}>
                        {c.invalidatedBy !== null ? '已失效' : '有效'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="ckpt-panel ckpt-detail" aria-label="检查点详情">
            {selected === null ? (
              <EmptyState title="选一个检查点" description="左侧列表里选择一个存档点，查看回退影响。" />
            ) : (
              <>
                <header className="ckpt-detail-head">
                  <div>
                    <span className="ckpt-eyebrow mono">
                      {shortTime(selected.createdAt)} · seq {selected.seq}
                    </span>
                    <h2>{selected.label}</h2>
                    <p>{selected.detail.length > 0 ? selected.detail : '这个检查点没有额外说明。'}</p>
                  </div>
                  <Badge tone={selected.invalidatedBy === null ? 'accent' : 'neutral'}>
                    {selected.invalidatedBy === null ? '有效' : '已失效'}
                  </Badge>
                </header>

                {selected.invalidatedBy !== null && (
                  <div className="ckpt-blocked">
                    <Icon name="lock" size={14} />
                    <span>这个检查点已失效：{selected.invalidatedBy}</span>
                  </div>
                )}

                {previewLoading ? (
                  <Skeleton rows={3} height={14} />
                ) : previewError !== null ? (
                  <InlineError
                    message={previewError}
                    onRetry={() => setPreviewNonce((n) => n + 1)}
                  />
                ) : selectedPlan !== null ? (
                  <>
                    {!selectedPlan.executable && (
                      <div className="ckpt-blocked">
                        <Icon name="info" size={14} />
                        <span>{selectedPlan.blockedReason ?? '当前不能回退到这个检查点。'}</span>
                      </div>
                    )}

                    <div className="ckpt-impact-grid">
                      <div>
                        <span>丢弃事件</span>
                        <strong className="mono">{formatNumber(selectedPlan.discardedEvents)}</strong>
                      </div>
                      <div>
                        <span>取代产出物</span>
                        <strong className="mono">{formatNumber(affectedArtifacts.length)}</strong>
                      </div>
                      <div>
                        <span>待复核记忆</span>
                        <strong className="mono">{formatNumber(reviewMemories.length)}</strong>
                      </div>
                    </div>

                    <div className="ckpt-section">
                      <p className="ckpt-section-title">回退会撤销</p>
                      <div className="ckpt-impact-list">
                        <div>
                          <span>对话事件</span>
                          <b className="mono">seq {selected.seq + 1} 之后</b>
                        </div>
                        <div>
                          <span>产出物</span>
                          <b>
                            {affectedArtifacts.length === 0
                              ? '无'
                              : affectedArtifacts.map((a) => a.label).join('、')}
                          </b>
                        </div>
                        <div>
                          <span>记忆</span>
                          <b>{reviewMemories.length === 0 ? '无' : `${reviewMemories.length} 条待复核`}</b>
                        </div>
                      </div>
                    </div>

                    {keptArtifacts.length > 0 && (
                      <div className="ckpt-section">
                        <p className="ckpt-section-title">检查点内保留</p>
                        <ul className="ckpt-artifacts">
                          {keptArtifacts.slice(0, 8).map((a) => (
                            <li key={a.artifactId}>
                              <Icon name="file" size={13} />
                              <span>{a.label}</span>
                              <span className="mono ckpt-version">
                                {selected.artifactRefs.find((r) => r.artifactId === a.artifactId)?.version ??
                                  '—'}
                              </span>
                            </li>
                          ))}
                          {keptArtifacts.length > 8 && (
                            <li className="ckpt-more">
                              还有 {keptArtifacts.length - 8} 个产出物未展开
                            </li>
                          )}
                        </ul>
                      </div>
                    )}

                    <p className="ckpt-note">
                      回退后会从事件流移除目标之后的事件；产出物标记为已取代，不删除内容。
                      需要二次确认，且执行期间不能有对话或定时任务在运行。
                    </p>

                    {selected.invalidatedBy === null && selectedPlan.executable && (
                      <div className="ckpt-actions">
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => {
                            setRollbackError(null);
                            setRollbackOpen(true);
                          }}
                        >
                          <Icon name="refresh" size={13} /> 回退到此
                        </button>
                      </div>
                    )}
                  </>
                ) : null}
              </>
            )}
          </section>
        </div>
      )}

      <Modal
        open={rollbackOpen}
        onClose={() => {
          if (!rollingBack) setRollbackOpen(false);
        }}
        title="回退到这个检查点？"
        description="这会截断目标之后的事件，并把之后产生的产出物标记为已取代。内容不会删除，但当前界面状态会重建。"
        footer={
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={rollingBack}
              onClick={() => setRollbackOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={rollingBack}
              onClick={() => void runRollback()}
            >
              {rollingBack ? '回退中…' : '确认回退'}
            </button>
          </div>
        }
      >
        {selected !== null && selectedPlan !== null && (
          <div className="ckpt-confirm">
            <p>
              <strong>{selected.label}</strong>
              <span className="mono"> · seq {selected.seq}</span>
            </p>
            <ul>
              <li>丢弃事件：{formatNumber(selectedPlan.discardedEvents)} 条</li>
              <li>取代产出物：{formatNumber(affectedArtifacts.length)} 个</li>
              <li>待复核记忆：{formatNumber(reviewMemories.length)} 条</li>
            </ul>
            {rollbackError !== null && <p className="ckpt-confirm-error">{rollbackError}</p>}
            <p className="ckpt-confirm-note">
              回退成功后页面会自动刷新；如果失败，事件流不会假装成功。
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
