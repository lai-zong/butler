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
 *
 * ★ 「清空存档区」同样用行内确认，不叠第二层浮层：
 *   本面板自己就在一个浮层里，再叠一层要额外处理 Esc 与焦点（两个浮层都会
 *   监听 Escape，按一次会关掉两层）；而它和单条抹除的差别只在"影响几条"，
 *   用同一种确认形态反而更好对比。
 */

import { Fragment, useCallback, useEffect, useState } from 'react';

import { InlineError, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import { formatBytes, formatNumber, relativeTime } from '../lib/format.js';
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
  /** 是否正在等「清空整个存档区」的确认；它与行内确认互斥，避免两套确认同时开着。 */
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [purgingAll, setPurgingAll] = useState(false);
  const [purgeAllError, setPurgeAllError] = useState<string | null>(null);
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
    // 重新取数时也收起"清空"确认：它引用的条数可能已经变了，
    // 继续显示会让确认文案里的数字和列表对不上。
    setConfirmingAll(false);
    setPurgingAll(false);
    setPurgeAllError(null);
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

  /**
   * 清空整个存档区。
   *
   * 由服务端逐条抹除原文并清理索引，这里**不**自己循环调 DELETE：
   * 中途失败会留下"清了一半"的状态，而且逐条请求的错误提示会刷屏。
   */
  const purgeAll = useCallback(async (): Promise<void> => {
    setPurgingAll(true);
    setPurgeAllError(null);
    try {
      const res = await postJson<{ readonly ok: boolean; readonly purged: number }>(
        '/api/documents/archive',
        { action: 'purge-all', confirm: 'confirmed' },
      );
      notify(
        `存档区已清空，${formatNumber(res.purged)} 个文档的原文已抹除，无法恢复。`,
        'success',
      );
      setConfirmingAll(false);
      // 整个存档区已经空了：先清空本地列表与统计，刷新回来之前不该还显示已抹除的文档。
      setItems([]);
      refresh();
      onChanged();
    } catch (err) {
      // 失败不收起确认：收起会让人以为已经清空了。
      setPurgeAllError(errorMessage(err));
    } finally {
      setPurgingAll(false);
    }
  }, [notify, refresh, onChanged]);

  /** 存档接口没有单独的占用统计，占用就是各条 size 之和——与列表同源，不会对不上。 */
  const totalSize = items.reduce((sum, entry) => sum + entry.size, 0);

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
      ) : (
        <>
          {/*
            顶部统计 + 清空入口。
            占用取各条 size 之和（接口没有单独的统计字段）：与列表同源，数字不会和列表对不上。
          */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span className="doc-note" style={{ marginTop: 0 }}>
              {formatNumber(items.length)} 个 · 占用 {formatBytes(totalSize)}
            </span>
            {items.length > 0 && !confirmingAll && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={purgingAll}
                onClick={() => {
                  setPurgeAllError(null);
                  setConfirmingAll(true);
                }}
              >
                <Icon name="trash" size={13} /> 清空存档区
              </button>
            )}
          </div>

          {confirmingAll && items.length > 0 && (
            // 包一层 .doc-list 是为了拿到与下方列表同一种边框/圆角：
            // 确认块孤零零贴在浮层正文里，会像一个没归位的行。
            <div className="doc-list">
              <div className="doc-row" style={{ boxShadow: 'inset 2px 0 0 var(--danger)' }}>
                <span className="doc-icon">
                  <Icon name="alert" size={17} />
                </span>
                <div className="doc-main" style={{ cursor: 'default' }}>
                  <strong>清空整个存档区？</strong>
                  <span>{`${formatNumber(items.length)} 个文档会被彻底删除：原文抹除、索引移除，不可恢复；这不是「移入存档区」，确认后不能撤销。`}</span>
                  {purgeAllError !== null && (
                    <span role="alert" style={{ color: 'var(--danger)' }}>
                      {purgeAllError}
                    </span>
                  )}
                </div>
                <div className="doc-row-actions">
                  <button
                    type="button"
                    className="text-btn"
                    disabled={purgingAll}
                    onClick={() => {
                      setConfirmingAll(false);
                      setPurgeAllError(null);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="text-btn doc-del"
                    disabled={purgingAll}
                    onClick={() => void purgeAll()}
                  >
                    {purgingAll ? '清空中…' : '确认清空'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {items.length === 0 ? (
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
                        {formatNumber(entry.chunkCount)} 个分块 · {formatBytes(entry.size)}
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
        </>
      )}
    </Modal>
  );
}
