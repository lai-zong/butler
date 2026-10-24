'use client';

/**
 * 设置 → 工具分级。
 *
 * ★ 这一块只**展示**，不修改：
 *   - tier 是工具定义的一部分，不是用户偏好；
 *   - 用户能做的是在 C5 三档里决定"放行到哪一级"；
 *   - dangerous 始终禁用，不提供网页开关。
 *
 * 数据来自 `GET /api/tools`，只列**已注册**的工具；
 * 桌面工具没注册就不会出现，不补造。
 */

import { useCallback, useEffect, useState } from 'react';

import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { errorMessage, fetchJson } from '../lib/api.js';
import type { ToolTier, ToolsResponse, ToolTierView } from '../lib/types.js';

const TIERS: readonly {
  readonly key: ToolTier;
  readonly code: string;
  readonly label: string;
  readonly desc: string;
}[] = [
  { key: 'readOnly', code: 'READ ONLY', label: '只读', desc: '不改变系统状态' },
  { key: 'normal', code: 'NORMAL', label: '常规', desc: '可撤销的常规变更' },
  { key: 'highRisk', code: 'HIGH RISK', label: '高风险', desc: '难撤销 / 影响面广' },
  { key: 'dangerous', code: 'DANGEROUS', label: '危险', desc: '不可逆操作' },
];

const MODE_LABEL: Record<'view' | 'workspace' | 'full', string> = {
  view: '仅查看',
  workspace: '工作区内修改',
  full: '完全权限',
};

export function ToolsPanel(): JSX.Element {
  const [data, setData] = useState<ToolsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setData(await fetchJson<ToolsResponse>('/api/tools'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  const tools = data?.tools ?? [];
  const counts = new Map<ToolTier, number>();
  for (const tool of tools) counts.set(tool.tier, (counts.get(tool.tier) ?? 0) + 1);

  const modeLabel =
    data?.mode === null || data?.mode === undefined
      ? '未配置模式'
      : MODE_LABEL[data.mode];

  const statusOf = (tier: ToolTier): { label: string; tone: 'on' | 'off' } => {
    if (tier === 'dangerous') return { label: '始终禁用', tone: 'off' };
    return data?.enabledTiers[tier] === true
      ? { label: '放行', tone: 'on' }
      : { label: '拒绝', tone: 'off' };
  };

  return (
    <section className="panel settings-panel tools-panel">
      <SectionHeading
        title="工具分级"
        description="每条工具落在哪一级、用什么手段执行 —— 分级由工具本身决定，这里只展示。"
        actions={
          <div className="tools-actions">
            <Badge tone="outline">{modeLabel}</Badge>
            <Badge tone="neutral">{tools.length} 个工具</Badge>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                setNonce((n) => n + 1);
              }}
            >
              {refreshing ? '刷新中…' : '刷新'}
            </button>
          </div>
        }
      />

      {loading && data === null ? (
        <Skeleton rows={5} height={14} />
      ) : error !== null && data === null ? (
        <InlineError message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : (
        <>
          {error !== null && <p className="tools-error">{error}</p>}

          <div className="tools-summary">
            {TIERS.map((t) => {
              const status = statusOf(t.key);
              return (
                <div key={t.key} className={`tools-tier tools-tier--${t.key}`}>
                  <div className="tools-tier-head">
                    <span>{t.code}</span>
                    <span>{t.label}</span>
                  </div>
                  <strong>{counts.get(t.key) ?? 0}</strong>
                  <p>{t.desc}</p>
                  <span className={`tools-state tools-state--${status.tone}`}>
                    {status.label}
                  </span>
                </div>
              );
            })}
          </div>

          {tools.length === 0 ? (
            <p className="tools-empty">还没有注册任何工具。</p>
          ) : (
            <div className="tools-groups">
              {TIERS.map((t) => {
                const list = tools.filter((tool) => tool.tier === t.key);
                if (list.length === 0) return null;
                return (
                  <div key={t.key} className="tools-group">
                    <h4>
                      {t.label}
                      <Badge tone={t.key === 'dangerous' ? 'danger' : 'neutral'}>{t.key}</Badge>
                      <span>{list.length}</span>
                    </h4>
                    <div className="tool-rows">
                      {list.map((tool) => (
                        <ToolRow key={tool.name} tool={tool} status={statusOf(tool.tier)} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <p className="tools-note">
            <strong>rung</strong> 是执行手段（1 应用接口 / 2 模式调用 / 3 窗口消息 / 4 真实注入），不是权限等级；
            当前没有 rung 3/4 工具注册。危险级始终禁用，不提供网页开关；只列已注册工具，不补造未注册能力。
          </p>
        </>
      )}
    </section>
  );
}

function ToolRow({
  tool,
  status,
}: {
  readonly tool: ToolTierView;
  readonly status: { readonly label: string; readonly tone: 'on' | 'off' };
}): JSX.Element {
  return (
    <div className={`tool-row ${tool.tier === 'dangerous' ? 'is-danger' : ''}`}>
      <span className="tool-name">
        <span className="mono">{tool.name}</span>
        {tool.touchesCredentials && <span className="tool-flag">凭证</span>}
      </span>
      <span className={`tool-source tool-source--${tool.source}`}>
        {tool.source === 'mcp' ? 'MCP' : '原生'}
      </span>
      <span className="tool-desc" title={tool.description}>{tool.description}</span>
      <span className="tool-rung mono">{tool.rung === null ? '—' : `rung ${tool.rung}`}</span>
      <span className={`tool-state tool-state--${status.tone}`}>{status.label}</span>
    </div>
  );
}
