'use client';

/**
 * 权限与自主 —— 三档权限 + 确认开关
 *
 * ★ 交互约定：
 *   · 点模式卡立即保存（乐观选中 → PUT → 失败回滚并 notify）
 *   · 确认开关是真正的开关，不是说明文字
 *   · 不展示“未配置 / 当前生效”字样，也不再有“保存权限”按钮
 *   · 请求期间禁止再次点击，避免同一端点的重复/乱序覆盖
 */

import { useEffect, useRef, useState } from 'react';

import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { Icon } from '../components/Icon';
import { Switch } from '../components/Switch';
import { errorMessage, fetchJson } from '../lib/api.js';
import type { ToastMessage } from '../lib/types.js';
import {
  putPermissions,
  saveConfirmActions,
  saveMode,
  snapshotsFromGet,
  type PermissionsGetResponse,
  type PermissionsSnapshot,
  type PermissionMode,
} from './permissions.js';

const MODES: readonly {
  readonly mode: PermissionMode;
  readonly title: string;
  readonly desc: string;
  readonly icon: 'eye' | 'file' | 'shield';
}[] = [
  { mode: 'view', title: '仅查看', desc: '读文件、查目录、看状态；不修改任何东西。', icon: 'eye' },
  { mode: 'workspace', title: '工作区内修改', desc: '可改工作区文件、建目录；命令执行与高风险操作按会话能力处理。', icon: 'file' },
  { mode: 'full', title: '完全权限', desc: '开放常规与高风险操作；危险操作仍禁用。', icon: 'shield' },
];

function modeTitle(mode: PermissionMode): string {
  return MODES.find((m) => m.mode === mode)?.title ?? mode;
}

export function PermissionsPanel({
  notify,
}: {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}): JSX.Element {
  /** 选中态；null 表示还没读到（加载中或加载失败）。 */
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [confirmActions, setConfirmActions] = useState(true);
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState(false);
  const [savingConfirm, setSavingConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 同步锁：两个 handler 都可能被快速点击。
   * 只靠 state 会在一帧内连点两次都看到旧值，所以用 ref 立即挡住第二次。
   */
  const inFlightRef = useRef(false);
  const saving = savingMode || savingConfirm;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchJson<PermissionsGetResponse>('/api/permissions');
        if (cancelled) return;
        const snapshot = snapshotsFromGet(res);
        setMode(snapshot.mode);
        setConfirmActions(snapshot.confirmActions);
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

  async function selectMode(next: PermissionMode): Promise<void> {
    if (mode === null || next === mode || inFlightRef.current) return;
    const previous: PermissionsSnapshot = { mode, confirmActions };
    inFlightRef.current = true;
    // 选中态先更新；请求失败再回滚到 previous。
    setMode(next);
    setSavingMode(true);
    try {
      const result = await saveMode(previous, next, putPermissions);
      setMode(result.snapshot.mode);
      setConfirmActions(result.snapshot.confirmActions);
      if (result.ok) notify(`已切换到「${modeTitle(result.snapshot.mode)}」，立即生效`, 'success');
      else notify(errorMessage(result.error), 'danger');
    } finally {
      inFlightRef.current = false;
      setSavingMode(false);
    }
  }

  async function toggleConfirm(next: boolean): Promise<void> {
    if (mode === null || next === confirmActions || inFlightRef.current) return;
    const previous: PermissionsSnapshot = { mode, confirmActions };
    inFlightRef.current = true;
    setConfirmActions(next);
    setSavingConfirm(true);
    try {
      const result = await saveConfirmActions(previous, next, putPermissions);
      setMode(result.snapshot.mode);
      setConfirmActions(result.snapshot.confirmActions);
      if (result.ok) {
        notify(next ? '已开启执行前确认' : '已关闭执行前确认，将按权限模式直接执行', next ? 'success' : 'warning');
      } else {
        notify(errorMessage(result.error), 'danger');
      }
    } finally {
      inFlightRef.current = false;
      setSavingConfirm(false);
    }
  }

  return (
    <section className="panel settings-panel" aria-busy={saving}>
      <SectionHeading
        title="权限与自主"
        description="决定 butler 能在本机做到哪一层；切换立即生效并持久化。"
        actions={
          <Badge tone="outline">
            <Icon name="shield" size={12} /> 本机 · 无账号
          </Badge>
        }
      />
      {loading ? (
        <Skeleton rows={4} height={16} />
      ) : mode === null ? (
        <InlineError message={error ?? '无法读取权限设置'} onRetry={() => window.location.reload()} />
      ) : (
        <>
          <div className="perm-modes">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                className={`perm-mode ${mode === m.mode ? 'is-on' : ''}`}
                aria-pressed={mode === m.mode}
                disabled={saving}
                onClick={() => void selectMode(m.mode)}
              >
                <span className="perm-radio" aria-hidden="true" />
                <span className="perm-mode-icon"><Icon name={m.icon} size={15} /></span>
                <strong>{m.title}</strong>
                <small>{m.desc}</small>
              </button>
            ))}
          </div>

          <div className="perm-ask">
            <Switch
              checked={confirmActions}
              disabled={saving}
              label="需要确认时弹窗"
              onChange={(next) => void toggleConfirm(next)}
            />
            <div>
              <strong>需要确认时弹窗</strong>
              <small>
                {confirmActions
                  ? '写操作与高风险操作执行前询问。'
                  : '按当前权限模式直接执行，dangerous 仍禁用。'}
              </small>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
