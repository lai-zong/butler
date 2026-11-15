'use client';

/**
 * 专注空间右侧的日程抽屉。
 *
 * ★ 只有一张按时间排列的清单：不画月历、不做拖拽排期、不做重复规则。
 *   它只回答「接下来有什么事」，以及让用户把其中一件设为当前安排。
 * ★ 所有读写都走 `/api/focus/schedules`，与「定时任务」没有任何共享状态。
 * ★ 从列表点一条 = 设为当前安排并收起抽屉；编辑入口在行尾，不会误触。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { Switch } from '../components/Switch';
import { errorMessage } from '../lib/api.js';
import { useNow } from '../lib/hooks.js';
import type { FocusScheduleDto, ToastMessage } from '../lib/types.js';
import {
  clockLabel,
  defaultScheduleRange,
  fromDateTimeLocal,
  phaseLabel,
  scheduleDayLabel,
  schedulePhase,
  toDateTimeLocal,
  type FocusPhase,
} from './focusFormat.js';
import type { FocusScheduleDraft } from './useFocusSchedules.js';

type Notify = (text: string, tone?: ToastMessage['tone']) => void;

interface FocusScheduleDrawerProps {
  readonly schedules: readonly FocusScheduleDto[];
  readonly currentId: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onReload: () => Promise<void>;
  readonly onClose: () => void;
  readonly onCreate: (draft: FocusScheduleDraft) => Promise<void>;
  readonly onUpdate: (id: string, draft: FocusScheduleDraft) => Promise<void>;
  readonly onRemove: (id: string) => Promise<void>;
  readonly onSetCurrent: (id: string) => Promise<void>;
  readonly notify: Notify;
}

interface FormState {
  readonly title: string;
  readonly note: string;
  readonly start: string;
  readonly end: string;
  readonly remind: boolean;
}

type FieldErrors = Partial<Record<'title' | 'start' | 'end', string>>;

function dateKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function formForNew(now: number): FormState {
  const range = defaultScheduleRange(now);
  return {
    title: '',
    note: '',
    start: toDateTimeLocal(range.startAt),
    end: toDateTimeLocal(range.endAt),
    remind: false,
  };
}

function formFor(schedule: FocusScheduleDto): FormState {
  return {
    title: schedule.title,
    note: schedule.note,
    start: toDateTimeLocal(schedule.startAt),
    end: toDateTimeLocal(schedule.endAt),
    remind: schedule.remind,
  };
}

function validate(form: FormState): { readonly errors: FieldErrors; readonly startAt: number | null; readonly endAt: number | null } {
  const errors: FieldErrors = {};
  if (form.title.trim().length === 0) errors.title = '给这件事一个标题';
  const startAt = fromDateTimeLocal(form.start);
  const endAt = fromDateTimeLocal(form.end);
  if (startAt === null) errors.start = '请选择开始时间';
  if (endAt === null) errors.end = '请选择结束时间';
  if (startAt !== null && endAt !== null && endAt <= startAt) {
    errors.end = '结束需要晚于开始';
  }
  return { errors, startAt, endAt };
}

export function FocusScheduleDrawer({
  schedules,
  currentId,
  loading,
  error,
  onReload,
  onClose,
  onCreate,
  onUpdate,
  onRemove,
  onSetCurrent,
  notify,
}: FocusScheduleDrawerProps): JSX.Element {
  const now = useNow(15_000);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [mode, setMode] = useState<'list' | 'editor'>('list');
  const [editing, setEditing] = useState<FocusScheduleDto | null>(null);
  const [form, setForm] = useState<FormState>(() => formForNew(Date.now()));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pastOpen, setPastOpen] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const active = useMemo(
    () => schedules.filter((schedule) => schedulePhase(schedule, now) === 'active'),
    [now, schedules],
  );
  const future = useMemo(
    () => schedules.filter((schedule) => schedule.startAt > now),
    [now, schedules],
  );
  const past = useMemo(
    () =>
      schedules
        .filter((schedule) => schedule.endAt <= now)
        .sort((a, b) => b.startAt - a.startAt),
    [now, schedules],
  );

  const futureGroups = useMemo(() => {
    const groups: { readonly key: string; readonly label: string; readonly items: FocusScheduleDto[] }[] = [];
    for (const schedule of future) {
      const key = dateKey(schedule.startAt);
      const last = groups[groups.length - 1];
      if (last !== undefined && last.key === key) {
        last.items.push(schedule);
      } else {
        groups.push({
          key,
          label: scheduleDayLabel(schedule.startAt, now),
          items: [schedule],
        });
      }
    }
    return groups;
  }, [future, now]);

  function openCreate(): void {
    setEditing(null);
    setForm(formForNew(Date.now()));
    setErrors({});
    setServerError(null);
    setConfirmDelete(false);
    setMode('editor');
  }

  function openEdit(schedule: FocusScheduleDto): void {
    setEditing(schedule);
    setForm(formFor(schedule));
    setErrors({});
    setServerError(null);
    setConfirmDelete(false);
    setMode('editor');
  }

  async function save(): Promise<void> {
    if (saving || deleting) return;
    const checked = validate(form);
    setErrors(checked.errors);
    setServerError(null);
    if (Object.keys(checked.errors).length > 0) return;
    if (checked.startAt === null || checked.endAt === null) return;
    const draft: FocusScheduleDraft = {
      title: form.title.trim(),
      note: form.note.trim(),
      startAt: checked.startAt,
      endAt: checked.endAt,
      remind: form.remind,
    };
    setSaving(true);
    try {
      if (editing === null) {
        await onCreate(draft);
        notify('日程已创建', 'success');
      } else {
        await onUpdate(editing.id, draft);
        notify('日程已保存', 'success');
      }
      setMode('list');
      setEditing(null);
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (editing === null || deleting) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    setServerError(null);
    try {
      await onRemove(editing.id);
      notify('日程已删除', 'success');
      setMode('list');
      setEditing(null);
      setConfirmDelete(false);
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  async function select(schedule: FocusScheduleDto): Promise<void> {
    if (selectingId !== null) return;
    setSelectingId(schedule.id);
    setActionError(null);
    try {
      await onSetCurrent(schedule.id);
      onClose();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSelectingId(null);
    }
  }

  return (
    <aside
      className="focus-drawer focus-drawer--schedule"
      role="dialog"
      aria-modal="false"
      aria-label="日程"
    >
      <header className="focus-drawer-head">
        <div>
          <p className="focus-drawer-kicker">
            {mode === 'list' ? '日程' : editing === null ? '新的日程' : '编辑日程'}
          </p>
          <h2>
            {mode === 'list' ? '接下来' : editing === null ? '留出一段时间' : '调整这件事'}
          </h2>
        </div>
        <div className="focus-drawer-head-actions">
          {mode === 'list' ? (
            <button type="button" className="focus-text-btn" onClick={openCreate}>
              <Icon name="plus" size={14} /> 新建
            </button>
          ) : (
            <button
              type="button"
              className="focus-text-btn is-muted"
              onClick={() => {
                setMode('list');
                setEditing(null);
                setConfirmDelete(false);
              }}
            >
              返回日程
            </button>
          )}
          <button
            ref={closeRef}
            type="button"
            className="focus-icon-btn"
            onClick={onClose}
            aria-label="收起日程"
            title="收起"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>

      <div className="focus-drawer-body">
        {mode === 'list' ? (
          <>
            {actionError !== null && (
              <p className="focus-inline-error" role="alert">{actionError}</p>
            )}
            {error !== null && (
              <div className="focus-inline-error is-row" role="alert">
                <span>{error}</span>
                <button type="button" className="focus-text-btn" onClick={() => void onReload()}>
                  重试
                </button>
              </div>
            )}

            {loading && schedules.length === 0 && (
              <p className="focus-empty-note">正在读取日程…</p>
            )}

            {!loading && schedules.length === 0 && error === null && (
              <div className="focus-schedule-empty">
                <p>还没有日程。</p>
                <button type="button" className="focus-text-btn" onClick={openCreate}>
                  写下第一件事
                </button>
              </div>
            )}

            {active.length > 0 && (
              <section className="focus-schedule-group" aria-label="正在进行的日程">
                <p className="focus-schedule-day">现在</p>
                {active.map((schedule) => (
                  <ScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    now={now}
                    phase="active"
                    current={schedule.id === currentId}
                    selecting={selectingId === schedule.id}
                    onSelect={() => void select(schedule)}
                    onEdit={() => openEdit(schedule)}
                  />
                ))}
              </section>
            )}

            {futureGroups.map((group) => (
              <section className="focus-schedule-group" key={group.key} aria-label={group.label}>
                <p className="focus-schedule-day">{group.label}</p>
                {group.items.map((schedule) => (
                  <ScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    now={now}
                    phase="upcoming"
                    current={schedule.id === currentId}
                    selecting={selectingId === schedule.id}
                    onSelect={() => void select(schedule)}
                    onEdit={() => openEdit(schedule)}
                  />
                ))}
              </section>
            ))}

            {past.length > 0 && (
              <section className="focus-schedule-group focus-schedule-group--past" aria-label="过去的日程">
                <button
                  type="button"
                  className="focus-schedule-past-toggle"
                  aria-expanded={pastOpen}
                  onClick={() => setPastOpen((open) => !open)}
                >
                  <span>过去 {past.length} 条</span>
                  <Icon name={pastOpen ? 'chevronUp' : 'chevronDown'} size={13} />
                </button>
                {pastOpen &&
                  past.map((schedule) => (
                    <ScheduleRow
                      key={schedule.id}
                      schedule={schedule}
                      now={now}
                      phase="ended"
                      current={schedule.id === currentId}
                      selecting={selectingId === schedule.id}
                      onSelect={() => void select(schedule)}
                      onEdit={() => openEdit(schedule)}
                    />
                  ))}
              </section>
            )}
          </>
        ) : (
          <form
            className="focus-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="focus-field">
              <span className="focus-field-label">标题</span>
              <input
                type="text"
                value={form.title}
                autoFocus
                maxLength={120}
                placeholder="这段时间想做什么"
                onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
              />
              {errors.title !== undefined && <small className="focus-field-error">{errors.title}</small>}
            </label>

            <label className="focus-field">
              <span className="focus-field-label">备注</span>
              <textarea
                value={form.note}
                rows={3}
                maxLength={2000}
                placeholder="可留空。只给自己看的上下文。"
                onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
              />
            </label>

            <div className="focus-field-grid">
              <label className="focus-field">
                <span className="focus-field-label">开始</span>
                <input
                  type="datetime-local"
                  value={form.start}
                  onChange={(event) => setForm((prev) => ({ ...prev, start: event.target.value }))}
                />
                {errors.start !== undefined && <small className="focus-field-error">{errors.start}</small>}
              </label>
              <label className="focus-field">
                <span className="focus-field-label">结束</span>
                <input
                  type="datetime-local"
                  value={form.end}
                  onChange={(event) => setForm((prev) => ({ ...prev, end: event.target.value }))}
                />
                {errors.end !== undefined && <small className="focus-field-error">{errors.end}</small>}
              </label>
            </div>

            <div className="focus-switch-row">
              <div>
                <strong>到点提醒</strong>
                <small>只在专注空间打开时出现；关闭后不提醒。</small>
              </div>
              <Switch
                checked={form.remind}
                onChange={(remind) => setForm((prev) => ({ ...prev, remind }))}
                label="到点提醒"
              />
            </div>

            {serverError !== null && (
              <p className="focus-inline-error" role="alert">{serverError}</p>
            )}

            <div className="focus-form-actions">
              <button type="submit" className="focus-primary-btn" disabled={saving || deleting}>
                {saving ? '保存中…' : '保存'}
              </button>
              <button
                type="button"
                className="focus-text-btn is-muted"
                onClick={() => {
                  setMode('list');
                  setEditing(null);
                }}
                disabled={saving || deleting}
              >
                取消
              </button>
            </div>

            {editing !== null && (
              <div className="focus-danger-zone">
                {confirmDelete ? (
                  <>
                    <span>删除后不可恢复</span>
                    <button type="button" className="focus-danger-btn" onClick={() => void remove()} disabled={deleting}>
                      {deleting ? '删除中…' : '确认删除'}
                    </button>
                    <button
                      type="button"
                      className="focus-text-btn is-muted"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                    >
                      先不删
                    </button>
                  </>
                ) : (
                  <button type="button" className="focus-danger-link" onClick={() => setConfirmDelete(true)}>
                    <Icon name="trash" size={14} /> 删除日程
                  </button>
                )}
              </div>
            )}
          </form>
        )}
      </div>
    </aside>
  );
}

function ScheduleRow({
  schedule,
  now,
  phase,
  current,
  selecting,
  onSelect,
  onEdit,
}: {
  readonly schedule: FocusScheduleDto;
  readonly now: number;
  readonly phase: FocusPhase;
  readonly current: boolean;
  readonly selecting: boolean;
  readonly onSelect: () => void;
  readonly onEdit: () => void;
}): JSX.Element {
  const day = scheduleDayLabel(schedule.startAt, now);
  const showDay = phase === 'active' || phase === 'ended' || day !== '今天';
  return (
    <div className={`focus-schedule-row${current ? ' is-current' : ''}${phase === 'ended' ? ' is-past' : ''}`}>
      <button
        type="button"
        className="focus-schedule-main"
        aria-current={current ? 'true' : undefined}
        onClick={onSelect}
        disabled={selecting}
        title={current ? '当前安排' : '设为当前安排'}
      >
        <span className="focus-schedule-time">
          <strong>{clockLabel(schedule.startAt)}</strong>
          <small>{clockLabel(schedule.endAt)}</small>
        </span>
        <span className="focus-schedule-copy">
          <span className="focus-schedule-title">
            {schedule.title}
            {schedule.remind && <Icon name="bell" size={12} className="focus-schedule-bell" />}
          </span>
          {schedule.note.length > 0 && <span className="focus-schedule-note">{schedule.note}</span>}
          <span className="focus-schedule-meta">
            {showDay && <span>{day} · </span>}
            {phaseLabel(phase)}
            {current && <b> · 当前安排</b>}
            {selecting && <span> · 正在设为当前…</span>}
          </span>
        </span>
        {current && <span className="focus-schedule-check" aria-hidden="true"><Icon name="check" size={13} /></span>}
      </button>
      <button
        type="button"
        className="focus-schedule-edit"
        onClick={onEdit}
        aria-label={`编辑 ${schedule.title}`}
        title="编辑"
      >
        <Icon name="pencil" size={14} />
      </button>
    </div>
  );
}
