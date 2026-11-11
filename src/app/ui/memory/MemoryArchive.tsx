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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../components/Icon';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import { formatNumber, relativeTime, truncate } from '../lib/format.js';
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
  readonly note?: string;
}

/**
 * 打码用的固定占位：长度不随原文变化。
 * 如果按原文长度出点，点数本身就成了"这条记忆有多长"的信息。
 */
const MASK = '••••••••';

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

export function MemoryArchive({
  open,
  onClose,
  notify,
  onChanged,
}: MemoryArchiveProps): JSX.Element {
  const now = useNow(30_000);
  const asideRef = useRef<HTMLElement | null>(null);

  const [items, setItems] = useState<readonly MemoryArchiveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<MemoryArchiveEntry | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

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
    setPurgeTarget(null);
    setPurgeError(null);
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
      if (purgeTarget !== null) {
        setPurgeTarget(null);
        setPurgeError(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, purgeTarget, onClose]);

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

  const purge = useCallback(async (): Promise<void> => {
    if (purgeTarget === null) return;
    const archiveId = purgeTarget.archiveId;
    setBusy({ archiveId, kind: 'purge' });
    setPurgeError(null);
    try {
      await fetchJson(`/api/memory/archive/${encodeURIComponent(archiveId)}`, {
        method: 'DELETE',
      });
      notify('这条记忆的原文已被抹除，无法恢复。', 'success');
      setPurgeTarget(null);
      refresh();
      onChanged();
    } catch (err) {
      // 抹除失败必须留在确认框里说清楚：关掉它会让用户以为已经删了。
      setPurgeError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [purgeTarget, notify, refresh, onChanged]);

  // 确认框挂在 .mm 上（和记忆详情的删除确认同一个落点），才能盖住星图与抽屉。
  const overlayTarget = typeof document === 'undefined' ? null : document.querySelector('.mm');
  const purgeBusy =
    purgeTarget !== null &&
    busy !== null &&
    busy.kind === 'purge' &&
    busy.archiveId === purgeTarget.archiveId;

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
                : `${formatNumber(items.length)} 条已删除的记忆`}
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
                      setPurgeError(null);
                      setPurgeTarget(entry);
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

      {purgeTarget !== null && overlayTarget !== null
        ? createPortal(
            <div
              className="md-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                // 抹除进行中不允许点遮罩关掉：请求的结果还没回来。
                if (event.target === event.currentTarget && !purgeBusy) {
                  setPurgeTarget(null);
                  setPurgeError(null);
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
                <h3 id="ma-purge-title">彻底删除这条记忆？</h3>
                <p id="ma-purge-desc">
                  原文会被抹除，无法恢复；事件流里只留下指纹。
                  如果你还想留着可恢复的退路，请点「取消」。
                </p>
                <p className="md-modal-warning">
                  存档记录会一并消失，之后无法再读回这条记忆的内容。
                </p>
                {purgeError !== null && (
                  <p className="md-modal-error" role="alert">
                    {purgeError}
                  </p>
                )}
                <div className="md-modal-actions">
                  <button
                    type="button"
                    className="md-modal-cancel"
                    disabled={purgeBusy}
                    onClick={() => {
                      setPurgeTarget(null);
                      setPurgeError(null);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="md-modal-danger"
                    disabled={purgeBusy}
                    onClick={() => void purge()}
                  >
                    {purgeBusy ? '正在抹除…' : '彻底删除'}
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
