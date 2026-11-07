'use client';

import { useEffect, useState } from 'react';

import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { errorMessage, fetchJson } from '../lib/api.js';
import type { ToastMessage } from '../lib/types.js';

type Mode = 'view' | 'workspace' | 'full';

const MODES: readonly { mode: Mode; title: string; desc: string; icon: 'eye' | 'file' | 'shield' }[] = [
  { mode: 'view', title: '仅查看', desc: '读文件、查目录、看状态；不修改任何东西。', icon: 'eye' },
  { mode: 'workspace', title: '工作区内修改', desc: '可改工作区文件、建目录；命令执行与高风险操作按会话能力处理。', icon: 'file' },
  { mode: 'full', title: '完全权限', desc: '开放常规与高风险操作；危险操作仍禁用。', icon: 'shield' },
];

export function PermissionsPanel({
  notify,
}: {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode | null>(null);
  const [saved, setSaved] = useState<Mode | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchJson<{ mode: Mode | null; legacy: boolean }>('/api/permissions');
        if (cancelled) return;
        setSaved(res.mode);
        // 未配置时真实默认是只读；界面必须预选 view，不能预选 workspace。
        setMode(res.mode ?? 'view');
        setLegacy(res.legacy);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(): Promise<void> {
    if (mode === null) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson('/api/permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      setSaved(mode);
      setLegacy(false);
      notify('权限模式已保存，立即生效并持久化', 'success');
    } catch (err) {
      setError(errorMessage(err));
      notify(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-panel">
      <SectionHeading
        title="权限与自主"
        description="决定 butler 能碰到哪一层；危险操作永远禁用，不随模式放开。"
        actions={
          <Badge tone="outline">
            <Icon name="shield" size={12} /> 本机 · 无账号
          </Badge>
        }
      />
      {loading ? (
        <Skeleton rows={4} height={16} />
      ) : error !== null && saved === null ? (
        <InlineError message={error} onRetry={() => window.location.reload()} />
      ) : (
        <>
          <div className="perm-modes">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                className={`perm-mode ${mode === m.mode ? 'is-on' : ''}`}
                onClick={() => setMode(m.mode)}
              >
                <span className="perm-radio" aria-hidden="true" />
                <span className="perm-mode-icon"><Icon name={m.icon} size={15} /></span>
                <strong>{m.title}</strong>
                <small>{m.desc}</small>
              </button>
            ))}
          </div>

          <div className="perm-ask">
            <div className="perm-ask-switch" aria-hidden="true"><span /></div>
            <div>
              <strong>需要确认时弹窗</strong>
              <small>当前固定开启：写操作与高风险操作执行前询问，超时自动拒绝。</small>
            </div>
          </div>

          <div className="perm-warning">
            全局硬约束（过敏、安全底线）不受权限模式影响；<code>dangerous</code> 档位始终禁用。
          </div>

          <div className="perm-foot">
            <span>
              {legacy
                ? '当前未配置模式，实际按仅查看（只读）运行。'
                : saved === null
                  ? '当前未配置模式，实际按仅查看（只读）运行。'
                  : `当前生效：${MODES.find((m) => m.mode === saved)?.title ?? saved}`}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={saving || mode === saved} onClick={() => void save()}>
              {saving ? '保存中…' : '保存权限'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
