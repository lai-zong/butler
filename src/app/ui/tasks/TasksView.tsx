'use client';

/**
 * 定时任务空间 —— 用户自己建的提醒与工作
 *
 * ★ 这里只放用户自己的任务；设置里的「自动化」内置任务仍在原处，
 *   两者共用事件流作为运行记录，但定义与入口不混在一起。
 *
 * ★ 提醒不做桌面推送：应用没有常驻悬浮框，假装能弹窗只会骗人。
 *   页面打开时轮询 due 状态，关闭应用后下次打开仍看到逾期。
 *
 * ★ 立即运行是一次真实的模型执行（几十秒到几分钟），
 *   运行期间禁用重复点击，结束后重新拉列表拿最新的结果与下次时间。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Badge,
  EmptyState,
  InlineError,
  PageHeader,
  SectionHeading,
  Skeleton,
} from '../components/Common';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import { formatDateTime, truncate } from '../lib/format.js';
import { useNow } from '../lib/hooks.js';
import type {
  ModelChoicesResponse,
  TaskKind,
  TaskMutationResponse,
  TaskRunResponse,
  TasksResponse,
  ToastMessage,
  UserTaskView,
} from '../lib/types.js';
import { TaskForm, type TaskModelOption } from './TaskForm';
import {
  KIND_LABEL,
  OUTCOME_LABEL,
  PERMISSION_LABEL,
  PERMISSION_NOTE,
  nextRunLabel,
  outcomeTone,
  scheduleLabel,
  snoozeLabel,
  workspaceShortLabel,
} from './taskFormat.js';

/** 15–30 秒之间：到点的提醒最迟半分钟出现，服务端压力也可以忽略。 */
const POLL_MS = 20_000;
const SNOOZE_MINUTES = 10;

type TaskAction = 'complete' | 'snooze' | 'pause' | 'resume';

const ACTION_DONE: Record<TaskAction, string> = {
  complete: '提醒已完成',
  snooze: `已稍后 ${SNOOZE_MINUTES} 分钟`,
  pause: '已暂停',
  resume: '已恢复',
};

interface TasksViewProps {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  /** 页面是否处于前台；隐藏时停止轮询，但保留已加载数据。 */
  readonly isActive?: boolean;
}

function byNextRun(a: UserTaskView, b: UserTaskView): number {
  const left = a.nextRunAt ?? Number.MAX_SAFE_INTEGER;
  const right = b.nextRunAt ?? Number.MAX_SAFE_INTEGER;
  return left - right;
}

function byUpdated(a: UserTaskView, b: UserTaskView): number {
  return b.updatedAt - a.updatedAt;
}

