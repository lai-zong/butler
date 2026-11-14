'use client';

/**
 * 设置空间 —— 模型、知识、数据迁移
 *
 * ★ 这里不再有“整机行为观察”，也不放使用节奏：后者只属于控制台。
 *   设置页只保留真正需要配置的东西，不做使用数据的第二个入口。
 *
 * ★ 每一项都必须**真的能用**：
 *   导入导出调用 /api/transfer/*，MCP 面板调用 /api/mcp，
 *   不放“看起来像设置”的摆设。
 *
 * ★ 分区按需挂载：除模型接入外，面板只在被选中时渲染。
 *   以前七个分区用 hidden 常驻，进设置页就同时打出模型 / MCP / 文档 / 桌宠 /
 *   权限五个请求——用户看不见，机器却一直在干活。请求都发在面板自己的
 *   useEffect 里，不渲染就不发。
 */

import { useEffect, useRef, useState } from 'react';

import { PageHeader, SectionHeading } from '../components/Common';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { AutomationPanel } from './AutomationPanel';
import { PetSettingsPanel } from './PetSettingsPanel';
import { PermissionsPanel } from './PermissionsPanel';
import { McpPanel } from './McpPanel';
import { DocumentsPanel } from './DocumentsPanel';
import { ModelProviderPanel } from './ModelProviderPanel';
import { TrashPanel } from './TrashPanel';
import { errorMessage, fetchJson } from '../lib/api.js';
import { formatNumber } from '../lib/format.js';
import type { ToastMessage } from '../lib/types.js';

interface SettingsViewProps {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onRefreshOverview: () => void;
  readonly onDataReset: () => void;
}

type SettingsPage =
  | 'model'
  | 'automation'
  | 'pet'
  | 'security'
  | 'knowledge'
  | 'transfer'
  | 'trash'
  | 'mcp';

const SETTINGS_NAV: readonly {
  readonly label: string;
  readonly items: readonly { readonly id: SettingsPage; readonly label: string }[];
}[] = [
  {
    label: '运行',
    items: [
      { id: 'model', label: '模型接入' },
      { id: 'automation', label: '自动化' },
      { id: 'pet', label: '网页桌宠' },
    ],
  },
  {
    label: '治理',
    items: [
      { id: 'security', label: '权限与自主' },
      { id: 'knowledge', label: '知识库' },
      { id: 'transfer', label: '数据迁移' },
    ],
  },
  {
    label: '系统',
    items: [
      // 回收站放在「系统」组的第一个位置：渲染出来紧挨着上面「数据迁移」的末尾。
      // 两者都属于"数据去哪了"这一族问题，但回收站处理的是磁盘文件，不是可迁移的数据。
      { id: 'trash', label: '回收站' },
      { id: 'mcp', label: 'MCP 扩展' },
    ],
  },
];

function SettingsPageHead({
  eyebrow,
  title,
  description,
  actions,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
  readonly actions?: JSX.Element;
}): JSX.Element {
  return (
    <header className="settings-content-head">
      <div>
        {eyebrow !== undefined && <p className="settings-content-eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions !== undefined && <div className="settings-content-actions">{actions}</div>}
    </header>
  );
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

export function SettingsView({
  notify,
  onRefreshOverview,
  onDataReset,
}: SettingsViewProps): JSX.Element {
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('model');
  const settingsPageRef = useRef<HTMLDivElement | null>(null);
  const settingsPageMountedRef = useRef(false);

  const [exporting, setExporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ name: string; size: number; text: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportedSummary | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!settingsPageMountedRef.current) {
      settingsPageMountedRef.current = true;
      return;
    }
    settingsPageRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [settingsPage]);

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
    } catch (err) {
      notify(errorMessage(err), 'danger');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="page settings-page" ref={settingsPageRef}>
      <PageHeader
        title="设置"
        description="本地优先。记忆、对话与事件都在这台电脑上；密钥不会出现在任何界面与导出文件里。"
      />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置导航">
          {SETTINGS_NAV.map((group) => (
            <div className="settings-nav-group" key={group.label}>
              <p className="settings-nav-label">{group.label}</p>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`settings-nav-item${settingsPage === item.id ? ' is-active' : ''}`}
                  aria-current={settingsPage === item.id ? 'page' : undefined}
                  onClick={() => setSettingsPage(item.id)}
                >
                  <span className="settings-nav-dot" />
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="settings-content">
          {/* ★ 模型接入是唯一保留常驻的分区：面板内部是一张跨步骤的连接编辑表，
              从选预设、填 Base URL / API Key 到勾选模型都在组件自己的 state 里。
              切走再切回如果重新挂载，用户填了一半的草稿会静默消失（Key 还要重贴）；
              而它又是设置页的默认分区，进设置本来就要请求 /api/model，
              常驻不会多出请求，面板内也没有轮询。 */}
          <div className="settings-page-view" hidden={settingsPage !== 'model'}>
            <SettingsPageHead
              title="模型接入"
              description="按模型类型管理连接；对话、记忆与知识库在各自功能页选择用哪个模型。"
            />
            <ModelProviderPanel notify={notify} onRefreshOverview={onRefreshOverview} />
          </div>

          {settingsPage === 'automation' && (
            <div className="settings-page-view">
              <AutomationPanel />
            </div>
          )}

          {/* ── 网页桌宠 ── */}
          {settingsPage === 'pet' && (
            <div className="settings-page-view">
              <SettingsPageHead
                eyebrow="PET"
                title="网页桌宠"
                description="网页桌宠显示在页面右下角；这里保存它读取的形象、大小、模型与人格偏好。"
              />
              <PetSettingsPanel notify={notify} />
            </div>
          )}

          {settingsPage === 'security' && (
            <div className="settings-page-view">
              <SettingsPageHead
                eyebrow="ACCESS"
                title="权限与自主"
                description="决定 butler 能在本机做到哪一层；切换立即生效并持久化。"
              />
              <PermissionsPanel notify={notify} />
            </div>
          )}

          {settingsPage === 'knowledge' && (
            <div className="settings-page-view">
              <SettingsPageHead
                eyebrow="KNOWLEDGE"
                title="知识库"
                description="上传文档用于检索；检索模式、嵌入模型与索引在文档库的「检索设置」里管理。"
              />
              <DocumentsPanel notify={notify} />
            </div>
          )}

          {/* ── 数据 ── */}
          {settingsPage === 'transfer' && (
            <div className="settings-page-view">
              <SettingsPageHead
                eyebrow="TRANSFER"
                title="数据迁移"
                description="导出是单文件 JSON；导入会用文件里的历史替换当前事件流。"
              />
              <section className="panel settings-panel">
                <SectionHeading
                  title="备份与恢复"
                  description="迁移前先备份；导入是原子替换。"
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
            </div>
          )}

          {/* ── 回收站 ── */}
          {/* ★ 与「数据迁移」相邻但语义不同：回收站里的文件不进导出、不参与迁移，
              所以不给它一个"备份"的暗示，描述里只说恢复与原路径。 */}
          {settingsPage === 'trash' && (
            <div className="settings-page-view">
              <SettingsPageHead
                eyebrow="TRASH"
                title="回收站"
                description="模型替你删除的工作区文件先放在这里；恢复会放回原路径，彻底删除不可恢复。"
              />
              <TrashPanel notify={notify} />
            </div>
          )}

          {/* ── MCP 扩展 ── */}
          {settingsPage === 'mcp' && (
            <div className="settings-page-view">
              <McpPanel notify={notify} />
            </div>
          )}
        </div>
      </div>

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
