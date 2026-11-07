'use client';

/**
 * 新建 / 编辑定时任务
 *
 * ★ 一个弹窗，按「提醒 / 工作」切换，不做简单/高级两套。
 *   提醒只有标题、备注、时间；工作额外要求「让管家做什么」、工作区、
 *   权限、模型与参考文件。
 *
 * ★ 权限只给三档（只读 / 工作区 / 完全），并把每一档的后果直接写出来 ——
 *   无人值守的任务不会弹确认，用户必须在这里知道自己选了什么。
 */

import { useState } from 'react';

import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import type {
  TaskKind,
  TaskModelChoice,
  TaskMutationResponse,
  TaskPermission,
  UserTaskView,
} from '../lib/types.js';
import {
  PERMISSION_LABEL,
  PERMISSION_NOTE,
  defaultOnceDue,
  effectivePermission,
  fromDateTimeLocal,
  isWeekday,
  isValidTimeOfDay,
  splitFileLines,
  toDateTimeLocal,
  weekdayOptions,
} from './taskFormat.js';

export interface TaskModelOption {
  readonly profileId: string;
  readonly profileName: string;
  readonly modelId: string;
  readonly label: string;
  readonly available: boolean;
}

interface TaskFormProps {
  readonly editing: UserTaskView | null;
  readonly initialKind: TaskKind;
  readonly models: readonly TaskModelOption[];
  readonly modelsLoading: boolean;
  readonly modelsError: string | null;
  readonly onRetryModels: () => void;
  readonly onClose: () => void;
  readonly onSaved: (text: string) => void;
}

type Repeat = 'once' | 'daily' | 'weekly';

interface FormState {
  readonly kind: TaskKind;
  readonly title: string;
  readonly note: string;
  readonly repeat: Repeat;
  /** datetime-local 的值 */
  readonly dueAt: string;
  /** HH:mm */
  readonly timeOfDay: string;
  /** 0=周日 */
  readonly weekday: number;
  readonly instruction: string;
  readonly workspace: string;
  readonly permission: '' | TaskPermission;
  /** `${profileId}::${modelId}`；空 = 跟随当前对话模型 */
  readonly modelKey: string;
  readonly filesText: string;
}

type FieldErrors = Partial<Record<'title' | 'time' | 'weekday' | 'instruction', string>>;

function initialState(editing: UserTaskView | null, fallbackKind: TaskKind): FormState {
  if (editing === null) {
    return {
      kind: fallbackKind,
      title: '',
      note: '',
      repeat: 'once',
      dueAt: toDateTimeLocal(defaultOnceDue()),
      timeOfDay: '09:00',
      weekday: 5,
      instruction: '',
      workspace: '',
      permission: '',
      modelKey: '',
      filesText: '',
    };
  }
  return {
    kind: editing.kind,
    title: editing.title,
    note: editing.note,
    repeat: editing.schedule.repeat,
    dueAt:
      editing.schedule.dueAt !== null
        ? toDateTimeLocal(editing.schedule.dueAt)
        : toDateTimeLocal(defaultOnceDue()),
    timeOfDay: editing.schedule.timeOfDay ?? '09:00',
    weekday: editing.schedule.weekday ?? 5,
    instruction: editing.instruction ?? '',
    workspace: editing.workspace ?? '',
    permission: editing.kind === 'work' ? editing.permission : '',
    modelKey:
      editing.model !== null ? `${editing.model.profileId}::${editing.model.modelId}` : '',
    filesText: editing.files.join('\n'),
  };
}

function validate(form: FormState, now: number): FieldErrors {
  const errors: FieldErrors = {};
  if (form.title.trim().length === 0) errors.title = '标题不能为空';
  if (form.repeat === 'once') {
    const ts = fromDateTimeLocal(form.dueAt);
    if (ts === null) errors.time = '请选择日期和时间';
    else if (ts <= now) errors.time = '执行时间必须晚于当前时间';
  } else {
    if (!isValidTimeOfDay(form.timeOfDay)) errors.time = '时间格式应为 HH:mm';
    if (form.repeat === 'weekly' && !isWeekday(form.weekday)) errors.weekday = '请选择星期几';
  }
  if (form.kind === 'work' && form.instruction.trim().length === 0) {
    errors.instruction = '工作内容不能为空';
  }
  return errors;
}

function parseModelKey(
  key: string,
  models: readonly TaskModelOption[],
  previous: TaskModelChoice | null,
): TaskModelChoice | null {
  if (key.length === 0) return null;
  const index = key.indexOf('::');
  if (index < 0) return null;
  const profileId = key.slice(0, index);
  const modelId = key.slice(index + 2);
  if (profileId.length === 0 || modelId.length === 0) return null;
  const found = models.find((m) => m.profileId === profileId && m.modelId === modelId);
  const kept =
    previous !== null && previous.profileId === profileId && previous.modelId === modelId
      ? previous.label
      : modelId;
  return { profileId, modelId, label: found?.label ?? kept };
}

