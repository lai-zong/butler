'use client';

/**
 * 设置页里需要交互的两块：
 *   ① 行为观察（同意 / 撤回 / 暂停 / 继续）
 *   ② 数据导入（导出是普通链接，不需要 JS）
 *
 * ★★ 行为观察这块是 A10 唯一缺的用户入口：
 *   在此之前只能改 `.env.local` 再重启 —— 而"同意"是**用户的显式动作**，
 *   不该由改配置文件来冒充。
 *
 * ⚠️ 撤回同意会**同时清除已采集数据**，所以按钮上写清楚，不藏在说明里。
 */

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';

interface Consent {
  granted: boolean;
  enabled: boolean;
  retentionDays: number;
  recordedBlocks: number;
}

export function ObservationCard({ initial }: { readonly initial: Consent }): React.ReactElement {
  const router = useRouter();
  const [c, setC] = useState<Consent>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const call = useCallback(
    async (body: Record<string, boolean>) => {
      setBusy(true);
      setMsg(null);
      try {
        const res = await fetch('/api/observation', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => null)) as
          | (Consent & { ok?: boolean; error?: string })
          | null;
        if (!res.ok) {
          setMsg(data?.error ?? `操作失败（HTTP ${res.status}）`);
          return;
        }
        if (data !== null) {
          setC({
            granted: data.granted,
            enabled: data.enabled,
            retentionDays: data.retentionDays,
            recordedBlocks: data.recordedBlocks,
          });
        }
        router.refresh();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  return (
    <div className="card card-pad">
      <div className="row-between">
        <div>
          <div style={{ fontWeight: 500 }}>行为观察</div>
          <div className="small muted" style={{ marginTop: 4, maxWidth: '52ch' }}>
            只记**应用名**与是否在输入，不记窗口标题、不截屏、不记按键内容。
            默认关闭；你可以随时暂停或撤回。
          </div>
        </div>
        <span className="badge" data-tone={c.granted && c.enabled ? 'ok' : undefined}>
          {c.granted ? (c.enabled ? '采集中' : '已暂停') : '未开启'}
        </span>
      </div>

      <div className="kv" style={{ marginTop: 12 }}>
        <span className="k">已记片段</span>
        <span className="v">
          {c.granted ? `${c.recordedBlocks} 段` : '—'}
          {c.granted && ` · 原始记录保留 ${c.retentionDays} 天`}
        </span>
      </div>

      <div className="item-actions">
        {!c.granted ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void call({ granted: true })}>
            同意并开启
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void call({ enabled: !c.enabled })}
            >
              {c.enabled ? '暂停采集' : '继续采集'}
            </button>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void call({ granted: false })}>
              撤回同意（并清除已采集数据）
            </button>
          </>
        )}
        {msg !== null && <span className="dim tiny">{msg}</span>}
      </div>
    </div>
  );
}

/** 数据导入（导出用普通链接即可）*/
export function ImportData(): React.ReactElement {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const doImport = useCallback(
    async (file: File) => {
      const ok = window.confirm(
        `导入会用「${file.name}」里的内容**替换当前全部数据**（会先自动备份）。\n\n确定继续吗？`,
      );
      if (!ok) return;

      setBusy(true);
      setMsg(null);
      setErr(null);
      try {
        const text = await file.text();
        const res = await fetch('/api/transfer/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: text,
        });
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; imported?: { events: number }; restored?: Record<string, number>; error?: string }
          | null;
        if (!res.ok) {
          setErr(data?.error ?? `导入失败（HTTP ${res.status}）`);
          return;
        }
        setMsg(`已导入 ${data?.imported?.events ?? 0} 条事件，数据已重建`);
        router.refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  return (
    <div className="item-actions">
      <a className="btn btn-sm" href="/api/transfer/export" download>
        导出全部数据
      </a>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? '导入中…' : '导入数据'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f !== undefined) void doImport(f);
        }}
      />
      {msg !== null && <span className="dim tiny">{msg}</span>}
      {err !== null && <span className="dim tiny">{err}</span>}
    </div>
  );
}
