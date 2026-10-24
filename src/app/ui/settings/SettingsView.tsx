'use client';

/**
 * 设置空间 —— 运行、隐私、数据
 *
 * ★ 这里的每一项都必须**真的能用**：
 *   隐私开关调用 /api/observation，导出调用 /api/transfer/export，
 *   导入会替换事件流并重建运行时。不放“看起来像设置”的摆设。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Badge,
  InlineError,
  Kbd,
  PageHeader,
  SectionHeading,
  Skeleton,
} from '../components/Common';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Switch } from '../components/Switch';
import { AutomationPanel } from './AutomationPanel';
import { PermissionsPanel } from './PermissionsPanel';
import { ActivityDetail } from './ActivityDetail';
import { McpPanel } from './McpPanel';
import { ToolsPanel } from './ToolsPanel';
import { OperationsPanel } from './OperationsPanel';
import { ArtifactsPanel } from './ArtifactsPanel';
import { errorMessage, fetchJson } from '../lib/api.js';
import {
  formatDateTime,
  formatNumber,
  formatUptime,
} from '../lib/format.js';
import type {
  ModelCapabilities,
  ObservationState,
  Overview,
  ToastMessage,
} from '../lib/types.js';

interface SettingsViewProps {
  readonly overview: Overview | null;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onRefreshOverview: () => void;
  readonly onDataReset: () => void;
}

interface ImportedSummary {
  readonly events: number;
  readonly lastSeq: number;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly restored: {
    readonly memories: number;
    readonly artifacts: number;
    readonly operationMemories: number;
    readonly checkpoints: number;
    readonly chatSessions: number;
  } | null;
  readonly backup: string | null;
  readonly historicalEvents: number;
}

interface ImportResponse {
  readonly ok: boolean;
  readonly imported: {
    readonly events: number;
    readonly lastSeq: number;
    readonly exportedAt: string;
    readonly userId: string;
    readonly appVersion: string;
  };
  readonly backup: string | null;
  readonly restored: {
    readonly memories: number;
    readonly artifacts: number;
    readonly operationMemories: number;
    readonly checkpoints: number;
    readonly chatSessions: number;
  };
  readonly historicalEvents: number;
}

const CAPABILITIES: readonly { readonly key: keyof ModelCapabilities; readonly label: string }[] = [
  { key: 'supportsStreaming', label: '流式输出' },
  { key: 'supportsTools', label: '工具调用' },
  { key: 'supportsThinking', label: '思考分片' },
  { key: 'supportsVision', label: '读图' },
];

const RETENTION: readonly { readonly value: number; readonly label: string }[] = [
  { value: 7, label: '保留 7 天' },
  { value: 14, label: '保留 14 天' },
  { value: 30, label: '保留 30 天' },
  { value: 0, label: '不保留原始记录' },
];

export function SettingsView({
  overview,
  notify,
  onRefreshOverview,
  onDataReset,
}: SettingsViewProps): JSX.Element {
  const [obs, setObs] = useState<ObservationState | null>(null);
  const [obsLoading, setObsLoading] = useState(true);
  const [obsError, setObsError] = useState<string | null>(null);
  const [obsBusy, setObsBusy] = useState(false);

  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ name: string; size: number; text: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportedSummary | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const loadObservation = useCallback(async (): Promise<void> => {
    setObsLoading(true);
    setObsError(null);
    try {
      const res = await fetchJson<ObservationState>('/api/observation');
      setObs(res);
    } catch (err) {
      setObsError(errorMessage(err));
    } finally {
      setObsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadObservation();
  }, [loadObservation]);

  const model = overview?.model ?? null;
  const diagnostics = overview?.diagnostics ?? null;
  const consent = obs;

  async function updateObservation(body: Record<string, unknown>, successText: string): Promise<void> {
    setObsBusy(true);
    try {
      const res = await fetchJson<ObservationState>('/api/observation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setObs(res);
      notify(successText, 'success');
      onRefreshOverview();
    } catch (err) {
      notify(errorMessage(err), 'danger');
    } finally {
      setObsBusy(false);
    }
  }

  async function toggleObservation(next: boolean): Promise<void> {
    if (consent === null) return;
    if (!consent.granted && next) {
      setConsentChecked(false);
      setConsentOpen(true);
      return;
    }
    await updateObservation({ enabled: next }, next ? '行为观察已开启' : '行为观察已暂停，已有数据保留');
  }

  async function grantConsent(): Promise<void> {
    setConsentOpen(false);
    await updateObservation({ granted: true }, '已同意并开启行为观察');
  }

  async function revokeConsent(): Promise<void> {
    setRevokeOpen(false);
    await updateObservation({ granted: false }, '已撤回同意，采集数据已清除');
  }

  async function changeRetention(days: number): Promise<void> {
    await updateObservation({ retentionDays: days }, `原始记录${days === 0 ? '不再保留' : `保留 ${days} 天`}`);
  }

  async function exportData(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch('/api/transfer/export');
      const text = await res.text();
      if (!res.ok) {
        let msg = `导出失败（HTTP ${res.status}）`;
        try {
          const data = JSON.parse(text) as { error?: string };
          if (typeof data.error === 'string') msg = data.error;
        } catch {
          // 保留默认信息
        }
        throw new Error(msg);
      }

      // ★ 导出文档自带脱敏清单：把"程序自动做了什么"如实告诉用户
      let redacted = 0;
      let pii = 0;
      try {
        const doc = JSON.parse(text) as {
          sanitization?: { redacted?: number; pii?: number };
        };
        redacted = doc.sanitization?.redacted ?? 0;
        pii = doc.sanitization?.pii ?? 0;
      } catch {
        // 文档解析失败不阻止下载；服务端已校验过结构
      }

      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `butler-export-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);

      const notes = [`已导出 ${(text.length / 1024).toFixed(1)} KB`];
      if (redacted > 0) notes.push(`自动脱敏 ${redacted} 处`);
      if (pii > 0) notes.push(`含个人信息 ${pii} 处`);
      notify(notes.join('；'), redacted > 0 ? 'warning' : 'success');
    } catch (err) {
      notify(errorMessage(err), 'danger');
    } finally {
      setExporting(false);
    }
  }

  async function pickImport(file: File): Promise<void> {
    if (file.size > 64 * 1024 * 1024) {
      notify('文件超过 64 MB 上限', 'warning');
      return;
    }
    try {
      const text = await file.text();
      setPendingImport({ name: file.name, size: file.size, text });
    } catch (err) {
      notify(errorMessage(err), 'danger');
    }
  }

  async function runImport(): Promise<void> {
    if (pendingImport === null || importing) return;
    setImporting(true);
    try {
      const res = await fetchJson<ImportResponse>('/api/transfer/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: pendingImport.text,
      });
      setImportResult({
        events: res.imported.events,
        lastSeq: res.imported.lastSeq,
        exportedAt: res.imported.exportedAt,
        appVersion: res.imported.appVersion,
        restored: res.restored,
        backup: res.backup,
        historicalEvents: res.historicalEvents,
      });
      notify(`已导入 ${formatNumber(res.imported.events)} 条历史事件`, 'success');
      setPendingImport(null);
      onRefreshOverview();
      onDataReset();
      await loadObservation();
    } catch (err) {
      notify(errorMessage(err), 'danger');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="page settings-page">
      <PageHeader
        eyebrow="RUNTIME / DATA / PRIVACY"
        title="设置"
        description="本地优先。记忆、对话与事件都在这台电脑上；密钥不会出现在任何界面与导出文件里。"
      />

      <div className="settings-stack">
        {/* ── 运行 ── */}
        <section className="panel settings-panel">
          <SectionHeading
            title="运行状态"
            description="服务端是一个常驻单例；事件文件是唯一真相源。"
            actions={
              <Badge tone={model !== null ? 'accent' : 'warn'}>
                {model !== null ? '模型已接入' : '未配置模型'}
              </Badge>
            }
          />

          {overview === null ? (
            <Skeleton rows={4} height={14} />
          ) : (
            <>
              <div className="settings-rows">
                <div className="settings-row">
                  <span className="settings-key">主力模型</span>
                  <span className="settings-val">
                    {model !== null ? (
                      <>
                        <strong>{model.model}</strong>
                        <span className="mono settings-muted">{model.provider}</span>
                      </>
                    ) : (
                      <span className="settings-warn">在 .env.local 设置 DEEPSEEK_API_KEY 后重启</span>
                    )}
                  </span>
                </div>

                {model !== null && (
                  <div className="settings-row">
                    <span className="settings-key">模型能力</span>
                    <span className="settings-val capability-row">
                      {CAPABILITIES.map((c) => (
                        <Badge key={c.key} tone={model.capabilities[c.key] ? 'accent' : 'outline'}>
                          {c.label}
                        </Badge>
                      ))}
                    </span>
                  </div>
                )}

                <div className="settings-row">
                  <span className="settings-key">已运行</span>
                  <span className="settings-val mono">{formatUptime(diagnostics?.uptimeMs ?? 0)}</span>
                </div>

                <div className="settings-row">
                  <span className="settings-key">本次启动</span>
                  <span className="settings-val">
                    {diagnostics?.resumed === true ? (
                      <>
                        从磁盘恢复 · 读回 <strong className="mono">{formatNumber(diagnostics.historicalEvents)}</strong> 条历史事件
                      </>
                    ) : (
                      '全新开始 · 还没有历史事件'
                    )}
                  </span>
                </div>

                <div className="settings-row">
                  <span className="settings-key">事件</span>
                  <span className="settings-val mono">
                    内存 {formatNumber(diagnostics?.eventsInMemory ?? 0)} 条 · 未落盘{' '}
                    {formatNumber(diagnostics?.pendingPersistence ?? 0)} 条 · 坏行{' '}
                    {formatNumber(diagnostics?.badLines ?? 0)}
                  </span>
                </div>

                <div className="settings-row">
                  <span className="settings-key">写操作</span>
                  <span className="settings-val">
                    {diagnostics?.allowWrite === true ? (
                      <span className="settings-warn">已开启自动放行（BUTLER_ALLOW_WRITE=1）</span>
                    ) : (
                      '默认拒绝 · 需要确认时会弹窗，允许只对当次生效'
                    )}
                  </span>
                </div>

                <div className="settings-row">
                  <span className="settings-key">本地用户</span>
                  <span className="settings-val mono">{diagnostics?.userId ?? 'local'}</span>
                </div>
              </div>

              <div className="path-block">
                <div className="path-row">
                  <span className="settings-key">数据目录</span>
                  <code className="path mono">{diagnostics?.dataDir ?? '—'}</code>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label="复制数据目录"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(diagnostics?.dataDir ?? '')
                        .then(() => notify('已复制路径', 'success'))
                        .catch(() => notify('复制失败', 'warning'));
                    }}
                  >
                    <Icon name="copy" size={13} />
                  </button>
                </div>
                <div className="path-row">
                  <span className="settings-key">事件文件</span>
                  <code className="path mono">{diagnostics?.eventsFile ?? '—'}</code>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label="复制事件文件路径"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(diagnostics?.eventsFile ?? '')
                        .then(() => notify('已复制路径', 'success'))
                        .catch(() => notify('复制失败', 'warning'));
                    }}
                  >
                    <Icon name="copy" size={13} />
                  </button>
                </div>
              </div>

              {overview.restoreSummary.length > 0 && (
                <details className="disclosure">
                  <summary>启动恢复摘要</summary>
                  <pre className="code-block">{overview.restoreSummary}</pre>
                </details>
              )}

              {diagnostics !== null && (
                <details className="disclosure">
                  <summary>
                    运行诊断
                    {diagnostics.issues > 0 && <Badge tone="warn">{diagnostics.issues} 处信息不足</Badge>}
                  </summary>
                  <pre className="code-block diagnostics-json">
                    {JSON.stringify(
                      {
                        ...diagnostics,
                        restored: diagnostics.restored,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </>
          )}
        </section>

        {/* ── 自动化 / 定时任务（只读） ── */}
        <AutomationPanel />

        {/* ── C5 三档权限 ── */}
        <PermissionsPanel notify={notify} />

        {/* ── 工具分级矩阵 ── */}
        <ToolsPanel />

        {/* ── 操作记忆（只读） ── */}
        <OperationsPanel />

        {/* ── 产出物版本（只读） ── */}
        <ArtifactsPanel />

        {/* ── 隐私 ── */}
        <section className="panel settings-panel">
          <SectionHeading
            title="隐私与行为观察"
            description="默认关闭。只有你显式同意之后，才可能产生任何采样。"
            actions={
              <span className="privacy-pill">
                <Icon name="lock" size={13} /> 本地存储
              </span>
            }
          />

          {obsError !== null && <InlineError message={obsError} onRetry={() => void loadObservation()} />}
          {obsLoading && obs === null && <Skeleton rows={3} height={14} />}

          {consent !== null && (
            <>
              <div className={`consent-card ${consent.granted ? 'is-granted' : ''}`}>
                <div className="consent-main">
                  <span className={`consent-icon ${consent.granted ? 'is-on' : ''}`}>
                    <Icon name={consent.granted ? 'eye' : 'eyeOff'} size={18} />
                  </span>
                  <div>
                    <strong>
                      {consent.granted ? (consent.enabled ? '正在采样' : '已同意 · 当前暂停') : '行为观察未开启'}
                    </strong>
                    <p>
                      {consent.granted
                        ? `每 5 分钟抽样一次前台应用名。已记录 ${formatNumber(consent.recordedBlocks)} 个采样块，聚合 ${formatNumber(
                            consent.aggregates,
                          )} 条。`
                        : '不采样、不读取前台窗口、不产生任何活动记录。'}
                    </p>
                  </div>
                </div>
                <Switch
                  checked={consent.granted && consent.enabled}
                  disabled={obsBusy}
                  label="行为观察开关"
                  onChange={(next) => void toggleObservation(next)}
                />
              </div>

              <ul className="privacy-list">
                <li>
                  <Icon name="check" size={13} />
                  只记录<strong>应用名</strong>与是否有输入，不记录窗口标题、内容或按键。
                </li>
                <li>
                  <Icon name="check" size={13} />
                  采样不是持续监听：固定间隔抽样，不做键盘记录。
                </li>
                <li>
                  <Icon name="check" size={13} />
                  撤回同意会同时清除已采集的原始记录与聚合。
                </li>
              </ul>

              <div className="settings-rows">
                <div className="settings-row">
                  <span className="settings-key">原始记录保留</span>
                  <span className="settings-val retention-row">
                    <span className="select-wrap">
                      <select
                        value={consent.retentionDays}
                        aria-label="原始记录保留天数"
                        disabled={!consent.granted || obsBusy}
                        onChange={(e) => void changeRetention(Number(e.target.value))}
                      >
                        {RETENTION.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      <Icon name="chevronDown" size={13} className="select-chevron" />
                    </span>
                    <span className="settings-muted">到期自动清除，只保留聚合</span>
                  </span>
                </div>
                {consent.granted && consent.grantedAt !== null && (
                  <div className="settings-row">
                    <span className="settings-key">同意时间</span>
                    <span className="settings-val mono">{formatDateTime(consent.grantedAt)}</span>
                  </div>
                )}
              </div>

              {consent.granted && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-ghost-danger"
                  disabled={obsBusy}
                  onClick={() => setRevokeOpen(true)}
                >
                  <Icon name="trash" size={14} /> 撤回同意并清除采集数据
                </button>
              )}
            </>
          )}

          <ActivityDetail notify={notify} />
        </section>

        {/* ── 数据 ── */}
        <section className="panel settings-panel">
          <SectionHeading
            title="数据迁移"
            description="导出是单文件 JSON；导入会用文件里的历史替换当前事件流。"
          />

          <div className="transfer-grid">
            <div className="transfer-card">
              <span className="transfer-icon">
                <Icon name="download" size={18} />
              </span>
              <div className="transfer-text">
                <strong>导出全部</strong>
                <p>事件、记忆、对话与产出物打包成一个 JSON。凭证会自动脱敏并在文件里列出位置；个人信息会保留并标记。</p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void exportData()} disabled={exporting}>
                {exporting ? '准备中…' : '导出'}
              </button>
            </div>

            <div className="transfer-card">
              <span className="transfer-icon">
                <Icon name="upload" size={18} />
              </span>
              <div className="transfer-text">
                <strong>从备份导入</strong>
                <p>导入前服务端会先备份现有事件文件；随后原子替换并重建运行时。</p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file !== undefined) void pickImport(file);
                  e.target.value = '';
                }}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
                选择文件
              </button>
            </div>
          </div>

          {importResult !== null && (
            <div className="import-result">
              <span className="import-result-icon">
                <Icon name="checkCircle" size={17} />
              </span>
              <div>
                <strong>导入完成</strong>
                <p className="mono">
                  {formatNumber(importResult.events)} 条事件 · lastSeq {importResult.lastSeq} · 导出时间{' '}
                  {importResult.exportedAt}
                </p>
                {importResult.restored !== null && (
                  <p>
                    重建出 {importResult.restored.memories} 条记忆 · {importResult.restored.chatSessions} 段对话 ·{' '}
                    {importResult.restored.artifacts} 个产出物
                  </p>
                )}
                {importResult.backup !== null && <p className="mono import-backup">备份：{importResult.backup}</p>}
              </div>
            </div>
          )}
        </section>

        {/* ── MCP 扩展 ── */}
        <McpPanel notify={notify} />

        {/* ── 关于 ── */}
        <section className="panel settings-panel">
          <SectionHeading
            title="关于"
            description="管家式 AI · 可审计的记忆治理与自进化系统"
            actions={<Badge tone="outline">v8 · 本地运行</Badge>}
          />

          <div className="about-layers">
            <div>
              <span className="mono">01</span>
              <strong>分层反思</strong>
              <p>学得对。领域反思的输入里不含其它领域的内容。</p>
            </div>
            <div>
              <span className="mono">02</span>
              <strong>效果跟踪</strong>
              <p>学得可验证。原则记录应用与奏效，效果差会自动降权。</p>
            </div>
            <div>
              <span className="mono">03</span>
              <strong>契约与复核</strong>
              <p>学得不矛盾。干前写判据，干完逐条核对。</p>
            </div>
            <div>
              <span className="mono">04</span>
              <strong>渐进演化</strong>
              <p>学得久而不乱。休眠、归档但不删除，命中可唤醒。</p>
            </div>
          </div>

          <div className="shortcuts">
            <p className="mini-label">快捷键</p>
            <div className="shortcut-row">
              <span><Kbd>⌘</Kbd> / <Kbd>Ctrl</Kbd> + <Kbd>K</Kbd></span>
              <span>快速切换页面与动作</span>
            </div>
            <div className="shortcut-row">
              <span><Kbd>Enter</Kbd></span>
              <span>发送消息</span>
            </div>
            <div className="shortcut-row">
              <span><Kbd>Shift</Kbd> + <Kbd>Enter</Kbd></span>
              <span>换行</span>
            </div>
            <div className="shortcut-row">
              <span><Kbd>Esc</Kbd></span>
              <span>关闭浮层</span>
            </div>
          </div>

          <p className="about-stack">
            Next.js · React · TypeScript · Node.js · 事件溯源（JSONL）· 本地优先
          </p>
        </section>
      </div>

      {/* 同意 */}
      <Modal
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        title="同意行为观察？"
        description="这是可撤回的本地采集。默认关闭，只有你点同意之后才会开始。"
        footer={
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConsentOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" disabled={!consentChecked || obsBusy} onClick={() => void grantConsent()}>
              同意并开启
            </button>
          </div>
        }
      >
        <div className="consent-modal">
          <ul>
            <li>采集内容：前台<strong>应用名</strong>、该时刻是否有输入。不采集窗口标题、内容、截图或按键。</li>
            <li>采集方式：每 5 分钟抽样一次，不是持续监听。</li>
            <li>存储位置：仅本机数据目录；原始记录按保留期限自动清除。</li>
            <li>你的控制：随时可以暂停或撤回；撤回会同时清除已采集的数据。</li>
          </ul>
          <label className="consent-check">
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
            />
            <span>我已了解上述内容，并同意在本机进行行为观察。</span>
          </label>
        </div>
      </Modal>

      {/* 撤回 */}
      <Modal
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        title="撤回同意并清除数据？"
        description="这会停止采样，并删除已采集的原始记录与聚合。"
        footer={
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setRevokeOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn-danger" disabled={obsBusy} onClick={() => void revokeConsent()}>
              撤回并清除
            </button>
          </div>
        }
      >
        <p className="revoke-note">
          撤回之后不会再产生任何活动记录。已聚合出的规律也会一并清除；这条撤回动作本身会留在事件流里，
          作为“你确实撤回过的证据”。
        </p>
      </Modal>

      {/* 导入确认 */}
      <Modal
        open={pendingImport !== null}
        onClose={() => setPendingImport(null)}
        title="用这个备份替换当前历史？"
        description="导入是破坏性操作。服务端会先备份现有事件文件，再原子替换并重建运行时。"
        footer={
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setPendingImport(null)}>
              取消
            </button>
            <button type="button" className="btn btn-danger" disabled={importing} onClick={() => void runImport()}>
              {importing ? '导入中…' : '确认导入'}
            </button>
          </div>
        }
      >
        {pendingImport !== null && (
          <div className="import-confirm">
            <div className="import-file">
              <Icon name="file" size={18} />
              <div>
                <strong>{pendingImport.name}</strong>
                <span className="mono">{(pendingImport.size / 1024).toFixed(1)} KB</span>
              </div>
            </div>
            <p>
              导入后当前的事件流会被文件里的历史替换。记忆、对话与产出物都会按导入的事件重建。
              如果导错了，可以从服务端生成的备份文件恢复。
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}

