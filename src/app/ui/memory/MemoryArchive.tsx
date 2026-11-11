'use client';

/**
 * 记忆存档区
 *
 * ★ 删除拆成两步之后，「删掉的记忆去哪了」必须有个能看见的答案：
 *   这个抽屉就是那个答案，而且它**只服务记忆** —— 文档有自己的存档区，
 *   工作区文件将来也会有自己的回收站。分区独立是产品规则，不是实现细节：
 *   合在一起会让人在错误的列表里点下"彻底删除"。
 *
 * ★ 敏感域默认打码：存档区是回看已删除内容的地方，屏幕更容易被旁人看到；
 *   原文要用户主动点「显示原文」才展开，关闭抽屉即收回。
 *
 * ★ 两个操作的后果完全不同，所以视觉上分开：
 *   恢复 = 回到记忆库（重新参与召回）；彻底删除 = 抹除原文（不可撤销）。
 *   后者必须过一次确认，且文案要说出"无法恢复"，否则它和"删除"看起来没区别。
 *
 * ★ 为什么还要一个「清空存档区」：存档不会自动过期（用户确认过的规则），
 *   所以必须给一个"一次清干净"的出口。但它是"所有条目一起彻底删除"，
 *   因此同样走二次确认，而不是像恢复那样点一下就执行。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../components/Icon';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import { formatBytes, formatNumber, relativeTime, truncate } from '../lib/format.js';
import { useNow } from '../lib/hooks.js';
import type { MemoryClass, MemoryItem, ToastMessage } from '../lib/types.js';

interface MemoryArchiveProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  /** 存档变动后让记忆页重新取星图：恢复会新增记忆，彻底删除会让它永不出现。 */
  readonly onChanged: () => void;
}

/**
 * 存档记录的形状。
 *
 * `memory` 直接用记忆页的 `MemoryItem`：服务端 /api/memory/archive 与 /api/memory
 * 序列化的是同一个 DTO，前端不该为同一条记忆维护第二份字段表。
 */
interface MemoryArchiveEntry {
  readonly archiveId: string;
  readonly reason: string;
  readonly archivedAt: number;
  readonly memory: MemoryItem;
}

interface MemoryArchiveResponse {
  readonly ok: boolean;
  readonly total: number;
  readonly items: readonly MemoryArchiveEntry[];
  /**
   * 存档区文件占用字节数。
   *
   * 声明成可选：这个字段是后加的，若服务端还没重启（仍在跑旧路由），
   * 缺字段时按 0 显示，而不是让标题区出现一个 NaN。
   */
  readonly bytes?: number;
  readonly note?: string;
}

/**
 * 打码用的固定占位：长度不随原文变化。
 * 如果按原文长度出点，点数本身就成了"这条记忆有多长"的信息。
 */
const MASK = '••••••••';

/**
 * 占用大小的格式化统一走 `lib/format.ts` 的 formatBytes ——
 * 同一个数字在记忆存档区、文档存档区、回收站必须显示成同一种写法。
 */

const CLASS_TONE: Record<MemoryClass, string> = {
  global_constraint: 'is-danger',
  global_shared: 'is-neutral',
  sensitive: 'is-warn',
  domain: 'is-info',
};

/** 一次只允许一个操作在跑：两个按钮同时按下去会产生互相矛盾的提示。 */
interface BusyState {
  readonly archiveId: string;
  readonly kind: 'restore' | 'purge';
}

/**
 * 确认框的两个用途：抹除单条 / 清空整个存档区。
 *
 * 合成一个状态是为了只保留一处 Esc、遮罩与"操作进行中不许关"的逻辑 ——
 * 两个确认框各写一套，迟早会出现"一个能按 Esc 关、另一个关不掉"。
 */
type ConfirmState =
  | { readonly kind: 'entry'; readonly entry: MemoryArchiveEntry }
  | { readonly kind: 'all' };

