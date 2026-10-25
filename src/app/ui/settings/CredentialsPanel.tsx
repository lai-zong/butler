'use client';

/**
 * 设置 → 凭证保险库。
 *
 * ★ 只显示名称与时间；新增时输入内容后立即加密，列表/导出不返回值。
 * ★ 删除立即生效；不会写进记忆或事件流。
 */

import { useCallback, useEffect, useState } from 'react';

import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { errorMessage, fetchJson } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import type { CredentialMetaDto, CredentialsResponse } from '../lib/types.js';

export function CredentialsPanel({ notify }: { readonly notify: (text: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void }): JSX.Element {
  const [items, setItems] = useState<readonly CredentialMetaDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const data = await fetchJson<CredentialsResponse>('/api/credentials');
      setItems(data.credentials);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(): Promise<void> {
    if (busy) return;
    if (name.trim().length === 0 || secret.trim().length === 0) {
      setFormError('名称和内容都必须填写。');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), secret }),
      });
      const body = (await res.json().catch(() => ({}))) as { readonly error?: string };
      if (!res.ok) throw new Error(body.error ?? '保存失败');
      setName('');
      setSecret('');
      setAddOpen(false);
      notify('凭证已加密保存。', 'success');
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: CredentialMetaDto): Promise<void> {
    if (!window.confirm(`删除「${item.name}」？删除后无法恢复。`)) return;
    try {
      const res = await fetch(`/api/credentials/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { readonly error?: string };
        throw new Error(body.error ?? '删除失败');
      }
      notify('凭证已删除。', 'default');
      await load();
    } catch (err) {
      notify(errorMessage(err), 'warning');
    }
  }

  return (
    <section className="panel settings-panel ops-panel">
      <SectionHeading
        title="凭证保险库"
        description="加密保存在本机；列表、日志、导出都只显示名称，不显示内容。"
        actions={
          <div className="ops-actions">
            <Badge tone="accent">{items.length} 条</Badge>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setAddOpen((v) => !v);
                setFormError(null);
              }}
            >
              {addOpen ? '收起' : '添加凭证'}
            </button>
          </div>
        }
      />

      {loading ? (
        <Skeleton rows={4} height={14} />
      ) : error !== null ? (
        <InlineError message={error} onRetry={() => void load()} />
      ) : (
        <>
          <p className="ops-empty" style={{ marginTop: 0 }}>
            密钥内容不会显示在页面上，也不会进入对话、记忆或导出文件。
            Windows DPAPI 绑定当前用户；换 Windows 用户无法解密。
            名为 <code>DEEPSEEK_API_KEY</code> 的条目会在下次启动时作为模型 Key 使用。
          </p>

          {addOpen && (
            <div className="ops-add">
              <label className="ops-add-field">
                <span>名称</span>
                <input
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如 github_token"
                  disabled={busy}
                />
              </label>
              <label className="ops-add-field">
                <span>内容</span>
                <input
                  type="password"
                  value={secret}
                  maxLength={16_384}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="粘贴密钥；保存后不会再显示"
                  disabled={busy}
                  autoComplete="off"
                />
              </label>
              {formError !== null && <p className="ops-add-error">{formError}</p>}
              <div className="ops-add-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddOpen(false)} disabled={busy}>
                  取消
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={busy}>
                  {busy ? '保存中…' : '加密保存'}
                </button>
              </div>
            </div>
          )}

          {items.length === 0 ? (
            <p className="ops-empty">还没有凭证。需要让外部工具使用密钥时，先在这里保存。</p>
          ) : (
            <div className="ops-list">
              {items.map((item) => (
                <div key={item.id} className="ops-item">
                  <div className="ops-item-main">
                    <strong>{item.name}</strong>
                    <span className="ops-item-meta">{formatDateTime(item.createdAt)}</span>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(item)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