export function TaskForm({
  editing,
  initialKind,
  models,
  modelsLoading,
  modelsError,
  onRetryModels,
  onClose,
  onSaved,
}: TaskFormProps): JSX.Element {
  const [form, setForm] = useState<FormState>(() => initialState(editing, initialKind));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const patch = (next: Partial<FormState>): void => {
    setForm((prev) => ({ ...prev, ...next }));
  };

  const permission = effectivePermission(form.permission, form.workspace);
  const storedModel = editing?.model ?? null;
  const storedModelMissing =
    storedModel !== null &&
    !models.some(
      (m) => m.profileId === storedModel.profileId && m.modelId === storedModel.modelId,
    );

  async function submit(): Promise<void> {
    if (submitting) return;
    const next = validate(form, Date.now());
    setErrors(next);
    setServerError(null);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    try {
      const schedule =
        form.repeat === 'once'
          ? { repeat: 'once' as const, dueAt: fromDateTimeLocal(form.dueAt) ?? 0 }
          : form.repeat === 'daily'
            ? { repeat: 'daily' as const, timeOfDay: form.timeOfDay }
            : {
                repeat: 'weekly' as const,
                timeOfDay: form.timeOfDay,
                weekday: form.weekday,
              };

      const body: Record<string, unknown> = {
        title: form.title.trim(),
        note: form.note.trim(),
        schedule,
      };

      if (form.kind === 'work') {
        body['instruction'] = form.instruction.trim();
        body['workspace'] = form.workspace.trim();
        body['permission'] = permission;
        body['model'] = parseModelKey(form.modelKey, models, editing?.model ?? null);
        body['files'] = splitFileLines(form.filesText);
      }

      if (editing === null) {
        await postJson<TaskMutationResponse>('/api/tasks', { kind: form.kind, ...body });
        onSaved(form.kind === 'work' ? '工作已创建' : '提醒已创建');
      } else {
        await fetchJson<TaskMutationResponse>(`/api/tasks/${encodeURIComponent(editing.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        onSaved('任务已更新');
      }
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    editing === null
      ? form.kind === 'work'
        ? '新建工作'
        : '新建提醒'
      : form.kind === 'work'
        ? '编辑工作'
        : '编辑提醒';

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={
        form.kind === 'work'
          ? '到点由管家执行；应用没运行时不会执行，下次打开后补跑。'
          : '到点只在应用内显示；关闭应用后，下次打开时显示为逾期。'
      }
      variant="wide"
      closeOnBackdrop={!submitting}
      footer={
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="submit"
            form="task-form"
            className="btn btn-primary"
            disabled={submitting}
          >
            {submitting ? '保存中…' : editing === null ? '创建' : '保存'}
          </button>
        </div>
      }
    >
      <form
        id="task-form"
        className="task-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {editing === null && (
          <div className="task-type">
            <div className="task-type-switch" role="group" aria-label="任务类型">
              <button
                type="button"
                className={form.kind === 'reminder' ? 'is-on' : ''}
                aria-pressed={form.kind === 'reminder'}
                onClick={() => patch({ kind: 'reminder' })}
              >
                提醒
              </button>
              <button
                type="button"
                className={form.kind === 'work' ? 'is-on' : ''}
                aria-pressed={form.kind === 'work'}
                onClick={() => patch({ kind: 'work' })}
              >
                工作
              </button>
            </div>
            <p className="task-type-note">
              {form.kind === 'reminder'
                ? '提醒只是到点告诉你，管家不会执行任何操作。'
                : '工作会交给管家执行，可能改文件、开应用或跑命令。'}
            </p>
          </div>
        )}

        {serverError !== null && (
          <div className="task-form-error" role="alert">
            <Icon name="alert" size={15} />
            <span>{serverError}</span>
          </div>
        )}

        <label className="task-field">
          <span className="task-field-label">
            标题<em>必填</em>
          </span>
          <input
            className="task-input"
            value={form.title}
            maxLength={200}
            placeholder={form.kind === 'work' ? '每周五汇总本周对话' : '明天提醒我带身份证'}
            onChange={(event) => patch({ title: event.target.value })}
          />
          {errors.title !== undefined && <small className="task-error">{errors.title}</small>}
        </label>

        <label className="task-field">
          <span className="task-field-label">备注（可选）</span>
          <textarea
            className="task-textarea"
            rows={2}
            maxLength={4000}
            value={form.note}
            placeholder="给自己留一句上下文，例如：身份证在抽屉第二层。"
            onChange={(event) => patch({ note: event.target.value })}
          />
        </label>

        <div className="task-field">
          <span className="task-field-label">执行时间</span>
          <div className="task-repeat" role="group" aria-label="重复方式">
            {(
              [
                { id: 'once', label: '一次' },
                { id: 'daily', label: '每天' },
                { id: 'weekly', label: '每周' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                className={form.repeat === item.id ? 'is-on' : ''}
                aria-pressed={form.repeat === item.id}
                onClick={() => patch({ repeat: item.id })}
              >
                {item.label}
              </button>
            ))}
          </div>

          {form.repeat === 'once' ? (
            <input
              type="datetime-local"
              className="task-input task-input--time"
              value={form.dueAt}
              onChange={(event) => patch({ dueAt: event.target.value })}
            />
          ) : (
            <div className="task-time-row">
              {form.repeat === 'weekly' && (
                <select
                  className="task-select task-select--weekday"
                  aria-label="星期几"
                  value={form.weekday}
                  onChange={(event) => patch({ weekday: Number(event.target.value) })}
                >
                  {weekdayOptions().map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
              <input
                type="time"
                className="task-input task-input--time"
                aria-label="时间"
                value={form.timeOfDay}
                onChange={(event) => patch({ timeOfDay: event.target.value })}
              />
              <span className="task-field-hint">本地时间</span>
            </div>
          )}
          {errors.time !== undefined && <small className="task-error">{errors.time}</small>}
          {errors.weekday !== undefined && <small className="task-error">{errors.weekday}</small>}
        </div>

        {form.kind === 'work' && (
          <>
            <label className="task-field">
              <span className="task-field-label">
                让管家做什么<em>必填</em>
              </span>
              <textarea
                className="task-textarea"
                rows={4}
                maxLength={20000}
                value={form.instruction}
                placeholder="例如：读取本周的对话记录，汇总成一份周报，写到工作区下的 weekly.md。"
                onChange={(event) => patch({ instruction: event.target.value })}
              />
              {errors.instruction !== undefined && (
                <small className="task-error">{errors.instruction}</small>
              )}
            </label>

            <div className="task-grid">
              <label className="task-field">
                <span className="task-field-label">工作区（可留空）</span>
                <input
                  className="task-input"
                  value={form.workspace}
                  placeholder="留空使用程序默认工作区"
                  onChange={(event) => patch({ workspace: event.target.value })}
                />
                <small className="task-field-hint">
                  留空 = 程序默认工作区；填写时必须是已存在的目录完整路径。
                </small>
              </label>

              <label className="task-field">
                <span className="task-field-label">权限</span>
                <select
                  className="task-select"
                  value={form.permission}
                  onChange={(event) =>
                    patch({ permission: event.target.value as '' | TaskPermission })
                  }
                >
                  <option value="">默认（按工作区决定）</option>
                  <option value="read-only">只读</option>
                  <option value="workspace">工作区</option>
                  <option value="full">完全</option>
                </select>
                <small className="task-field-hint">
                  当前生效：{PERMISSION_LABEL[permission]}
                </small>
              </label>
            </div>

            <div className="task-perm">
              {(['read-only', 'workspace', 'full'] as const).map((tier) => (
                <p key={tier} className={permission === tier ? 'is-current' : undefined}>
                  <strong>{PERMISSION_LABEL[tier]}</strong>
                  {PERMISSION_NOTE[tier]}
                </p>
              ))}
              <p className="task-perm-foot">
                无人值守执行时不会弹确认；选「完全」等于把整台电脑交给这次任务。
              </p>
            </div>

            <div className="task-field">
              <label className="task-field-label" htmlFor="task-model">
                使用模型（可留空）
              </label>
              <select
                id="task-model"
                className="task-select"
                value={form.modelKey}
                disabled={modelsLoading}
                onChange={(event) => patch({ modelKey: event.target.value })}
              >
                <option value="">跟随当前对话模型</option>
                {models.map((option) => (
                  <option key={`${option.profileId}::${option.modelId}`} value={`${option.profileId}::${option.modelId}`}>
                    {option.label}
                    {option.available ? '' : '（缺少 Key）'}
                  </option>
                ))}
                {storedModelMissing && storedModel !== null && (
                  <option value={`${storedModel.profileId}::${storedModel.modelId}`}>
                    {storedModel.label}（当前配置里已找不到）
                  </option>
                )}
              </select>
              <small className="task-field-hint">
                {modelsLoading
                  ? '正在读取可用模型…'
                  : modelsError !== null
                    ? `模型列表读取失败：${modelsError}`
                    : models.length === 0
                      ? '还没有可用的对话模型；留空时会跟随当前对话模型。'
                      : '留空 = 跟随当前对话模型。'}
              </small>
              {modelsError !== null && !modelsLoading && (
                <button type="button" className="text-btn task-retry" onClick={onRetryModels}>
                  重新读取模型列表
                </button>
              )}
            </div>

            <label className="task-field">
              <span className="task-field-label">参考文件（可选）</span>
              <textarea
                className="task-textarea"
                rows={2}
                value={form.filesText}
                placeholder={'每行一个路径，例如：\nE:\\资料\\模板.docx'}
                onChange={(event) => patch({ filesText: event.target.value })}
              />
              <small className="task-field-hint">
                已填写 {splitFileLines(form.filesText).length} 个路径（最多 20 个）。
                参考文件只作为执行提示，不会越过上面的权限档位。
              </small>
            </label>
          </>
        )}
      </form>
    </Modal>
  );
}