export function MemoryArchive({
  open,
  onClose,
  notify,
  onChanged,
}: MemoryArchiveProps): JSX.Element {
  const now = useNow(30_000);
  const asideRef = useRef<HTMLElement | null>(null);

  const [items, setItems] = useState<readonly MemoryArchiveEntry[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [purgingAll, setPurgingAll] = useState(false);

  const refresh = useCallback((): void => {
    setNonce((value) => value + 1);
  }, []);

  // ── 取存档列表：只在抽屉打开时取 ──
  // 存档区是低频入口；记忆页首屏已经要画星图，不该再多打一个请求。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await fetchJson<MemoryArchiveResponse>('/api/memory/archive');
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
  }, [open, nonce]);

  // ── 关闭时收回已展开的原文与确认框 ──
  // 打码的意义是"不让敏感原文在屏幕上久留"，不是"点一次就永久显示"。
  useEffect(() => {
    if (open) return;
    setRevealed(new Set<string>());
    setConfirm(null);
    setConfirmError(null);
  }, [open]);

  // 抽屉关闭时仍在 DOM 里（保留滑入动画），所以要用 inert 挡住 Tab。
  useEffect(() => {
    const panel = asideRef.current;
    if (panel === null) return;
    panel.toggleAttribute('inert', !open);
    if (open) panel.focus();
    return () => {
      panel.removeAttribute('inert');
    };
  }, [open]);

  // Esc 逐层退出：先关确认框，再关抽屉；范围只在这一页。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      if (confirm !== null) {
        setConfirm(null);
        setConfirmError(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, confirm, onClose]);

  const toggleReveal = useCallback((archiveId: string): void => {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(archiveId)) next.delete(archiveId);
      else next.add(archiveId);
      return next;
    });
  }, []);

  const restore = useCallback(
    async (entry: MemoryArchiveEntry): Promise<void> => {
      setBusy({ archiveId: entry.archiveId, kind: 'restore' });
      try {
        await postJson(`/api/memory/archive/${encodeURIComponent(entry.archiveId)}`, {
          action: 'restore',
        });
        /**
         * 敏感域不在 toast 里回显内容：提示会停留在屏幕上，
         * 打码的意义就被一条"已经恢复成功"的提示抵消了。
         */
        notify(
          entry.memory.memClass === 'sensitive'
            ? '已恢复一条敏感域记忆，回到记忆库并重新参与召回。'
            : `已恢复这条记忆：${truncate(entry.memory.content, 24)}`,
          'success',
        );
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

  const purgeEntry = useCallback(
    async (entry: MemoryArchiveEntry): Promise<void> => {
      setBusy({ archiveId: entry.archiveId, kind: 'purge' });
      setConfirmError(null);
      try {
        await fetchJson(`/api/memory/archive/${encodeURIComponent(entry.archiveId)}`, {
          method: 'DELETE',
        });
        notify('这条记忆的原文已被抹除，无法恢复。', 'success');
        setConfirm(null);
        refresh();
        onChanged();
      } catch (err) {
        // 抹除失败必须留在确认框里说清楚：关掉它会让用户以为已经删了。
        setConfirmError(errorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [notify, refresh, onChanged],
  );

  /**
   * 清空整个存档区。
   *
   * 逐条抹除（写墓碑 + intervention.forgotten）由服务端完成，这里只负责
   * "确认 → 调接口 → 让列表归零"。成功后立刻清空本地列表与占用，
   * 避免刷新回来之前屏幕上还留着已经被抹掉的条目。
   */
  const purgeAll = useCallback(async (): Promise<void> => {
    setPurgingAll(true);
    setConfirmError(null);
    try {
      const res = await postJson<{ readonly ok: boolean; readonly purged: number }>(
        '/api/memory/archive',
        { action: 'purge-all', confirm: 'confirmed' },
      );
      setConfirm(null);
      setItems([]);
      setTotalBytes(0);
      notify(`存档区已清空，${formatNumber(res.purged)} 条记忆的原文已抹除，无法恢复。`, 'success');
      refresh();
      onChanged();
    } catch (err) {
      // 清空失败留在确认框里：关掉它会让用户以为已经清空了。
      setConfirmError(errorMessage(err));
    } finally {
      setPurgingAll(false);
    }
  }, [notify, refresh, onChanged]);

  // 确认框挂在 .mm 上（和记忆详情的删除确认同一个落点），才能盖住星图与抽屉。
  const overlayTarget = typeof document === 'undefined' ? null : document.querySelector('.mm');
  const confirmBusy =
    confirm === null
      ? false
      : confirm.kind === 'all'
        ? purgingAll
        : busy !== null && busy.kind === 'purge' && busy.archiveId === confirm.entry.archiveId;

  return (
    <aside
      id="memory-archive-panel"
      className={`mm-panel${open ? ' is-open' : ''}`}
      aria-label="记忆存档区"
      aria-hidden={!open}
      ref={asideRef}
      tabIndex={-1}
    >
      <header className="md-head">
        <span
          className="md-orb"
          aria-hidden="true"
          style={{
            background:
              'radial-gradient(circle at 34% 30%, #f3d9b6 0%, #b07a3f 42%, rgba(6, 13, 15, 0.92) 100%)',
          }}
        />
        <div className="md-head-main">
          <h2 className="md-title">记忆存档区</h2>
          <p className="md-sub">
            {loading
              ? '正在读取…'
              : error !== null
                ? '读取失败'
                : `${formatNumber(items.length)} 条已删除的记忆 · 占用 ${formatBytes(totalBytes)}`}
          </p>
        </div>
        <button type="button" className="md-close" onClick={onClose} aria-label="关闭记忆存档区">
          <Icon name="close" size={15} />
        </button>
      </header>

      <div className="md-tags">
        <span className="md-tag is-warn">
          <Icon name="history" size={10} />
          独立存档区
        </span>
        <span className="md-tag is-quiet">不参与召回</span>
      </div>

      <p className="md-muted">
        存档期间这些记忆不参与召回。恢复 = 回到记忆库；彻底删除 = 抹除原文，不可撤销。
      </p>

      {/* 清空入口只在真的有条目时出现：空存档区上摆一个"清空"按钮，
          用户会怀疑这个按钮是不是坏了。放在列表上方而不是每一行里，
          是因为它作用于整个存档区，不属于任何一条记忆。 */}
      {!loading && error === null && items.length > 0 && (
        <div className="md-actions" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            className="md-delete"
            disabled={busy !== null || purgingAll}
            onClick={() => {
              setConfirmError(null);
              setConfirm({ kind: 'all' });
            }}
          >
            <Icon name="trash" size={12} />
            清空存档区
          </button>
        </div>
      )}

      {error !== null ? (
        <div className="md-retry">
          <span>读取存档区失败：{error}</span>
          <button type="button" className="text-btn" onClick={refresh}>
            重试
          </button>
        </div>
      ) : loading ? (
        <div className="md-skeleton" aria-label="正在读取记忆存档区">
          <span />
          <span />
          <span />
        </div>
      ) : items.length === 0 ? (
        <div className="mm-text-empty" style={{ marginTop: 16 }}>
          <span className="mm-text-empty-mark" aria-hidden="true">
            <Icon name="history" size={17} />
          </span>
          <p>存档区还是空的</p>
          <p>这里存放从记忆页删除的记忆，可恢复或彻底删除。</p>
        </div>
      ) : (
        <ul className="md-links">
          {items.map((entry) => {
            const item = entry.memory;
            const sensitive = item.memClass === 'sensitive';
            const shown = sensitive && !revealed.has(entry.archiveId);
            const restoring =
              busy !== null && busy.archiveId === entry.archiveId && busy.kind === 'restore';
            return (
              <li key={entry.archiveId} className="md-section">
                <div className="md-tags" style={{ marginTop: 0 }}>
                  <span className={`md-tag ${CLASS_TONE[item.memClass]}`}>{item.memClassLabel}</span>
                  <span className="md-tag is-neutral">{item.kindLabel}</span>
                  {item.domainLabel !== null && (
                    <span className="md-tag is-neutral">{item.domainLabel}</span>
                  )}
                  <span className="md-tag is-quiet mono">
                    {relativeTime(entry.archivedAt, now)}
                  </span>
                </div>

                <p className="md-content">{shown ? MASK : truncate(item.content, 160)}</p>
                <p className="md-muted">删除原因：{entry.reason}</p>

                <div className="md-actions">
                  <button
                    type="button"
                    className="md-action"
                    disabled={busy !== null}
                    onClick={() => void restore(entry)}
                  >
                    <Icon name="history" size={12} />
                    {restoring ? '恢复中…' : '恢复'}
                  </button>
                  {sensitive && (
                    <button
                      type="button"
                      className="md-action"
                      aria-pressed={revealed.has(entry.archiveId)}
                      onClick={() => toggleReveal(entry.archiveId)}
                    >
                      <Icon name={revealed.has(entry.archiveId) ? 'eyeOff' : 'eye'} size={12} />
                      {revealed.has(entry.archiveId) ? '隐藏原文' : '显示原文'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="md-delete"
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmError(null);
                      setConfirm({ kind: 'entry', entry });
                    }}
                  >
                    <Icon name="trash" size={12} />
                    彻底删除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {confirm !== null && overlayTarget !== null
        ? createPortal(
            <div
              className="md-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                // 抹除进行中不允许点遮罩关掉：请求的结果还没回来。
                if (event.target === event.currentTarget && !confirmBusy) {
                  setConfirm(null);
                  setConfirmError(null);
                }
              }}
            >
              <div
                className="md-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="ma-purge-title"
                aria-describedby="ma-purge-desc"
              >
                <h3 id="ma-purge-title">
                  {confirm.kind === 'all' ? '清空整个记忆存档区？' : '彻底删除这条记忆？'}
                </h3>
                <p id="ma-purge-desc">
                  {confirm.kind === 'all'
                    ? `存档区里 ${formatNumber(items.length)} 条记忆的原文会被全部抹除，不可恢复；事件流里只留下指纹。`
                    : '原文会被抹除，无法恢复；事件流里只留下指纹。如果你还想留着可恢复的退路，请点「取消」。'}
                </p>
                <p className="md-modal-warning">
                  {confirm.kind === 'all'
                    ? '这不是「移入存档区」的反向操作：清空后没有列表可以再点恢复，所有条目会被彻底删除。'
                    : '存档记录会一并消失，之后无法再读回这条记忆的内容。'}
                </p>
                {confirmError !== null && (
                  <p className="md-modal-error" role="alert">
                    {confirmError}
                  </p>
                )}
                <div className="md-modal-actions">
                  <button
                    type="button"
                    className="md-modal-cancel"
                    disabled={confirmBusy}
                    onClick={() => {
                      setConfirm(null);
                      setConfirmError(null);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="md-modal-danger"
                    disabled={confirmBusy}
                    onClick={() =>
                      void (confirm.kind === 'all' ? purgeAll() : purgeEntry(confirm.entry))
                    }
                  >
                    {confirm.kind === 'all'
                      ? confirmBusy
                        ? '正在清空…'
                        : '清空存档区'
                      : confirmBusy
                        ? '正在抹除…'
                        : '彻底删除'}
                  </button>
                </div>
              </div>
            </div>,
            overlayTarget,
          )
        : null}
    </aside>
  );
}
