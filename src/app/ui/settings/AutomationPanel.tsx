'use client';

/**
 * 设置 → 自动化 / 定时任务（只读）
 *
 * ⚠️ 第一版刻意不提供“立即运行”：
 *   调度器当前还没有单飞锁与单任务超时；按钮先做出来会诱使同时跑两份。
 *   等 D-44 补完后再加操作。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  Badge,
  InlineError,
  SectionHeading,
  Skeleton,
} from '../components/Common';
import { Icon } from '../components/Icon';
import { errorMessage, fetchJson } from '../lib/api.js';
import { formatDateTime, formatNumber } from '../lib/format.js';
import type { SchedulesResponse } from '../lib/types.js';

type Outcome = SchedulesResponse['tasks'][number]['lastOutcome'];

const OUTCOME_LABEL: Record<NonNullable<Outcome>, string> = {
  succeeded: '成功',
  failed: '失败',
  skipped: '跳过',
  retrying: '重试中',
};

const OUTCOME_TONE: Record<
  NonNullable<Outcome>,
  'accent' | 'warn' | 'neutral' | 'danger' | 'info'
> = {
  succeeded: 'accent',
  failed: 'warn',
  skipped: 'neutral',
  retrying: 'info',
};

function runTime(at: number): string {
  return at > 0 ? formatDateTime(at) : '从未运行';
}

export function AutomationPanel(): JSX.Element {
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningKind, setRunningKind] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchJson<SchedulesResponse>('/api/schedules'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runNow = async (kind: string): Promise<void> => {
    setRunningKind(kind);
    setActionError(null);
    setLastMessage(null);
    try {
      const res = await fetch('/api/schedules/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        readonly error?: string;
        readonly run?: { readonly outcome?: string; readonly note?: string | null; readonly summary?: string | null };
      };
      if (!res.ok) throw new Error(body.error ?? `运行失败（HTTP ${res.status}）`);
      const outcome = body.run?.outcome;
      if (outcome !== 'succeeded') {
        throw new Error(body.run?.note ?? body.run?.summary ?? '任务执行失败');
      }
      setLastMessage(body.run?.summary ?? '任务执行完成');
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
      await load();
    } finally {
      setRunningKind(null);
    }
  };

  const tasks = data?.tasks ?? [];
  const failed = tasks.filter((t) => t.lastOutcome === 'failed').length;
  const next = tasks
    .filter((t) => t.nextRunAt > 0)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];

  return (
    <section className="panel settings-panel" aria-label="自动化与定时任务">
      <SectionHeading
        title="自动化"
        description="每日反思、每周复盘、主动检查、行为聚合。到点自动运行，失败留痕。"
        actions={
          <span className={`badge ${data?.running === true ? 'badge--warn' : 'badge--accent'}`}>
            {data?.running === true
              ? '有任务运行中'
              : tasks.length > 0
                ? `${tasks.length} 个内置任务`
                : '等待加载'}
          </span>
        }
      />

      {loading && data === null ? (
        <Skeleton rows={5} height={14} />
      ) : error !== null ? (
        <InlineError message={error} onRetry={() => void load()} />
      ) : (
        <>
          <div className="auto-summary">
            <div>
              <strong>{formatNumber(tasks.length)}</strong>
              <span>内置任务</span>
            </div>
            <div>
              <strong>
                {formatNumber(tasks.filter((t) => t.lastOutcome === 'succeeded').length)}
              </strong>
              <span>上次成功</span>
            </div>
            <div className={failed > 0 ? 'is-warn' : undefined}>
              <strong>{formatNumber(failed)}</strong>
              <span>需关注</span>
            </div>
            <div>
              <strong className="mono">
                {next !== undefined ? formatDateTime(next.nextRunAt).slice(11, 16) : '—'}
              </strong>
              <span>下一次运行</span>
            </div>
          </div>

          {tasks.length === 0 ? (
            <div className="auto-empty">
              <Icon name="clock" size={16} />
              <span>定时任务尚未注册。服务启动后会自动装好四个内置任务。</span>
            </div>
          ) : (
            <div className="auto-list">
              {tasks.map((t) => (
                <div className="auto-task" key={t.kind}>
                  <span className="auto-icon mono" aria-hidden="true">
                    {t.costsTokens ? 'AI' : '↻'}
                  </span>
                  <div className="auto-main">
                    <div className="auto-name">
                      {t.label}
                      {t.due && <span className="auto-due">到期</span>}
                    </div>
                    <div className="auto-meta">
                      {t.schedule} · 上次 <span className="mono">{runTime(t.lastRunAt)}</span>
                      {t.lastOutcome !== null && ` · ${OUTCOME_LABEL[t.lastOutcome]}`}
                      {t.lastError !== null && ` · ${t.lastError}`}
                    </div>
                  </div>
                  <div className="auto-right">
                    <div className="auto-status">
                      {t.lastOutcome !== null ? (
                        <Badge tone={OUTCOME_TONE[t.lastOutcome]}>
                          {OUTCOME_LABEL[t.lastOutcome]}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">尚未运行</Badge>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm auto-run"
                        disabled={runningKind !== null || data?.running === true}
                        onClick={() => void runNow(t.kind)}
                      >
                        {runningKind === t.kind ? '运行中…' : '立即运行'}
                      </button>
                    </div>
                    <span className="auto-next mono">下次 {formatDateTime(t.nextRunAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {data !== null && data.recent.length > 0 && (
            <div className="auto-recent">
              <p className="mini-label">最近运行</p>
              <ul>
                {data.recent.slice(0, 5).map((r) => (
                  <li key={`${r.seq}-${r.kind ?? 'unknown'}`}>
                    <span className="mono auto-recent-time">{formatDateTime(r.at)}</span>
                    <span>{r.label}</span>
                    <span className="auto-recent-result">
                      {r.outcome !== null ? OUTCOME_LABEL[r.outcome] : '记录'}
                      {r.manual ? ' · 手动' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {actionError !== null && <p className="auto-action-error">{actionError}</p>}
          {lastMessage !== null && <p className="auto-action-ok">{lastMessage}</p>}

          <p className="auto-note">
            <strong>手动触发：</strong>
            不占每日额度；同一时刻最多一个任务，单任务超时后会记失败且不重试。
          </p>
        </>
      )}
    </section>
  );
}
