'use client';

/**
 * 记忆审核操作（候选 → 批准 / 驳回）
 *
 * ★★ 这是治理闭环的**人类一半**：
 *   在此之前，判为"待审核"的候选没有任何界面入口，
 *   只能靠 `admission.ts` 的自主准入 —— 用户看到的记忆永远停在候选态。
 *
 * ⚠️ 乐观更新是**错的**：批准可能被状态机拒绝（例如已过期）。
 *    所以这里等接口返回再 `router.refresh()`，并把失败原因显示出来。
 */

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

type Decision = 'approve' | 'reject';

export function ReviewActions({ id }: { readonly id: string }): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState<Decision | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(
    async (decision: Decision) => {
      setBusy(decision);
      setErr(null);
      try {
        const res = await fetch('/api/memory/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, decision }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setErr(body?.error ?? `操作失败（HTTP ${res.status}）`);
          return;
        }
        router.refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [id, router],
  );

  return (
    <div className="item-actions">
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={busy !== null}
        onClick={() => void run('approve')}
      >
        {busy === 'approve' ? '处理中…' : '批准生效'}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy !== null}
        onClick={() => void run('reject')}
      >
        {busy === 'reject' ? '处理中…' : '驳回'}
      </button>
      {err !== null && <span className="dim tiny">{err}</span>}
    </div>
  );
}
