'use client';

/**
 * 回收站 —— 模型替用户删掉的工作区文件
 *
 * ★ 为什么单独一个面板，不与记忆 / 文档存档区合并：
 *   这里的对象是磁盘上的真实文件，"恢复"= 放回原路径，而且**可能失败**——
 *   原路径上已经有同名文件时服务端回 409。记忆与文档的恢复是"重新回到记忆库 /
 *   知识库"，没有这类冲突。三种后果不同的操作放一个列表里，点错一次就是文件拿不回来。
 *
 * ★ 清空走浮层、单条彻底删除用行内确认：
 *   批量错一次是全部消失，单条错一次只丢一条。确认的仪式感应该和后果的份量一致，
 *   否则"清空"和"删一条"在界面上会显得一样重。
 *
 * ★ 原路径一律截断 + title 兜底全文：
 *   路径常常比一行还长，撑开它会把"是文件还是目录""删了多久"和操作按钮挤出视野；
 *   而路径是判断"这到底是不是我要的那个文件"的关键信息，又不能不给。
 */

import { Fragment, useCallback, useEffect, useState } from 'react';

import { formatBytes } from '@/app/ui/lib/format.js';
import { Badge, EmptyState, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import { formatNumber, relativeTime } from '../lib/format.js';
import { useNow } from '../lib/hooks.js';
import type { ToastMessage } from '../lib/types.js';

/** 与设置页其它面板同签名；本面板只通过父级的 toast 汇报结果。 */
type Notify = (text: string, tone?: ToastMessage['tone']) => void;

interface TrashPanelProps {
  readonly notify: Notify;
}

/** GET /api/trash 的条目形状。 */
interface TrashEntry {
  readonly id: string;
  /** 删除前的绝对路径 */
  readonly originalPath: string;
  /** 删除时的工作区根：只在服务端恢复时校验用，界面不展示（路径本身已经说明问题）。 */
  readonly root: string;
  readonly deletedAt: number;
  readonly isDirectory: boolean;
}

interface TrashResponse {
  readonly ok: boolean;
  readonly total: number;
  readonly bytes: number;
  readonly items: readonly TrashEntry[];
  /** 接口还回了 note；它与面板描述重复，不逐字渲染，免得两段话互相稀释。 */
  readonly note?: string;
}

/**
 * 字节 → B/KB/MB（1024 进制，一位小数）。
 *
 * 刻意在本地写一份：本轮只允许改配置目录，碰不到 lib/format.ts；
 * 而 DocumentArchive 里已有一份同口径实现，两边必须一致，否则同一个文件
 * 在两个地方会显示成不同大小。
 */

/**
 * 取 basename。
 *
 * 不能只用 '/' 切：回收站里记的是 Windows 的绝对路径（反斜杠），
 * 直接按 '/' 取会把整条路径当成文件名。末尾分隔符先去掉，
 * 否则目录路径会取到一个空名字。
 */
function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/** 一次只允许一个行内操作在跑：两个按钮同时按下去会产生互相矛盾的结果。 */
interface BusyState {
  readonly id: string;
  readonly kind: 'restore' | 'purge';
}

export function TrashPanel({ notify }: TrashPanelProps): JSX.Element {
  const now = useNow(30_000);

  const [items, setItems] = useState<readonly TrashEntry[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  /** 哪一行正在等「确认彻底删除」；一次只允许展开一行。 */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [purgeAllOpen, setPurgeAllOpen] = useState(false);
  const [purgingAll, setPurgingAll] = useState(false);
  const [purgeAllError, setPurgeAllError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    setNonce((value) => value + 1);
  }, []);

  // 面板只在被选中时挂载（SettingsView 按需渲染），所以这个 effect 就是"进页面取一次"。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // 换一批数据时先收起上一轮的行内确认：那个 id 可能已经不在列表里，
    // 留在屏幕上的确认行会指向一条已经消失的记录。
    setConfirmingId(null);
    void (async () => {
      try {
        const data = await fetchJson<TrashResponse>('/api/trash');
        if (cancelled) return;
        setItems(data.items ?? []);
        setTotalBytes(data.bytes ?? 0);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const restore = useCallback(
    async (entry: TrashEntry): Promise<void> => {
      setBusy({ id: entry.id, kind: 'restore' });
      try {
        await postJson(`/api/trash/${encodeURIComponent(entry.id)}`, { action: 'restore' });
        /**
         * 只说"已恢复"不够：恢复的目标是原路径，而用户点恢复时未必记得原路径在哪。
         * 名字 + "原路径"两个信息一起给，才知道去哪个目录找。
         */
        notify(`「${fileName(entry.originalPath)}」已恢复回原路径。`, 'success');
        refresh();
      } catch (err) {
        // 409 的文案由服务端给出（目标已存在 / 工作区外 / 文件已丢失），
        // 比前端再猜一遍准确，所以原样透出。
        notify(`恢复失败：${errorMessage(err)}`, 'danger');
      } finally {
        setBusy(null);
      }
    },
    [notify, refresh],
  );

  const purge = useCallback(
    async (entry: TrashEntry): Promise<void> => {
      setBusy({ id: entry.id, kind: 'purge' });
      try {
        await fetchJson(`/api/trash/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
        notify(`「${fileName(entry.originalPath)}」已彻底删除，无法恢复。`, 'success');
        setConfirmingId(null);
        refresh();
      } catch (err) {
        // 失败不收起确认行：收起会让人以为已经删掉了。
        notify(`彻底删除失败：${errorMessage(err)}`, 'danger');
      } finally {
        setBusy(null);
      }
    },
    [notify, refresh],
  );

  const purgeAll = useCallback(async (): Promise<void> => {
    setPurgingAll(true);
    setPurgeAllError(null);
    try {
      const res = await postJson<{ readonly ok: boolean; readonly purged: number }>('/api/trash', {
        action: 'purge-all',
        confirm: 'confirmed',
      });
      setPurgeAllOpen(false);
      // 整个回收站已经空了：列表与占用立刻归零，刷新完成前不该还显示已删除的条目。
      setItems([]);
      setTotalBytes(0);
      notify(`回收站已清空，${formatNumber(res.purged)} 项被彻底删除，无法恢复。`, 'success');
      refresh();
    } catch (err) {
      // 清空失败留在浮层里说明：关掉它会让用户以为已经清空了。
      setPurgeAllError(errorMessage(err));
    } finally {
      setPurgingAll(false);
    }
  }, [notify, refresh]);

  const clearConfirm = (): void => {
    setPurgeAllOpen(false);
    setPurgeAllError(null);
  };

  return (
    <section className="panel settings-panel" aria-label="回收站">
      <SectionHeading
        title="文件回收站"
        // 不复述上面页头的描述：同一屏两段一样的字只会让人重新读一遍。
        // 这里说的是"恢复可能失败"这件具体的事——它会改用户的操作预期。
        description="恢复会把文件放回原路径；原路径上已有同名文件时会被拒绝，不会覆盖。"
        actions={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={loading || error !== null || items.length === 0 || purgingAll}
            onClick={() => {
              setPurgeAllError(null);
              setPurgeAllOpen(true);
            }}
          >
            <Icon name="trash" size={13} /> 清空回收站
          </button>
        }
      />

      {!loading && error === null && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {/* 用 items.length 而不是响应的 total：界面上能数的就是这些条目，
              两个数字一旦不一致，提示里的那个就会变成谎话。 */}
          <Badge tone="outline">共 {formatNumber(items.length)} 条</Badge>
          <Badge tone="outline">占用 {formatBytes(totalBytes)}</Badge>
        </div>
      )}

      {loading ? (
        <Skeleton rows={4} height={16} />
      ) : error !== null ? (
        <InlineError message={error} onRetry={refresh} />
      ) : items.length === 0 ? (
        <EmptyState
          icon="trash"
          title="回收站是空的"
          description="模型替你删除的文件会先放在这里，可以恢复；现在没有需要处理的东西。"
        />
      ) : (
        <div className="doc-list">
          {items.map((entry) => {
            const name = fileName(entry.originalPath);
            const restoring = busy !== null && busy.id === entry.id && busy.kind === 'restore';
            const purging = busy !== null && busy.id === entry.id && busy.kind === 'purge';
            return (
              <Fragment key={entry.id}>
                <div className="doc-row">
                  <span className="doc-icon">
                    <Icon name={entry.isDirectory ? 'database' : 'file'} size={17} />
                  </span>
                  {/* 回收站条目没有详情页可看，这里不做成按钮：
                      把不可点的东西做成按钮，键盘用户会白按一次。 */}
                  <div className="doc-main" style={{ cursor: 'default' }}>
                    <strong title={entry.originalPath}>{name}</strong>
                    <span
                      className="mono"
                      title={entry.originalPath}
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {entry.originalPath}
                    </span>
                    <span>
                      {entry.isDirectory ? '目录' : '文件'} · 删除于{' '}
                      {relativeTime(entry.deletedAt, now)}
                    </span>
                  </div>
                  <div className="doc-row-actions">
                    <button
                      type="button"
                      className="text-btn"
                      disabled={busy !== null}
                      onClick={() => void restore(entry)}
                    >
                      {restoring ? '恢复中…' : '恢复'}
                    </button>
                    <button
                      type="button"
                      className="text-btn doc-del"
                      disabled={busy !== null}
                      onClick={() => setConfirmingId(entry.id)}
                    >
                      彻底删除
                    </button>
                  </div>
                </div>

                {confirmingId === entry.id && (
                  <div className="doc-row" style={{ boxShadow: 'inset 2px 0 0 var(--danger)' }}>
                    <span className="doc-icon">
                      <Icon name="alert" size={17} />
                    </span>
                    <div className="doc-main" style={{ cursor: 'default' }}>
                      <strong>彻底删除「{name}」？</strong>
                      <span>{`${entry.isDirectory ? '整个目录（含其中所有文件）' : '文件'}会从磁盘上删除，不可恢复；这不是「再删一次」，确认后没有第二次机会。`}</span>
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
                        {purging ? '删除中…' : '确认删除'}
                      </button>
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      {/* 清空是整站级动作，所以用浮层而不是行内确认：
          行内确认只够表达"删这一行"，表达不了"这里所有东西一起没"。 */}
      <Modal
        open={purgeAllOpen}
        // 清空请求还在跑的时候不许关：关掉浮层会让人以为"没清成"，而结果其实还没回来。
        onClose={() => {
          if (!purgingAll) clearConfirm();
        }}
        title="清空回收站？"
        description="回收站里的文件会被从磁盘上彻底删除，无法恢复，也不会进入任何存档区。"
        footer={
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" disabled={purgingAll} onClick={clearConfirm}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={purgingAll}
              onClick={() => void purgeAll()}
            >
              {purgingAll ? '正在清空…' : `彻底删除 ${formatNumber(items.length)} 项`}
            </button>
          </div>
        }
      >
        <p>
          这会删除 {formatNumber(items.length)} 项、共 {formatBytes(totalBytes)}。
        </p>
        <p className="doc-note">
          清空后不可恢复：文件不会留在任何地方，也没有“还原”这一步。如果其中还有想留着的，请先点「取消」，逐条恢复或彻底删除。
        </p>
        {purgeAllError !== null && (
          <InlineError message={purgeAllError} onRetry={() => void purgeAll()} />
        )}
      </Modal>
    </section>
  );
}
