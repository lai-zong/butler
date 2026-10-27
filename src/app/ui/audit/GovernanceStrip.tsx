'use client';

/**
 * 审计页的自主治理摘要。
 *
 * 只读；数据来自 /api/memory/governance，不在这里解释或推断。
 */

import { useEffect, useState } from 'react';

import { InlineError } from '../components/Common';
import { fetchJson } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';

interface Counts {
  readonly diaries: number;
  readonly trial: number;
  readonly promoted: number;
  readonly conflicts: number;
  readonly resolved: number;
  readonly trialArchived: number;
  readonly tombstones: number;
  readonly legacyPending: number;
}

interface Recent {
  readonly seq: number;
  readonly at: number;
  readonly label: string;
  readonly summary: string;
}

interface Response {
  readonly ok: boolean;
  readonly counts?: Counts;
  readonly recent?: readonly Recent[];
}

export function GovernanceStrip(): JSX.Element | null {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchJson<Response>('/api/memory/governance');
        if (!cancelled) setData(r);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取治理摘要失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null) return <InlineError message={error} />;
  if (data?.counts === undefined) return null;

  return (
    <section className="governance-strip">
      <div className="governance-strip-head">
        <span className="mini-label">自主治理 · 最近</span>
        <span className="mono">
          日记 {data.counts.diaries} · 试行 {data.counts.trial} · 转正 {data.counts.promoted} · 裁决{' '}
          {data.counts.resolved}
        </span>
      </div>
      <div className="governance-strip-events">
        {(data.recent ?? []).slice(0, 4).map((e) => (
          <span key={`${e.seq}_${e.label}`}>
            <b>{e.label}</b>
            <i>{e.summary}</i>
            <small>{relativeTime(e.at, Date.now())}</small>
          </span>
        ))}
        {(data.recent ?? []).length === 0 && <span>还没有自动治理记录。</span>}
      </div>
      {data.counts.legacyPending > 0 && (
        <p className="governance-warning">
          旧待审记忆 {data.counts.legacyPending} 条尚未迁移；不参与召回。
        </p>
      )}
    </section>
  );
}
