'use client';

/**
 * 控制台 · 使用节奏
 *
 * ★ 这一页只回答一个问题：你是怎么使用这个界面的。
 *   什么时候打开、在哪一页停留、哪天用得多、有没有固定时段。
 *   它不展示工具、任务、消息、记忆或审查内容 —— 那些不属于“节奏”。
 *
 * ★ 数据全部来自 GET /api/usage（服务端聚合）；这里不自己算时长，
 *   避免界面上的数字与接口对不上。习惯不足时如实说“记录还不够”，
 *   不借用旧的行为观察数据凑数。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Switch } from '../components/Switch';
import { errorMessage } from '../lib/api.js';
import { formatNumber } from '../lib/format.js';
import {
  USAGE_RANGE_OPTIONS,
  USAGE_PAGE_LABEL,
  clearUsageStats,
  fetchUsage,
  formatUsageMinutes,
  saveUsageEnabled,
  setUsageEnabled,
  splitUsageMinutes,
  usageBarPercent,
  usageChartPeak,
  usageConfidencePercent,
  usageMonthDay,
  usageRangeLabel,
  usageWeekday,
  type UsageRangeDays,
} from '../lib/usage.js';
import type { ToastMessage, UsageResponse } from '../lib/types.js';

interface UsageViewProps {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  /** 首次取数结束（无论成功失败）；控制台转场用它判断是否就绪。 */
  readonly onFirstReady?: () => void;
}