export function TasksView({ notify, isActive = true }: TasksViewProps): JSX.Element {
  const [tasks, setTasks] = useState<readonly UserTaskView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formKind, setFormKind] = useState<TaskKind>('reminder');
  const [editing, setEditing] = useState<UserTaskView | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<UserTaskView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [showArchive, setShowArchive] = useState(false);

  const [models, setModels] = useState<readonly TaskModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const seqRef = useRef(0);
  const now = useNow(15_000);

  const load = useCallback(async (): Promise<void> => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    try {
      const res = await fetchJson<TasksResponse>('/api/tasks');
      if (seq !== seqRef.current) return;
      setTasks(res.tasks);
      setError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(errorMessage(err));
    }
  }, []);

  const loadModels = useCallback(async (): Promise<void> => {
    setModelsLoading(true);
    try {
      const res = await fetchJson<ModelChoicesResponse>('/api/model');
      const options: TaskModelOption[] = [];
      for (const profile of res.profiles) {
        for (const model of profile.models) {
          if (model.kind !== 'chat') continue;
          options.push({
            profileId: profile.id,
            profileName: profile.name,
            modelId: model.id,
            label: `${profile.name} · ${model.id}`,
            available: !(profile.requiresKey ?? true) || profile.hasKey,
          });
        }
      }
      setModels(options);
      setModelsError(null);
    } catch (err) {
      setModels([]);
      setModelsError(errorMessage(err));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    // 首次进入只加载一次；切走再回来直接显示已有数据，不重新骨架屏。
    if (!loadedRef.current) {
      loadedRef.current = true;
      void load();
      void loadModels();
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isActive, load, loadModels]);

  const act = async (task: UserTaskView, action: TaskAction): Promise<void> => {
    if (busyId !== null) return;
    setBusyId(task.id);
    setActionError(null);
    try {
      await postJson<TaskMutationResponse>(
        `/api/tasks/${encodeURIComponent(task.id)}/action`,
        { action, ...(action === 'snooze' ? { minutes: SNOOZE_MINUTES } : {}) },
      );
      notify(ACTION_DONE[action], 'success');
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const runWork = async (task: UserTaskView): Promise<void> => {
    if (busyId !== null || runningId !== null) return;
    setRunningId(task.id);
    setActionError(null);
    try {
      const res = await postJson<TaskRunResponse>(
        `/api/tasks/${encodeURIComponent(task.id)}/action`,
        { action: 'run' },
      );
      const result = res.result;
      if (result !== undefined && result.outcome === 'succeeded') {
        notify(truncate(result.summary, 80) || '工作执行完成', 'success');
      } else {
        notify(`执行失败：${truncate(result?.error ?? result?.summary ?? '未知错误', 100)}`, 'danger');
      }
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setRunningId(null);
      await load();
    }
  };

  const removeTask = async (task: UserTaskView): Promise<void> => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await fetchJson<{ readonly ok: boolean }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: 'DELETE',
      });
      setDeleteTarget(null);
      notify('已删除', 'success');
      await load();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  function openCreate(kind: TaskKind): void {
    setEditing(null);
    setFormKind(kind);
    setFormOpen(true);
  }

  function openEdit(task: UserTaskView): void {
    setEditing(task);
    setFormKind(task.kind);
    setFormOpen(true);
  }

  const list = tasks ?? [];
  const active = list.filter((task) => task.status === 'active');
  const dueReminders = active
    .filter((task) => task.kind === 'reminder' && task.due)
    .sort(byNextRun);
  const reminders = active.filter((task) => task.kind === 'reminder').sort(byNextRun);
  const works = active.filter((task) => task.kind === 'work').sort(byNextRun);
  const archive = list
    .filter((task) => task.status !== 'active')
    .sort((a, b) => {
      const rank = (task: UserTaskView): number => (task.status === 'paused' ? 0 : 1);
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : byUpdated(a, b);
    });

  const rowBusy = (task: UserTaskView): boolean =>
    busyId === task.id || runningId === task.id;

  function renderReminder(task: UserTaskView): JSX.Element {
    const snooze = snoozeLabel(task, now);
    const busy = rowBusy(task);
    return (
      <li key={task.id} className={`task-card${task.due ? ' is-due' : ''}`}>
        <div className="task-card-main">
          <div className="task-card-head">
            <h3>{task.title}</h3>
            {task.due && <Badge tone="warn">到时间了</Badge>}
            {snooze !== null && <Badge tone="outline">稍后</Badge>}
          </div>
          {task.note.length > 0 && <p className="task-card-note">{task.note}</p>}
          <p className="task-card-meta">
            <span className="task-rule">{scheduleLabel(task.schedule)}</span>
            <span className="task-dot" aria-hidden="true">
              ·
            </span>
            <span className={task.due ? 'task-due-text' : undefined}>{nextRunLabel(task, now)}</span>
            {snooze !== null && (
              <>
                <span className="task-dot" aria-hidden="true">
                  ·
                </span>
                <span>{snooze}</span>
              </>
            )}
          </p>
        </div>
        <div className="task-card-actions">
          <button
            type="button"
            className="btn btn-primary btn-xs"
            disabled={busy}
            onClick={() => void act(task, 'complete')}
          >
            完成
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={busy}
            onClick={() => void act(task, 'snooze')}
          >
            稍后 {SNOOZE_MINUTES} 分钟
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={busy}
            onClick={() => openEdit(task)}
          >
            编辑
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-ghost-danger"
            disabled={busy}
            onClick={() => setDeleteTarget(task)}
          >
            删除
          </button>
        </div>
      </li>
    );
  }

  function renderWork(task: UserTaskView): JSX.Element {
    const running = runningId === task.id;
    const busy = rowBusy(task);
    const anyRunning = runningId !== null;
    const lastText = task.lastError ?? task.lastSummary;
    return (
      <li key={task.id} className={`task-card task-card--work${task.due ? ' is-due' : ''}`}>
        <div className="task-card-main">
          <div className="task-card-head">
            <h3>{task.title}</h3>
            {task.due && <Badge tone="warn">到点待执行</Badge>}
            {task.lastOutcome !== null && (
              <Badge tone={outcomeTone(task.lastOutcome)}>
                上次{OUTCOME_LABEL[task.lastOutcome]}
              </Badge>
            )}
          </div>
          <p className="task-card-meta">
            <span className="task-rule">{scheduleLabel(task.schedule)}</span>
            <span className="task-dot" aria-hidden="true">
              ·
            </span>
            <span>{nextRunLabel(task, now)}</span>
          </p>
          <div className="task-tags">
            <span className="task-tag" title={task.workspace ?? '程序默认工作区'}>
              工作区：{workspaceShortLabel(task.workspace)}
            </span>
            <span className="task-tag" title={PERMISSION_NOTE[task.permission]}>
              权限：{PERMISSION_LABEL[task.permission]}
            </span>
            {task.model !== null && (
              <span className="task-tag" title="定时执行使用的模型">
                模型：{task.model.label}
              </span>
            )}
            {task.files.length > 0 && (
              <span className="task-tag" title={task.files.join('\n')}>
                参考文件 {task.files.length}
              </span>
            )}
          </div>
          {task.note.length > 0 && <p className="task-card-note">{task.note}</p>}
          {lastText !== null && lastText.length > 0 && (
            <div className={`task-last${task.lastError !== null ? ' is-error' : ''}`}>
              {task.lastRunAt !== null && (
                <span className="task-last-time mono">{formatDateTime(task.lastRunAt)}</span>
              )}
              <span>{truncate(lastText, 220)}</span>
            </div>
          )}
          {running && (
            <p className="task-running" aria-live="polite">
              <span className="task-running-dot" aria-hidden="true" />
              执行中…可能需要几十秒到几分钟，期间请不要关闭应用。
            </p>
          )}
        </div>
        <div className="task-card-actions">
          <button
            type="button"
            className="btn btn-primary btn-xs"
            disabled={busy || anyRunning}
            title={anyRunning && !running ? '已有工作正在执行' : undefined}
            onClick={() => void runWork(task)}
          >
            {running ? '执行中…' : '立即运行'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={busy}
            onClick={() => void act(task, 'pause')}
          >
            暂停
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={busy}
            onClick={() => openEdit(task)}
          >
            编辑
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-ghost-danger"
            disabled={busy}
            onClick={() => setDeleteTarget(task)}
          >
            删除
          </button>
        </div>
      </li>
    );
  }

  function renderArchiveRow(task: UserTaskView): JSX.Element {
    const busy = rowBusy(task);
    return (
      <li key={task.id} className="task-archive-row">
        <span className="task-archive-kind">{KIND_LABEL[task.kind]}</span>
        <span className="task-archive-title">{task.title}</span>
        <span className={`task-archive-state${task.status === 'paused' ? ' is-paused' : ''}`}>
          {task.status === 'paused' ? '已暂停' : '已完成'}
        </span>
        <span className="task-archive-time mono">
          {task.status === 'completed' && task.completedAt !== null
            ? formatDateTime(task.completedAt)
            : scheduleLabel(task.schedule)}
        </span>
        <span className="task-archive-actions">
          {task.status === 'paused' && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={busy}
              onClick={() => void act(task, 'resume')}
            >
              恢复
            </button>
          )}
          {task.status === 'paused' && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={busy}
              onClick={() => openEdit(task)}
            >
              编辑
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-ghost-danger"
            disabled={busy}
            onClick={() => setDeleteTarget(task)}
          >
            删除
          </button>
        </span>
      </li>
    );
  }

  return (
    <div className="page tasks-page">
      <PageHeader
        title="定时任务"
        description="提醒到点显示；工作到点交给管家执行。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => openCreate('reminder')}>
              <Icon name="clock" size={15} />
              新建提醒
            </button>
            <button type="button" className="btn btn-primary" onClick={() => openCreate('work')}>
              <Icon name="plus" size={15} />
              新建工作
            </button>
          </>
        }
      />

      <p className="tasks-note">
        <Icon name="info" size={14} />
        <span>
          提醒在应用打开时显示，不做桌面弹窗；关闭应用后会在下次打开时显示逾期。
          工作由应用内的调度循环执行，应用没运行时不会执行。
        </span>
      </p>

      {actionError !== null && <InlineError message={actionError} />}

      {error !== null && tasks === null && <InlineError message={error} onRetry={() => void load()} />}

      {tasks === null && error === null && (
        <div className="panel tasks-loading">
          <Skeleton rows={5} height={16} />
        </div>
      )}

      {error !== null && tasks !== null && (
        <p className="tasks-sync-error">刷新失败：{error}（下面是上次读取到的数据）</p>
      )}

      {tasks !== null && (
        <>
          {dueReminders.length > 0 && (
            <section className="tasks-due" aria-label="到时间的提醒">
              <div className="tasks-due-head">
                <span className="tasks-due-icon">
                  <Icon name="alert" size={15} />
                </span>
                <strong>{dueReminders.length} 条提醒到时间了</strong>
                <span className="tasks-due-hint">应用打开时显示；关闭应用后会在下次打开时显示逾期。</span>
              </div>
              <ul>
                {dueReminders.map((task) => (
                  <li key={task.id}>
                    <div className="tasks-due-main">
                      <strong>{task.title}</strong>
                      <span>
                        {scheduleLabel(task.schedule)}
                        {task.nextRunAt !== null && ` · 原定 ${formatDateTime(task.nextRunAt)}`}
                      </span>
                    </div>
                    <div className="tasks-due-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-xs"
                        disabled={rowBusy(task)}
                        onClick={() => void act(task, 'complete')}
                      >
                        完成
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        disabled={rowBusy(task)}
                        onClick={() => void act(task, 'snooze')}
                      >
                        稍后 {SNOOZE_MINUTES} 分钟
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="tasks-section" aria-label="提醒">
            <SectionHeading
              title="提醒"
              description="到点只在应用内显示，不执行任何操作。"
              actions={<Badge tone="outline">{reminders.length} 个待办</Badge>}
            />
            {reminders.length === 0 ? (
              <EmptyState
                icon="clock"
                title="还没有提醒"
                description="新建一个「明天提醒我带身份证」这样的任务。"
                compact
              />
            ) : (
              <ul className="task-list">{reminders.map(renderReminder)}</ul>
            )}
          </section>

          <section className="tasks-section" aria-label="工作">
            <SectionHeading
              title="工作"
              description="到点交给管家执行；应用没运行时不会执行，下次打开后补跑。"
              actions={<Badge tone="outline">{works.length} 个待办</Badge>}
            />
            {works.length === 0 ? (
              <EmptyState
                icon="sparkle"
                title="还没有工作"
                description="新建一个「每周五汇总本周对话，生成周报」这样的任务。"
                compact
              />
            ) : (
              <ul className="task-list">{works.map(renderWork)}</ul>
            )}
          </section>

          <section className="tasks-section tasks-archive-section" aria-label="已完成与暂停">
            <button
              type="button"
              className="tasks-archive-toggle"
              aria-expanded={showArchive}
              onClick={() => setShowArchive((prev) => !prev)}
            >
              <Icon name={showArchive ? 'chevronDown' : 'chevronRight'} size={14} />
              <span>已完成 / 暂停</span>
              <span className="tasks-archive-count">{archive.length}</span>
            </button>
            {showArchive &&
              (archive.length === 0 ? (
                <p className="tasks-archive-empty">没有已完成或暂停的任务。</p>
              ) : (
                <ul className="task-archive">{archive.map(renderArchiveRow)}</ul>
              ))}
          </section>
        </>
      )}

      {formOpen && (
        <TaskForm
          key={editing?.id ?? `new-${formKind}`}
          editing={editing}
          initialKind={formKind}
          models={models}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          onRetryModels={() => void loadModels()}
          onClose={() => setFormOpen(false)}
          onSaved={(text) => {
            setFormOpen(false);
            setEditing(null);
            notify(text, 'success');
            void load();
          }}
        />
      )}

      <Modal
        open={deleteTarget !== null}
        onClose={() => {
          if (deleting) return;
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        title="删除这个任务？"
        description="删除后不能恢复；已经发生的运行记录仍会留在事件流里。"
        footer={
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={deleting}
              onClick={() => {
                setDeleteTarget(null);
                setDeleteError(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleting || deleteTarget === null}
              onClick={() => {
                if (deleteTarget !== null) void removeTask(deleteTarget);
              }}
            >
              {deleting ? '删除中…' : '删除'}
            </button>
          </div>
        }
      >
        {deleteTarget !== null && (
          <div className="task-delete">
            <p className="task-delete-title">{deleteTarget.title}</p>
            <p className="task-delete-meta">
              {KIND_LABEL[deleteTarget.kind]} · {scheduleLabel(deleteTarget.schedule)}
            </p>
            {deleteError !== null && (
              <p className="task-error" role="alert">
                {deleteError}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
