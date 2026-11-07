'use client';

/**
 * 全局到期提醒条 —— 主界面任何位置（对话 / 设置）都能看到
 *
 * ★ 这不是桌面悬浮框：只在应用打开、主界面可见时出现，
 *   关掉应用就不会弹；下次打开时逾期提醒仍会重新出现。
 *
 * ★ 放在主区域顶部的细条里，和既有的全局横幅同一处，不压输入框，
 *   不锁滚动、不抢焦点；控制台打开时整个不渲染，所以不会打断聊天或治理操作。
 *
 * ★ 同一个任务在本次打开期间只提示一次（关闭提示也算处理过），
 *   避免每 25 秒把人烦一遍；要做的事始终留在「定时任务」页里。
 *   但「稍后 10 分钟」醒来、暂停后恢复、或任务被编辑过之后，
 *   服务端会刷新 updatedAt，同一个任务会重新提示一次 —— 稍后本来就是为了再被叫醒。
 *   同时到期多条时先显示最早的一条，其余留到定时任务页处理。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import type {
  TaskMutationResponse,
  TasksResponse,
  ToastMessage,
  UserTaskView,
} from '../lib/types.js';
import { scheduleLabel } from './taskFormat.js';

const POLL_MS = 25_000;
const SNOOZE_MINUTES = 10;

interface DueReminderBannerProps {
  /** 只有主界面可见时才提示；进控制台或停在定时任务页时为 false。 */
  readonly active: boolean;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onOpenTasks: () => void;
}

export function DueReminderBanner({
  active,
  notify,
  onOpenTasks,
}: DueReminderBannerProps): JSX.Element | null {
  const [visible, setVisible] = useState<readonly UserTaskView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * 本次打开期间已经提示过的任务：id → 提示时的 `updatedAt`。
   *
   * ★ 用 `updatedAt` 而不是单纯的 id：
   *   「稍后 10 分钟」醒来、暂停后恢复、编辑过任务，服务端都会刷新 updatedAt，
   *   这时同一个任务应该重新提示一次；没被改动过的任务则只提示一次。
   */
  const seenRef = useRef<Map<string, number>>(new Map());
  const activeRef = useRef(active);
  activeRef.current = active;

  const poll = useCallback(async (): Promise<void> => {
    if (!activeRef.current) return;
    try {
      const res = await fetchJson<TasksResponse>('/api/tasks');
      if (!activeRef.current) return;
      const due = res.tasks.filter(
        (task) => task.kind === 'reminder' && task.status === 'active' && task.due,
      );
      const fresh = due.filter(
        (task) => seenRef.current.get(task.id) !== task.updatedAt,
      );
      for (const task of fresh) seenRef.current.set(task.id, task.updatedAt);
      setVisible((prev) => {
        const next: UserTaskView[] = [];
        const picked = new Set<string>();
        // 已经提示过、并且仍然到期的：保留，并换成最新数据
        for (const item of prev) {
          const current = due.find((task) => task.id === item.id);
          if (current !== undefined && !picked.has(current.id)) {
            next.push(current);
            picked.add(current.id);
          }
        }
        // 这次新到期（或改动后重新到期）的：接在后面
        for (const task of fresh) {
          if (picked.has(task.id)) continue;
          next.push(task);
          picked.add(task.id);
        }
        return next;
      });
    } catch {
      // 全局提示失败不打扰用户；定时任务页会有明确的错误与重试
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void poll();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, poll]);

  const act = async (task: UserTaskView, action: 'complete' | 'snooze'): Promise<void> => {
    if (busyId !== null) return;
    setBusyId(task.id);
    try {
      await postJson<TaskMutationResponse>(
        `/api/tasks/${encodeURIComponent(task.id)}/action`,
        { action, ...(action === 'snooze' ? { minutes: SNOOZE_MINUTES } : {}) },
      );
      // 稍后 / 完成后要重新武装：不清掉标记，10 分钟后再到期就永远不提示了。
      seenRef.current.delete(task.id);
      setVisible((prev) => prev.filter((item) => item.id !== task.id));
      notify(action === 'complete' ? '提醒已完成' : `已稍后 ${SNOOZE_MINUTES} 分钟`, 'success');
      // 立刻同步一次，保证「完成 / 恢复」后的状态与列表一致。
      await poll();
    } catch (err) {
      notify(errorMessage(err), 'danger');
    } finally {
      setBusyId(null);
    }
  };

  const current = active ? visible[0] : undefined;
  if (current === undefined) return null;

  const rest = visible.length - 1;

  return (
    <section className="due-strip" aria-label="到时间的提醒">
      <span className="due-strip-icon">
        <Icon name="alert" size={14} />
      </span>
      <span className="due-strip-main">
        <strong>{current.title}</strong>
        <span>
          {current.nextRunAt !== null
            ? `原定 ${formatDateTime(current.nextRunAt)}`
            : scheduleLabel(current.schedule)}
        </span>
      </span>
      {rest > 0 && <span className="due-strip-more">还有 {rest} 条</span>}
      <span className="due-strip-actions">
        <button
          type="button"
          className="btn btn-primary btn-xs"
          disabled={busyId !== null}
          onClick={() => void act(current, 'complete')}
        >
          完成
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          disabled={busyId !== null}
          onClick={() => void act(current, 'snooze')}
        >
          稍后 {SNOOZE_MINUTES} 分钟
        </button>
        <button type="button" className="text-btn due-strip-open" onClick={onOpenTasks}>
          去定时任务
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="关闭这个提示"
          onClick={() => setVisible([])}
        >
          <Icon name="close" size={14} />
        </button>
      </span>
    </section>
  );
}
