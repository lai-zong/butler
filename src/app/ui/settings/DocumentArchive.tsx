'use client';

/**
 * 文档存档区
 *
 * ★ 文档有自己的存档区，不与记忆合并：两者的「恢复」后果完全不同
 *   （记忆回到记忆库并重新参与召回，文档回到知识库并重新可检索）。
 *   合在一个列表里，用户点错的代价是"恢复错了东西"，而不是"少了一个入口"。
 *
 * ★ 列表放在浮层里，而不是文档列表下方：存档是"处理已删除文档"的独立动作，
 *   不该和"当前可检索的文档"混在同一屏被顺手点掉。
 *
 * ★ 彻底删除用行内二次确认（展开一行问一句），而不是先弹一个系统 confirm：
 *   确认文案要和这一行一起被读到，才不会点错行。
 */

import { Fragment, useCallback, useEffect, useState } from 'react';

import { InlineError, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import { formatNumber, relativeTime } from '../lib/format.js';
import { useNow } from '../lib/hooks.js';

/** 与 DocumentsPanel 的 notify 同签名；文档面板是这里唯一的调用方。 */
type Notify = (text: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void;

interface DocumentArchiveProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly notify: Notify;
  /** 恢复后文档库多了一份文档，文档面板要重新取列表。 */
  readonly onChanged: () => void;
}

/** GET /api/documents/archive 的条目形状（服务端只回列表需要的字段，不回正文）。 */
interface ArchivedDocumentEntry {
  readonly archiveId: string;
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly chunkCount: number;
  readonly reason: string;
  readonly archivedAt: number;
}

interface DocumentArchiveResponse {
  readonly ok: boolean;
  readonly total: number;
  readonly items: readonly ArchivedDocumentEntry[];
}

/** 与文档列表同一套字节写法：同一个大小在两个地方显示成两种单位会让人怀疑数据不对。 */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentArchive({
  open,
  onClose,
  notify,
  onChanged,
}: DocumentArchiveProps): JSX.Element {
  const now = useNow(30_000);

  const [items, setItems] = useState<readonly ArchivedDocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  /** 哪一行正在等「确认抹除」；一次只允许展开一行。 */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** 正在跑的动作要带上是"恢复"还是"抹除"，否则两个按钮会显示错的状态文案。 */
  const [busy, setBusy] = useState<{
    readonly archiveId: string;
    readonly kind: 'restore' | 'purge';
  } | null>(null);

  const refresh = useCallback((): void => {
    setNonce((value) => value + 1);
  }, []);

  // 只在浮层打开时取数：存档区是低频入口，文档面板首屏不需要它。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setConfirmingId(null);
    void (async () => {
      try {
        const data = await fetchJson<DocumentArchiveResponse>('/api/documents/archive');
        if (cancelled) return;
        setItems(data.items ?? []);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, nonce]);

  const restore = useCallback(
    async (entry: ArchivedDocumentEntry): Promise<void> => {
      setBusy({ archiveId: entry.archiveId, kind: 'restore' });
      try {
        await postJson(`/api/documents/archive/${encodeURIComponent(entry.archiveId)}`, {
          action: 'restore',
        });
        notify(`「${entry.name}」已恢复，重新进入知识库并可检索。`, 'success');
        refresh();
        onChanged();
      } catch (err) {
        notify(`恢复失败：${errorMessage(err)}`, 'danger');
      } finally {
        setBusy(null);
      }
    },
    [notify, onChanged, refresh],
  );

  const purge = useCallback(
    async (entry: ArchivedDocumentEntry): Promise<void> => {
      setBusy({ archiveId: entry.archiveId, kind: 'purge' });
      try {
        await fetchJson(`/api/documents/archive/${encodeURIComponent(entry.archiveId)}`, {
          method: 'DELETE',
        });
        notify(`「${entry.name}」已彻底删除，原文已抹除。`, 'success');
        setConfirmingId(null);
        refresh();
      } catch (err) {
        // 抹除失败不收起确认行：收起会让人以为已经删掉了。
        notify(`彻底删除失败：${errorMessage(err)}`, 'danger');
      } finally {
        setBusy(null);
      }
    },
    [notify, refresh],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="文档存档区"
      description="这里存放从文档库删除的文档，可恢复或彻底删除；存档期间不参与检索。"
      variant="wide"
    >
      {loading ? (
        <Skeleton rows={4} height={16} />
      ) : error !== null ? (
        <InlineError message={error} onRetry={refresh} />
      ) : items.length === 0 ? (
        <div className="doc-empty">
          <Icon name="file" size={22} />
          <strong>存档区还是空的</strong>
          <p>这里存放从文档库删除的文档，可恢复或彻底删除。</p>
        </div>
      ) : (
        <div className="doc-list">
          {items.map((entry) => (
            <Fragment key={entry.archiveId}>
              <div className="doc-row">
                <span className="doc-icon">
                  <Icon name="file" size={17} />
                </span>
                {/* 存档里的文档没有详情页可看，所以这里不是按钮：
                    把不可点的东西做成按钮，键盘用户会白按一次。 */}
                <div className="doc-main" style={{ cursor: 'default' }}>
                  <strong>{entry.name}</strong>
                  <span>
                    {formatNumber(entry.chunkCount)} 个分块 · {bytes(entry.size)}
                  </span>
                  <span>
                    删除于 {relativeTime(entry.archivedAt, now)} · 原因：{entry.reason}
                  </span>
                </div>
                <div className="doc-row-actions">
                  <button
                    type="button"
                    className="text-btn"
                    disabled={busy !== null}
                    onClick={() => void restore(entry)}
                  >
                    {busy?.archiveId === entry.archiveId && busy.kind === 'restore'
                      ? '恢复中…'
                      : '恢复'}
                  </button>
                  <button
                    type="button"
                    className="text-btn doc-del"
                    disabled={busy !== null}
                    onClick={() => setConfirmingId(entry.archiveId)}
                  >
                    彻底删除
                  </button>
                </div>
              </div>

              {confirmingId === entry.archiveId && (
                <div className="doc-row" style={{ boxShadow: 'inset 2px 0 0 var(--danger)' }}>
                  <span className="doc-icon">
                    <Icon name="alert" size={17} />
                  </span>
                  <div className="doc-main" style={{ cursor: 'default' }}>
                    <strong>彻底删除「{entry.name}」？</strong>
                    <span>原文会被抹除，无法恢复；这不是「移入存档区」，确认后不能撤销。</span>
                  </div>
                  <div className="doc-row-actions">
                    <button
                      type="button"
                      className="text-btn"
                      disabled={busy !== null}
                      onClick={() => setConfirmingId(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="text-btn doc-del"
                      disabled={busy !== null}
                      onClick={() => void purge(entry)}
                    >
                      {busy?.archiveId === entry.archiveId && busy.kind === 'purge'
                        ? '抹除中…'
                        : '确认抹除'}
                    </button>
                  </div>
                </div>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </Modal>
  );
}
