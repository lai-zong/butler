'use client';

/**
 * 设置 → MCP 服务。
 *
 * 第一版只做 stdio（运行时只注册了 stdio transport）。
 * 添加/移除/启停/连接/断开/工具列表都会写回 mcp.json；
 * 不在配置里保存明文凭证（validateConfig 会拒绝）。
 */

import { useCallback, useEffect, useState } from 'react';

import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson } from '../lib/api.js';
import type { McpResponse, McpServerView, ToastMessage } from '../lib/types.js';

const STATE_LABEL: Record<McpServerView['state'], string> = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
  failed: '连接失败',
  disabled: '已停用',
};

const STATE_TONE: Record<
  McpServerView['state'],
  'accent' | 'warn' | 'danger' | 'neutral' | 'info'
> = {
  disconnected: 'neutral',
  connecting: 'info',
  connected: 'accent',
  failed: 'danger',
  disabled: 'neutral',
};

interface McpPanelProps {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}

type PolicyLevel = McpServerView['policy']['level'];

interface PolicyDraft {
  readonly level: PolicyLevel;
  readonly disabledTools: readonly string[];
  readonly allowDangerousTools: boolean;
}

const POLICY_LEVELS: readonly { readonly value: PolicyLevel; readonly title: string; readonly desc: string }[] = [
  { value: 'manual', title: '全部需确认', desc: '任何调用都逐次确认' },
  { value: 'readOnly', title: '只读自动放行', desc: '读工具自动，写操作确认' },
  { value: 'normal', title: '常规自动放行', desc: '常规自动，高风险确认' },
];