export function UsageView({ notify, onFirstReady }: UsageViewProps): JSX.Element {
  const [days, setDays] = useState<UsageRangeDays>(7);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const firstReadyRef = useRef(false);
  const onFirstReadyRef = useRef(onFirstReady);
  onFirstReadyRef.current = onFirstReady;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetchUsage(days);
        if (cancelled) return;
        setData(res);
        // 页面读到的开关是权威值：同步给上报器，关闭后立即停止心跳。
        setUsageEnabled(res.enabled);
      } catch (err) {
        if (cancelled) return;
        setError(errorMessage(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (!firstReadyRef.current) {
            firstReadyRef.current = true;
            onFirstReadyRef.current?.();
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days, nonce]);

  const refresh = useCallback((): void => {
    setNonce((value) => value + 1);
  }, []);

  const toggleEnabled = useCallback(
    async (next: boolean): Promise<void> => {
      if (saving) return;
      setSaving(true);
      try {
        const confirmed = await saveUsageEnabled(next);
        setUsageEnabled(confirmed);
        setData((prev) => (prev === null ? prev : { ...prev, enabled: confirmed }));
        notify(
          confirmed ? '已开始记录使用节奏' : '已暂停记录使用节奏',
          'success',
        );
      } catch (err) {
        notify(errorMessage(err), 'danger');
      } finally {
        setSaving(false);
      }
    },
    [notify, saving],
  );

  const clearStats = useCallback(async (): Promise<void> => {
    if (clearing) return;
    setClearing(true);
    try {
      await clearUsageStats();
      setClearOpen(false);
      notify('已清除使用节奏统计；记忆、对话与任务不受影响', 'success');
      setData(null);
      setNonce((value) => value + 1);
    } catch (err) {
      notify(errorMessage(err), 'danger');
    } finally {
      setClearing(false);
    }
  }, [clearing, notify]);

  const enabled = data === null ? null : data.enabled;
  const daily = data?.daily ?? [];
  const pages = data?.pages ?? [];
  const habits = data?.habits ?? [];

  const peak = useMemo(() => usageChartPeak(daily), [daily]);
  /** 30 天视图下柱子太密：隐藏逐柱读数，只保留日期刻度。 */
  const denseChart = daily.length > 14;
  const pageMinutes = useMemo(
    () => pages.reduce((sum, page) => sum + (Number.isFinite(page.minutes) ? page.minutes : 0), 0),
    [pages],
  );
  const rangeText = data === null ? '' : usageRangeLabel(data.daily);
  const minutesParts = data === null ? null : splitUsageMinutes(data.totalMinutes);
  /** 一两次会话的“均值”不叫均值：至少 3 次才显示。 */
  const avgAvailable = data !== null && data.sessionCount >= 3;
  const hasAnyData =
    data !== null &&
    (data.totalMinutes > 0 ||
      data.visibleMinutes > 0 ||
      data.sessionCount > 0 ||
      data.pages.length > 0);
  const todayKey = daily.length > 0 ? daily[daily.length - 1]?.date ?? '' : '';
  const maxDay = useMemo(
    () => daily.reduce((best, day) => (day.minutes > best.minutes ? day : best), daily[0] ?? { date: '', minutes: 0, sessions: 0 }),
    [daily],
  );

  return (
    <div className="usage">
      <header className="usage-head">
        <div className="usage-head-text">
          <p className="usage-eyebrow">
            <span aria-hidden="true" />
            RHYTHM · 使用节奏
          </p>
          <h1 className="usage-title">使用节奏</h1>
          <p className="usage-desc">
            只记录你在这个界面里的停留：什么时候打开、在哪一页、有没有在操作。
            不记录对话、任务、工具或记忆内容。
          </p>
        </div>

        <div className="usage-head-side">
          <div className={`usage-record${enabled === true ? ' is-on' : ''}`}>
            <span className="usage-record-icon" aria-hidden="true">
              <Icon name={enabled === true ? 'eye' : 'eyeOff'} size={15} />
            </span>
            <span className="usage-record-text">
              <strong>
                {enabled === null ? '读取状态…' : enabled ? '正在记录' : '记录已暂停'}
              </strong>
              <em>
                {enabled === null
                  ? '正在确认开关'
                  : enabled
                    ? '页面可见且聚焦时计时'
                    : '不再产生新的心跳'}
              </em>
            </span>
            <Switch
              checked={enabled === true}
              disabled={enabled === null || saving}
              label="记录使用节奏"
              onChange={(next) => void toggleEnabled(next)}
            />
          </div>

          <div className="usage-head-tools">
            <div className="usage-range" role="group" aria-label="统计区间">
              {USAGE_RANGE_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={option === days ? 'is-active' : ''}
                  aria-pressed={option === days}
                  onClick={() => setDays(option)}
                >
                  近 {option} 天
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`usage-refresh${loading ? ' is-loading' : ''}`}
              onClick={refresh}
              disabled={loading}
              aria-label="重新读取使用节奏"
              title="重新读取使用节奏"
            >
              <Icon name="refresh" size={14} />
              <span>{loading ? '读取中' : '刷新'}</span>
            </button>
          </div>
        </div>
      </header>

      {enabled === false && (
        <div className="usage-banner" role="status">
          <Icon name="eyeOff" size={14} />
          <span>
            记录已暂停，已有统计仍保留在这里。重新打开后，从下一次停留开始产生新的记录。
          </span>
        </div>
      )}

      {data === null && loading && (
        <div className="usage-skeleton" role="status" aria-label="正在读取使用节奏">
          <div className="usage-skeleton-hero" />
          <div className="usage-skeleton-grid">
            <span />
            <span />
          </div>
        </div>
      )}

      {data === null && !loading && error !== null && (
        <section className="usage-error" role="alert">
          <span className="usage-error-mark" aria-hidden="true">
            <Icon name="alert" size={18} />
          </span>
          <div>
            <h2>读取使用节奏失败</h2>
            <p>{error}</p>
            <p className="usage-error-hint">
              这里只显示服务端真实聚合的结果，读不到时不会用演示数据补齐。
            </p>
          </div>
          <button type="button" className="usage-btn" onClick={refresh}>
            重试
          </button>
        </section>
      )}

      {data !== null && (
        <>
          {error !== null && (
            <div className="usage-inline-error" role="alert">
              <span>刷新失败：{error}</span>
              <button type="button" className="usage-btn usage-btn--small" onClick={refresh}>
                重试
              </button>
            </div>
          )}

          {hasAnyData ? (
            <>
              <section className="usage-summary" aria-label={`最近 ${data.days} 天概览`}>
                <header className="usage-summary-head">
                  <p className="usage-summary-range">
                    最近 {data.days} 天{rangeText.length > 0 ? ` · ${rangeText}` : ''}
                  </p>
                  <p className="usage-summary-note">
                    页面在前台共 {formatUsageMinutes(data.visibleMinutes)}；最近 3 分钟有操作才计入活跃。
                  </p>
                </header>

                <ul className="usage-metrics">
                  <li className="usage-metric is-primary">
                    <span className="usage-metric-label">活跃时长</span>
                    <span className="usage-metric-value">
                      <strong>{minutesParts?.value}</strong>
                      <em>{minutesParts?.unit}</em>
                    </span>
                    <span className="usage-metric-sub">合计 {minutesParts?.exact}</span>
                  </li>
                  <li className="usage-metric">
                    <span className="usage-metric-label">活跃天</span>
                    <span className="usage-metric-value">
                      <strong>{data.activeDays}</strong>
                      <em> / {data.days} 天</em>
                    </span>
                    <span className="usage-metric-sub">共 {data.days} 个日历天</span>
                  </li>
                  <li className="usage-metric">
                    <span className="usage-metric-label">使用会话</span>
                    <span className="usage-metric-value">
                      <strong>{formatNumber(data.sessionCount)}</strong>
                      <em> 次</em>
                    </span>
                    <span className="usage-metric-sub">间隔 10 分钟以上算一次</span>
                  </li>
                  <li className="usage-metric">
                    <span className="usage-metric-label">单次均值</span>
                    <span className="usage-metric-value">
                      <strong>
                        {avgAvailable ? Math.round(data.avgSessionMinutes) : '—'}
                      </strong>
                      {avgAvailable && <em> 分钟</em>}
                    </span>
                    <span className="usage-metric-sub">
                      {avgAvailable ? '按使用会话计算' : '样本不足（少于 3 次会话）'}
                    </span>
                  </li>
                </ul>

                {data.activeDays === 0 ? (
                  <p className="usage-summary-warn">
                    这段时间只有页面开着，没有检测到操作，因此活跃时长为 0。
                  </p>
                ) : data.activeDays < 3 ? (
                  <p className="usage-summary-warn">
                    活跃天还只有 {data.activeDays} 天，下面的习惯判断还不稳定。
                  </p>
                ) : null}
              </section>

              <div className="usage-grid">
                <section className="usage-panel" aria-labelledby="usage-daily-title">
                  <header className="usage-panel-head">
                    <div>
                      <h2 id="usage-daily-title">每天的使用</h2>
                      <p>柱高是活跃分钟，底部是使用次数；空柱表示那天没有记录。</p>
                    </div>
                    <span className="usage-panel-badge mono">
                      峰值 {maxDay.minutes > 0 ? formatUsageMinutes(maxDay.minutes) : '—'}
                    </span>
                  </header>

                  <div className="usage-chart" role="group" aria-label="按天的活跃分钟">
                    <ol
                      className={`usage-chart-bars${denseChart ? ' is-dense' : ''}`}
                      style={{ '--usage-cols': daily.length } as CSSProperties}
                    >
                      {daily.map((day, dayIndex) => {
                        const percent = usageBarPercent(day.minutes, peak);
                        const isToday = day.date === todayKey;
                        const labelDay =
                          !denseChart ||
                          dayIndex === 0 ||
                          dayIndex === daily.length - 1 ||
                          (dayIndex + 1) % 5 === 0;
                        return (
                          <li
                            key={day.date}
                            className={`usage-chart-col${isToday ? ' is-today' : ''}${
                              day.minutes > 0 ? '' : ' is-empty'
                            }`}
                            title={`${usageMonthDay(day.date)} ${usageWeekday(day.date)}：活跃 ${formatUsageMinutes(
                              day.minutes,
                            )}，使用 ${day.sessions} 次`}
                          >
                            <span className="usage-chart-value mono">
                              {day.minutes > 0 ? formatUsageMinutes(day.minutes) : ''}
                            </span>
                            <span className="usage-chart-track" aria-hidden="true">
                              <span
                                className="usage-chart-fill"
                                style={{ '--usage-bar': `${percent}%` } as CSSProperties}
                              />
                            </span>
                            <span className="usage-chart-weekday">
                              {labelDay
                                ? denseChart
                                  ? usageMonthDay(day.date)
                                  : usageWeekday(day.date)
                                : ''}
                            </span>
                            <span className="usage-chart-date mono">
                              {denseChart ? '' : usageMonthDay(day.date)}
                            </span>
                            <span className="usage-chart-sessions mono">
                              {day.sessions > 0 ? `${day.sessions} 次` : ''}
                            </span>
                            <span className="sr-only">
                              {`${usageMonthDay(day.date)}，活跃 ${formatUsageMinutes(day.minutes)}，使用 ${day.sessions} 次`}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                </section>

                <section className="usage-panel" aria-labelledby="usage-pages-title">
                  <header className="usage-panel-head">
                    <div>
                      <h2 id="usage-pages-title">各页面</h2>
                      <p>按活跃分钟排序；切页会记一次访问。</p>
                    </div>
                    <span className="usage-panel-badge mono">{pages.length} 个页面</span>
                  </header>

                  {pages.length === 0 ? (
                    <p className="usage-empty">还没有页面记录。</p>
                  ) : (
                    <ul className="usage-page-list">
                      {pages.map((page, index) => {
                        const share =
                          pageMinutes > 0 ? Math.round((page.minutes / pageMinutes) * 100) : 0;
                        return (
                          <li className="usage-page-row" key={page.id}>
                            <span className="usage-page-name">
                              <i aria-hidden="true" />
                              {page.label.length > 0 ? page.label : USAGE_PAGE_LABEL[page.id]}
                              {index === 0 && <b className="usage-page-top">最常用</b>}
                            </span>
                            <span className="usage-page-visits mono">{page.visits} 次</span>
                            <span className="usage-page-minutes mono">
                              {formatUsageMinutes(page.minutes)}
                            </span>
                            <span className="usage-page-track" aria-hidden="true">
                              <i style={{ width: `${share}%` }} />
                            </span>
                            <span className="sr-only">
                              {`${page.label}：访问 ${page.visits} 次，活跃 ${formatUsageMinutes(
                                page.minutes,
                              )}，占 ${share}%`}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </div>

              <section className="usage-panel usage-habits" aria-labelledby="usage-habits-title">
                <header className="usage-panel-head">
                  <div>
                    <h2 id="usage-habits-title">使用习惯</h2>
                    <p>由服务端按活跃天推断；证据不足时不会给出结论。</p>
                  </div>
                  {data.activeDays > 0 && (
                    <span className="usage-panel-badge mono">观察 {data.activeDays} 个活跃日</span>
                  )}
                </header>

                {habits.length === 0 ? (
                  <p className="usage-empty">
                    {data.activeDays < 3
                      ? `习惯至少需要 3 个活跃日的记录，现在只有 ${data.activeDays} 天。`
                      : '记录还在积累，暂时看不出稳定的时段。'}
                  </p>
                ) : (
                  <ul className="usage-habit-list">
                    {habits.map((habit) => {
                      const percent = usageConfidencePercent(habit.confidence);
                      return (
                        <li className="usage-habit" key={habit.id}>
                          <span className="usage-habit-mark" aria-hidden="true">
                            <Icon name="sparkle" size={14} />
                          </span>
                          <div className="usage-habit-text">
                            <p>{habit.text}</p>
                            <span className="usage-habit-meta mono">
                              置信度 {percent}% · 观察 {habit.observedDays} 天
                            </span>
                          </div>
                          <span className="usage-habit-meter" aria-hidden="true">
                            <i style={{ width: `${percent}%` }} />
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <section className={`usage-empty-state${enabled === false ? ' is-paused' : ''}`}>
              <span className="usage-empty-orbit" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <h2>{enabled === false ? '记录已暂停' : '还没有使用记录'}</h2>
              <p>
                {enabled === false
                  ? '重新打开记录后，从下一次停留开始积累。这里不会用演示数据填充。'
                  : '去对话、定时任务、记忆或演化页停留一会儿，这里会慢慢出现每天的使用、页面分布和使用习惯。'}
              </p>
              <p className="usage-empty-note">
                这一页本身不参与统计；习惯至少要 3 个活跃日，记录只写页面、时间与是否在操作，不写内容。
              </p>
              <div className="usage-empty-actions">
                {enabled === false ? (
                  <button
                    type="button"
                    className="usage-btn usage-btn--primary"
                    disabled={saving}
                    onClick={() => void toggleEnabled(true)}
                  >
                    继续记录
                  </button>
                ) : (
                  <button type="button" className="usage-btn" onClick={refresh}>
                    再看一眼
                  </button>
                )}
              </div>
            </section>
          )}

          <footer className="usage-foot">
            <p className="usage-foot-note">
              <Icon name="lock" size={12} />
              页面隐藏或失焦立即停止上报；最近 3 分钟没有操作时仍然记“开着”，但不计入活跃时长。
              这一页本身不参与统计；数据只保存在本机。
            </p>
            <button
              type="button"
              className="usage-clear"
              onClick={() => setClearOpen(true)}
              disabled={clearing}
            >
              <Icon name="trash" size={13} />
              清除统计
            </button>
          </footer>
        </>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {loading
          ? '正在读取使用节奏'
          : data === null
            ? ''
            : `最近 ${data.days} 天活跃 ${formatUsageMinutes(data.totalMinutes)}，活跃 ${data.activeDays} 天`}
      </p>

      <Modal
        open={clearOpen}
        onClose={() => {
          if (!clearing) setClearOpen(false);
        }}
        title="清除使用节奏统计？"
        description="只会删除页面访问的时间记录；对话、记忆、任务、工具与审查结果都不受影响。"
        footer={
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={clearing}
              onClick={() => setClearOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={clearing}
              onClick={() => void clearStats()}
            >
              {clearing ? '清除中…' : '确认清除'}
            </button>
          </div>
        }
      >
        <p className="usage-clear-note">
          清除后无法恢复。记录开关保持不变；如果记录还在打开，下一次停留会重新开始积累。
        </p>
      </Modal>
    </div>
  );
}
