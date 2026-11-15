'use client';

/**
 * 对话设置弹窗
 *
 * ★ 范围：
 *   ① 这段对话的 AI 人格（只写本会话，≤8000 字）
 *   ② 这段对话的工具工作区（该对话的根目录；留空 = 跟随应用默认）
 *   ③ 这段对话的工具权限（跟随应用 / 只读 / 工作区 / 完全）
 *   ④ 这段对话是否使用记忆
 *
 * ★ 工作区/权限是**真实后端作用域**：保存后由下一轮的工具作用域使用，
 *   不是展示性的假控件。服务端会校验路径（绝对、存在、目录、realpath、
 *   非受保护目录），失败时把原因显示在这里。
 *
 * ★ 人格正文只在弹窗的局部状态里：
 *   打开时 GET 详情拿全文（列表只有 80 字预览），保存后立即丢弃，
 *   不写回列表缓存，也不进 console。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { InlineError, Skeleton } from '../components/Common';
import { Modal } from '../components/Modal';
import { Switch } from '../components/Switch';
import { errorMessage, fetchJson, patchJson } from '../lib/api.js';
import type {
  SessionDetailResponse,
  SessionMemoryMode,
  SessionPermission,
  SessionSettingsPatch,
  SessionSettingsPatchResponse,
  SessionSummary,
  ToastMessage,
} from '../lib/types.js';
import {
  SESSION_PERMISSION_LABEL,
  SESSION_PERMISSION_NOTE,
  isSessionPermission,
  scopeOf,
  scopePatchOf,
  type SessionScopeView,
} from './sessionSettings.js';

const PERSONA_MAX = 8_000;
const DANGER_PERMISSION_NOTE =
  '危险档位（dangerous / remove_path）始终禁用，不会因为选「完全」而放开；Web 会话没有 OS 沙箱，因此不提供命令执行工具。';
const PERMISSION_TIP = [
  `只读：${SESSION_PERMISSION_NOTE['read-only']}`,
  `工作区：${SESSION_PERMISSION_NOTE.workspace}`,
  `完全：${SESSION_PERMISSION_NOTE.full}`,
  DANGER_PERMISSION_NOTE,
].join('\n');

interface SessionSettingsSheetProps {
  readonly open: boolean;
  readonly session: SessionSummary | null;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onClose: () => void;
  readonly onSaved: (session: SessionSummary) => void;
}

interface Baseline {
  readonly persona: string;
  readonly memoryMode: SessionMemoryMode;
  readonly workspace: string | null;
  readonly permission: SessionPermission | null;
}

export function SessionSettingsSheet({
  open,
  session,
  notify,
  onClose,
  onSaved,
}: SessionSettingsSheetProps): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [persona, setPersona] = useState('');
  const [memoryMode, setMemoryMode] = useState<SessionMemoryMode>('on');
  const [workspace, setWorkspace] = useState('');
  const [permission, setPermission] = useState<'' | SessionPermission>('');
  const [scope, setScope] = useState<SessionScopeView | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const tokenRef = useRef(0);

  const sessionId = session?.id ?? null;

  const load = useCallback(async (id: string): Promise<void> => {
    const token = ++tokenRef.current;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    try {
      const res = await fetchJson<SessionDetailResponse>(
        `/api/sessions/${encodeURIComponent(id)}`,
      );
      if (token !== tokenRef.current) return;
      const settings = res.session.settings;
      const nextPersona = typeof settings.persona === 'string' ? settings.persona : '';
      const nextMemory: SessionMemoryMode =
        settings.memoryMode === 'off' ? 'off' : 'on';
      const nextScope = scopeOf(res.session);
      setPersona(nextPersona);
      setMemoryMode(nextMemory);
      setWorkspace(nextScope.workspace ?? '');
      setPermission(nextScope.permission ?? '');
      setScope(nextScope);
      setBaseline({
        persona: nextPersona,
        memoryMode: nextMemory,
        workspace: nextScope.workspace,
        permission: nextScope.permission,
      });
    } catch (err) {
      if (token !== tokenRef.current) return;
      setLoadError(errorMessage(err));
    } finally {
      if (token === tokenRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || sessionId === null) {
      // 关闭后让下一次打开从干净状态开始；正文立即离开 React 状态。
      tokenRef.current += 1;
      setPersona('');
      setWorkspace('');
      setPermission('');
      setScope(null);
      setBaseline(null);
      setLoadError(null);
      setSaveError(null);
      setLoading(false);
      return;
    }
    void load(sessionId);
  }, [load, open, sessionId]);

  const formScope = scopePatchOf({ workspace, permission });
  const dirty =
    baseline !== null &&
    (persona !== baseline.persona ||
      memoryMode !== baseline.memoryMode ||
      formScope.workspace !== baseline.workspace ||
      formScope.permission !== baseline.permission);

  const submit = useCallback(
    async (overridePersona?: string): Promise<void> => {
      if (sessionId === null || saving || baseline === null) return;
      const nextPersona = overridePersona ?? persona;
      const nextScope = scopePatchOf({ workspace, permission });
      /**
       * ★ 只提交真正改变的字段。
       *
       * 若工作区在落库后被删除，用户只改人格时不应该被旧路径拦住保存；
       * 只有用户重新编辑工作区/权限时才让服务端重新校验。
       */
      const patch: SessionSettingsPatch = {
        persona: nextPersona,
        memoryMode,
        ...(nextScope.workspace !== baseline.workspace
          ? { workspace: nextScope.workspace }
          : {}),
        ...(nextScope.permission !== baseline.permission
          ? { permission: nextScope.permission }
          : {}),
      };
      setSaving(true);
      setSaveError(null);
      try {
        const res = await patchJson<SessionSettingsPatchResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          patch,
        );
        const saved = res.session.settings;
        const savedPersona = typeof saved.persona === 'string' ? saved.persona : nextPersona;
        const savedScope = scopeOf(res.session);
        setPersona(savedPersona);
        setWorkspace(savedScope.workspace ?? '');
        setPermission(savedScope.permission ?? '');
        setScope(savedScope);
        setBaseline({
          persona: savedPersona,
          memoryMode: saved.memoryMode === 'off' ? 'off' : 'on',
          workspace: savedScope.workspace,
          permission: savedScope.permission,
        });
        onSaved(res.session);
        notify('对话设置已保存', 'success');
        onClose();
      } catch (err) {
        const message = errorMessage(err);
        setSaveError(message);
        notify(message, 'danger');
      } finally {
        setSaving(false);
      }
    },
    [baseline, memoryMode, notify, onClose, onSaved, permission, persona, saving, sessionId, workspace],
  );

  const detailLoaded = baseline !== null && !loading && loadError === null;
  const personaChanged = baseline !== null && persona !== baseline.persona;
  const hasPersonaBaseline = baseline !== null && baseline.persona.length > 0;
  const resetDisabled =
    loading || saving || loadError !== null || (!hasPersonaBaseline && persona.length === 0);
  const effectivePermission = scope?.effectivePermission ?? 'read-only';
  const fullWarning = permission === 'full' || effectivePermission === 'full';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="对话设置"
      description="模型与思考强度在输入框右侧调整。"
      variant="settings"
      footer={
        <div className="session-sheet-foot">
          <button
            type="button"
            className="text-btn session-sheet-reset"
            disabled={resetDisabled}
            onClick={() => {
              setPersona('');
              void submit('');
            }}
          >
            重置为空
          </button>
          <div className="session-sheet-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={saving}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={loading || saving || loadError !== null || (!dirty && !personaChanged)}
              onClick={() => void submit()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      }
    >
      {session !== null && (
        <div className="session-sheet">
          <p className="session-sheet-context">
            <Icon name="chat" size={14} />
            <span>{session.title}</span>
          </p>

          {saveError !== null && (
            <div className="session-sheet-error" role="alert">
              <InlineError message={saveError} />
            </div>
          )}

          {loading && (
            <div className="session-sheet-loading">
              <Skeleton rows={2} height={14} />
              <Skeleton rows={3} height={12} />
            </div>
          )}

          {loadError !== null && !loading && (
            <InlineError
              message={loadError}
              onRetry={() => {
                if (sessionId !== null) void load(sessionId);
              }}
            />
          )}

          {detailLoaded && (
            <>
              <section className="session-sheet-section" aria-labelledby="session-workspace-label">
                <div className="session-sheet-head">
                  <div>
                    <h3 id="session-workspace-label">工作区</h3>
                  </div>
                </div>
                <label className="task-field">
                  <input
                    className="task-input mono"
                    value={workspace}
                    disabled={saving}
                    spellCheck={false}
                    placeholder={`跟随应用默认：${scope?.effectiveWorkspace ?? ''}`}
                    aria-label="本对话的工作区路径"
                    onChange={(event) => setWorkspace(event.target.value)}
                  />
                </label>
              </section>

              <section className="session-sheet-section" aria-labelledby="session-permission-label">
                <div className="session-sheet-head">
                  <div>
                    <h3 id="session-permission-label">
                      权限
                      <span
                        className="session-perm-info"
                        title={PERMISSION_TIP}
                        aria-label={PERMISSION_TIP}
                        role="img"
                        tabIndex={0}
                      >
                        <Icon name="info" size={13} />
                      </span>
                    </h3>
                  </div>
                </div>
                <label className="task-field">
                  <select
                    className="task-select"
                    value={permission}
                    disabled={saving}
                    aria-label="本对话的工具权限"
                    onChange={(event) => {
                      const value = event.target.value;
                      setPermission(isSessionPermission(value) ? value : '');
                    }}
                  >
                    <option value="">跟随应用（当前：{SESSION_PERMISSION_LABEL[effectivePermission]}）</option>
                    <option value="read-only">只读</option>
                    <option value="workspace">工作区</option>
                    <option value="full">完全</option>
                  </select>
                </label>

                {fullWarning && (
                  <p className="session-sheet-warn" role="alert">
                    <Icon name="shield" size={13} />
                    <span>
                      「完全」允许工具读写本对话工作区之外的路径。系统数据{' '}
                      <code>.butler-data</code>、密钥 <code>.env.local</code> 与全局规则{' '}
                      <code>config/</code> 始终拒绝；移动等高风险需逐次确认；
                      命令执行工具不提供（没有 OS 沙箱）。这是高风险选择，请只在你信任的对话里使用。
                    </span>
                  </p>
                )}
              </section>

              <section className="session-sheet-section" aria-labelledby="session-persona-label">
                <div className="session-sheet-head">
                  <div>
                    <h3 id="session-persona-label">AI 人格</h3>
                    <p>只对这段对话生效。留空即使用默认管家。</p>
                  </div>
                  <span className="session-sheet-count mono">
                    {persona.length}/{PERSONA_MAX}
                  </span>
                </div>
                <textarea
                  className="session-sheet-textarea"
                  rows={7}
                  maxLength={PERSONA_MAX}
                  value={persona}
                  disabled={saving}
                  placeholder="例如：称呼我“老王”；先给结论，再给依据；不要用感叹号。"
                  aria-label="本对话的 AI 人格"
                  onChange={(event) => setPersona(event.target.value.slice(0, PERSONA_MAX))}
                />
                <p className="session-sheet-hint">
                  人格只影响答复与叙述，不会改写任务契约、记忆提取或监督记录。
                </p>
              </section>

              <section className="session-sheet-section" aria-labelledby="session-memory-label">
                <div className="session-sheet-switch-row">
                  <div>
                    <h3 id="session-memory-label">使用记忆</h3>
                    <p>这段对话是否召回与写入记忆。</p>
                  </div>
                  <Switch
                    checked={memoryMode === 'on'}
                    disabled={saving}
                    label="本对话使用记忆"
                    onChange={(next) => setMemoryMode(next ? 'on' : 'off')}
                  />
                </div>
              </section>

              {(saving || dirty) && (
                <p className="session-sheet-dirty" role="status">
                  {saving ? '正在保存…' : '有未保存的修改'}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