export function McpPanel({ notify }: McpPanelProps): JSX.Element {
  const [data, setData] = useState<McpResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<McpServerView | null>(null);
  const [form, setForm] = useState({
    id: '',
    name: '',
    transport: 'stdio',
    command: '',
    args: '',
  });

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchJson<McpResponse>('/api/mcp'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: string, id?: string): Promise<void> => {
    setBusy(id !== undefined ? `${action}:${id}` : action);
    setError(null);
    try {
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(id !== undefined ? { id } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { readonly error?: string };
      if (!res.ok) throw new Error(body.error ?? `操作失败（HTTP ${res.status}）`);
      notify(`${action === 'connect' ? '连接成功' : action === 'disconnect' ? '已断开' : '已更新'}`, 'success');
      await load();
    } catch (err) {
      setError(errorMessage(err));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const savePolicy = async (id: string, policy: PolicyDraft): Promise<void> => {
    setBusy(`policy:${id}`);
    setError(null);
    try {
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'updatePolicy', id, policy }),
      });
      const body = (await res.json().catch(() => ({}))) as { readonly error?: string };
      if (!res.ok) throw new Error(body.error ?? `保存失败（HTTP ${res.status}）`);
      notify('MCP 策略已保存，工具表已重注册', 'success');
      await load();
    } catch (err) {
      setError(errorMessage(err));
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const add = async (): Promise<void> => {
    setBusy('add');
    setError(null);
    try {
      const args = form.args
        .split(/\s+/)
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          id: form.id.trim(),
          name: form.name.trim(),
          transport: form.transport,
          command: form.command.trim(),
          args,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { readonly error?: string };
      if (!res.ok) throw new Error(body.error ?? `添加失败（HTTP ${res.status}）`);
      setAddOpen(false);
      setForm({ id: '', name: '', transport: 'stdio', command: '', args: '' });
      notify('MCP 服务器已添加，配置文件已写回', 'success');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    if (removeTarget === null) return;
    setBusy(`remove:${removeTarget.id}`);
    setError(null);
    try {
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'remove', id: removeTarget.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { readonly error?: string };
      if (!res.ok) throw new Error(body.error ?? `移除失败（HTTP ${res.status}）`);
      setRemoveTarget(null);
      notify('MCP 服务器已移除', 'success');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const servers = data?.servers ?? [];

  return (
    <section className="panel settings-panel" aria-label="MCP 服务">
      <SectionHeading
        title="MCP 服务"
        description="外部 MCP server 作为工具源接入；添加与启停会写回本机 mcp.json。"
        actions={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={13} /> 添加服务器
          </button>
        }
      />

      {loading && data === null ? (
        <Skeleton rows={4} height={14} />
      ) : error !== null && data === null ? (
        <InlineError message={error} onRetry={() => void load()} />
      ) : (
        <>
          <div className="mcp-meta">
            <span className="mono">配置：{data?.configPath ?? '—'}</span>
            <span>已注册工具 {data?.registeredTools ?? 0} 个</span>
          </div>

          {error !== null && <p className="mcp-error">{error}</p>}

          {data !== null && data.rejected.length > 0 && (
            <div className="mcp-rejected">
              <strong>配置里有 {data.rejected.length} 条被丢弃：</strong>
              <ul>
                {data.rejected.map((r) => (
                  <li key={`${r.index}-${r.reason}`}>#{r.index} {r.reason}</li>
                ))}
              </ul>
            </div>
          )}

          {servers.length === 0 ? (
            <p className="mcp-empty">
              还没有 MCP 服务器。添加一个 stdio server 后，它可以作为工具接入；新增服务器默认“全部需确认”。
            </p>
          ) : (
            <div className="mcp-list">
              {servers.map((s) => {
                const key = s.id;
                return (
                  <article className="mcp-server" key={key}>
                    <header className="mcp-server-head">
                      <div>
                        <strong>{s.name}</strong>
                        <span className="mono mcp-id">{s.id}</span>
                      </div>
                      <div className="mcp-server-status">
                        <Badge tone={STATE_TONE[s.state]}>{STATE_LABEL[s.state]}</Badge>
                        {!s.enabled && <Badge tone="neutral">已停用</Badge>}
                        <span className="mcp-transport">{s.transport}</span>
                      </div>
                    </header>

                    <p className="mcp-command mono">{s.command ?? s.url ?? '—'}</p>
                    {s.lastError !== null && <p className="mcp-error">{s.lastError}</p>}

                    <div className="mcp-server-actions">
                      {s.state === 'connected' ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busy !== null}
                          onClick={() => void act('disconnect', s.id)}
                        >
                          断开
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busy !== null || !s.enabled}
                          onClick={() => void act('connect', s.id)}
                        >
                          连接
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy !== null}
                        onClick={() => void act(s.enabled ? 'disable' : 'enable', s.id)}
                      >
                        {s.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-ghost-danger"
                        disabled={busy !== null}
                        onClick={() => setRemoveTarget(s)}
                      >
                        移除
                      </button>
                    </div>

                    <McpPolicyEditor
                      key={`${s.id}:${s.policy.level}:${s.policy.allowDangerousTools}:${s.policy.disabledTools.join(',')}`}
                      server={s}
                      busy={busy !== null}
                      onSave={(policy) => savePolicy(s.id, policy)}
                    />

                    {s.tools.length > 0 ? (
                      <details className="mcp-tools">
                        <summary>工具 {s.tools.length} 个</summary>
                        <ul>
                          {s.tools.map((t) => (
                            <li key={t.qualifiedName}>
                              <span className="mono">{t.name}</span>
                              <span className="mcp-tier">{t.tier}</span>
                              <span>{t.description}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <p className="mcp-empty mcp-tools-none">尚未发现工具（需先连接）。</p>
                    )}
                  </article>
                );
              })}
            </div>
          )}

          <p className="mcp-note">
            只列出本机已实现的 stdio 传输。配置中的 env 只显示键名，不显示值；疑似凭证会被拒绝写回。
          </p>
        </>
      )}

      <Modal
        open={addOpen}
        onClose={() => {
          if (busy !== 'add') setAddOpen(false);
        }}
        title="添加 MCP 服务器"
        description="第一版支持本地 stdio server。新服务器默认策略为“全部需确认”。"
        footer={
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" disabled={busy === 'add'} onClick={() => setAddOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy === 'add' || form.id.trim() === '' || form.command.trim() === ''}
              onClick={() => void add()}
            >
              {busy === 'add' ? '添加中…' : '添加'}
            </button>
          </div>
        }
      >
        <div className="mcp-form">
          <label>
            <span>ID</span>
            <input
              value={form.id}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              placeholder="例如 filesystem"
            />
          </label>
          <label>
            <span>名称</span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="展示名，可留空"
            />
          </label>
          <label>
            <span>传输</span>
            <select
              value={form.transport}
              onChange={(e) => setForm((f) => ({ ...f, transport: e.target.value }))}
            >
              {(data?.availableTransports ?? ['stdio']).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>命令</span>
            <input
              value={form.command}
              onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
              placeholder="例如 npx"
            />
          </label>
          <label>
            <span>参数（空格分隔）</span>
            <input
              value={form.args}
              onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
              placeholder="-y @modelcontextprotocol/server-filesystem C:\work"
            />
          </label>
          <p className="mcp-form-note">不要在参数里写 API key；配置会经过凭证明文检查。</p>
        </div>
      </Modal>

      <Modal
        open={removeTarget !== null}
        onClose={() => {
          if (busy === null) setRemoveTarget(null);
        }}
        title="移除这个 MCP 服务器？"
        description="会断开连接、移除已注册工具并写回 mcp.json；不会删除服务器自己的文件。"
        footer={
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setRemoveTarget(null)}>
              取消
            </button>
            <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void remove()}>
              确认移除
            </button>
          </div>
        }
      >
        <p className="mcp-empty">{removeTarget?.name}</p>
      </Modal>
    </section>
  );
}

function McpPolicyEditor({
  server,
  busy,
  onSave,
}: {
  readonly server: McpServerView;
  readonly busy: boolean;
  readonly onSave: (policy: PolicyDraft) => Promise<void>;
}): JSX.Element {
  const [level, setLevel] = useState<PolicyLevel>(server.policy.level);
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(
    () => new Set(server.policy.disabledTools),
  );
  const [dangerous, setDangerous] = useState(server.policy.allowDangerousTools);
  const [confirmed, setConfirmed] = useState(server.policy.allowDangerousTools);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toolNames = [...new Set([...server.tools.map((t) => t.name), ...disabled])].sort();
  const toolByName = new Map(server.tools.map((t) => [t.name, t]));
  const canSave = !busy && !saving && (!dangerous || confirmed);

  const toggleTool = (name: string): void => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleDangerous = (): void => {
    const next = !dangerous;
    setDangerous(next);
    setConfirmed(next ? false : true);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        level,
        disabledTools: [...disabled].sort(),
        allowDangerousTools: dangerous,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mcp-policy-editor">
      <div className="mcp-policy-head">
        <strong>权限策略</strong>
        <span>独立于全局闸门 · 写回 mcp.json</span>
      </div>

      <div className="mcp-policy-levels">
        {POLICY_LEVELS.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`mcp-level ${level === p.value ? 'is-active' : ''}`}
            aria-pressed={level === p.value}
            disabled={busy || saving}
            onClick={() => setLevel(p.value)}
          >
            <strong>{p.title}</strong>
            <span>{p.desc}</span>
          </button>
        ))}
      </div>

      <div className="mcp-policy-label">
        禁用工具 <span>黑名单优先于级别</span>
      </div>
      {toolNames.length === 0 ? (
        <p className="mcp-policy-empty">连接服务器后会列出可禁用的工具。</p>
      ) : (
        <div className="mcp-policy-tools">
          {toolNames.map((name) => {
            const tool = toolByName.get(name);
            return (
              <label key={name} className="mcp-tool-check">
                <input
                  type="checkbox"
                  checked={disabled.has(name)}
                  disabled={busy || saving}
                  onChange={() => toggleTool(name)}
                />
                <span className="mono">{name}</span>
                <small>{tool?.tier ?? '已禁用'}</small>
              </label>
            );
          })}
        </div>
      )}

      <div className={`mcp-danger ${dangerous ? 'is-on' : ''}`}>
        <div>
          <strong>允许危险级工具</strong>
          <p>开启后该服务器可以执行不可逆操作；每次仍会单独请求确认，不会静默执行。</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={dangerous}
          aria-label="允许危险级工具"
          className={`mcp-switch ${dangerous ? 'is-on' : ''}`}
          disabled={busy || saving}
          onClick={toggleDangerous}
        >
          <span />
        </button>
      </div>

      {dangerous && (
        <label className="mcp-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || saving}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          我明白这个服务器可以执行不可逆操作
        </label>
      )}

      {error !== null && <p className="mcp-error">{error}</p>}

      <div className="mcp-policy-foot">
        <span>
          保存后立即重注册工具；被禁用的工具从模型可用集合移除。记忆写入开关暂未开放（后端未接线）。
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canSave}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存策略'}
        </button>
      </div>
    </div>
  );
}
