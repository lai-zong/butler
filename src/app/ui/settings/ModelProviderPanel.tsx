'use client';

/**
 * 设置 · 模型接入
 *
 * 一个配置 = 一条连接 + 它的模型目录。
 * 这一页只回答“能连上谁、它提供哪些模型”，不再承担任何角色选择：
 *   · 对话模型在对话输入框右下角选择；
 *   · 记忆的三个模型在记忆页「模型设置」里选择；
 *   · 知识库的嵌入/重排/索引在文档库「检索设置」里管理。
 *
 * 没有 per-profile 默认模型；API Key 只在首次输入时完整显示，保存后只显示掩码。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { InlineError, Skeleton } from '../components/Common';
import { TtsSettingsSection, type TtsRoleView, type TtsProfile } from './TtsSettingsSection';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import type { LocalModelView, ToastMessage } from '../lib/types.js';

type CapabilityKey = 'vision' | 'imageGeneration' | 'audio' | 'tools' | 'reasoning';
type ModelKind = 'chat' | 'embedding' | 'rerank' | 'tts';

interface ProfileModelView {
  readonly id: string;
  readonly kind: ModelKind;
  readonly capabilities: Readonly<Record<CapabilityKey, boolean>>;
  readonly dimension?: number;
}

interface ProfileView {
  readonly id: string;
  readonly name: string;
  readonly presetId: string;
  readonly baseUrl: string;
  readonly models: readonly ProfileModelView[];
  readonly hasKey: boolean;
  readonly keySource: 'env' | 'vault' | 'none';
  readonly requiresKey?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ModelPreset {
  readonly id: string;
  readonly label: string;
  readonly kind: ModelKind;
  readonly baseUrl: string;
  readonly adapter: 'deepseek' | 'openai' | 'ollama' | 'mimo';
  readonly requiresKey: boolean;
}

/**
 * 只读取连接与模型目录；memory/rerank/embedding 等角色字段不再由本页使用。
 * localModels 是随程序提供的只读资产（本地 BGE 嵌入 / 重排），
 * 它们必须像模型一样出现在对应页签，但不能当成连接来编辑。
 */
interface ModelResponse {
  readonly profiles: readonly ProfileView[];
  readonly presets: readonly ModelPreset[];
  readonly localModels: readonly LocalModelView[];
  readonly tts: TtsRoleView | null;
  readonly ttsVoices: readonly { readonly id: string; readonly label: string }[];
  readonly ttsVoicesByPreset?: Readonly<Record<string, readonly { readonly id: string; readonly label: string }[]>>;
}

interface DiscoverResponse {
  readonly models: readonly string[];
}

interface Props {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onRefreshOverview: () => void;
}

const CAPABILITIES: readonly { readonly key: CapabilityKey; readonly label: string }[] = [
  { key: 'vision', label: '图像理解' },
  { key: 'imageGeneration', label: '图像生成' },
  { key: 'audio', label: '音频' },
  { key: 'tools', label: '工具调用' },
  { key: 'reasoning', label: '推理' },
];

const EMPTY_CAPS: Record<CapabilityKey, boolean> = {
  vision: false,
  imageGeneration: false,
  audio: false,
  tools: false,
  reasoning: false,
};

const KEY_SOURCE_LABEL: Record<ProfileView['keySource'], string> = {
  env: '环境变量',
  vault: '本机凭证库',
  none: '未配置',
};

function sourceLabel(source: ProfileView['keySource']): string {
  return KEY_SOURCE_LABEL[source];
}

function kindLabel(kind: ModelKind): string {
  return kind === 'chat' ? '对话' : kind === 'embedding' ? '嵌入' : kind === 'rerank' ? '重排' : '语音';
}

export function ModelProviderPanel({ notify, onRefreshOverview }: Props): JSX.Element {
  const [data, setData] = useState<ModelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<'overview' | 'form'>('overview');
  const [modelType, setModelType] = useState<ModelKind>('chat');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [presetId, setPresetId] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyEditing, setKeyEditing] = useState(false);
  const [models, setModels] = useState<readonly ProfileModelView[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [discovered, setDiscovered] = useState<readonly string[]>([]);
  const [discoverBusy, setDiscoverBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchJson<ModelResponse>('/api/model');
      setData(next);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const editingProfile = data?.profiles.find((p) => p.id === editingId) ?? null;

  const filteredDiscovered = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (q.length === 0) return discovered;
    return discovered.filter((id) => id.toLowerCase().includes(q));
  }, [discovered, modelQuery]);

  function resetForm(): void {
    setEditingId(null);
    setPresetId('');
    setName('');
    setBaseUrl('');
    setApiKey('');
    setKeyEditing(false);
    setModels([]);
    setModelQuery('');
    setDiscovered([]);
    setActionError(null);
    setNotice(null);
    setView('form');
  }

  function editProfile(profile: ProfileView): void {
    setEditingId(profile.id);
    const nextType = profile.models.some((m) => m.kind === modelType)
      ? modelType
      : profile.models[0]?.kind ?? 'chat';
    setModelType(nextType);
    setPresetId(profile.presetId);
    setName(profile.name);
    setBaseUrl(profile.baseUrl);
    setApiKey('');
    setKeyEditing(false);
    setModels(profile.models);
    setModelQuery('');
    setDiscovered([]);
    setActionError(null);
    setNotice(null);
    setView('form');
  }

  function choosePreset(id: string): void {
    setPresetId(id);
    const preset = data?.presets.find((p) => p.id === id);
    if (preset !== undefined) {
      setBaseUrl(preset.baseUrl);
      if (name.trim().length === 0) setName(preset.label);
    }
  }

  async function discover(): Promise<void> {
    if (presetId.length === 0) {
      setActionError('先选择一个预设，再获取模型。');
      return;
    }
    if (baseUrl.trim().length === 0) {
      setActionError('先填写 Base URL。');
      return;
    }
    setDiscoverBusy(true);
    setActionError(null);
    try {
      const res = await postJson<DiscoverResponse>('/api/model', {
        action: 'discover',
        presetId,
        baseUrl: baseUrl.trim(),
        ...(editingId !== null ? { profileId: editingId } : {}),
        ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      });
      setDiscovered(res.models);
      if (res.models.length === 0) {
        setActionError('端点没有返回模型；可以在下方手动输入模型 ID。');
      }
    } catch (err) {
      setActionError(`获取模型失败：${errorMessage(err)}`);
    } finally {
      setDiscoverBusy(false);
    }
  }

  function addModel(id: string): void {
    const modelId = id.trim();
    if (modelId.length === 0 || models.some((m) => m.id === modelId)) return;
    setModels((prev) => [
      ...prev,
      {
        id: modelId,
        kind: modelType,
        capabilities: { ...EMPTY_CAPS },
        ...(modelType === 'embedding' ? { dimension: 1536 } : {}),
      },
    ]);
  }

  function addManualModel(): void {
    const id = modelQuery.trim();
    if (id.length > 0) addModel(id);
  }

  function toggleCapability(modelId: string, key: CapabilityKey): void {
    setModels((prev) =>
      prev.map((m) =>
        m.id === modelId
          ? { ...m, capabilities: { ...m.capabilities, [key]: !m.capabilities[key] } }
          : m,
      ),
    );
  }

  async function save(): Promise<void> {
    if (presetId.length === 0) {
      setActionError('请选择预设。');
      return;
    }
    if (name.trim().length === 0) {
      setActionError('请填写配置名称。');
      return;
    }
    if (baseUrl.trim().length === 0) {
      setActionError('请填写 Base URL。');
      return;
    }
    if (models.length === 0) {
      setActionError('至少添加一个模型。');
      return;
    }
    const preset = data?.presets.find((p) => p.id === presetId);
    if (editingId === null && preset?.requiresKey === true && apiKey.trim().length === 0) {
      setActionError('这个预设需要 API Key。');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const payload = {
        action: editingId === null ? 'create-profile' : 'update-profile',
        ...(editingId !== null ? { id: editingId } : {}),
        name: name.trim(),
        presetId,
        baseUrl: baseUrl.trim(),
        models,
        ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
        activate: false,
      };
      await postJson('/api/model', payload);
      notify(editingId === null ? '模型配置已创建' : '模型配置已更新', 'success');
      setNotice('已保存。');
      setApiKey('');
      setView('overview');
      await load();
      onRefreshOverview();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeProfile(profile: ProfileView): Promise<void> {
    if (typeof window !== 'undefined' && !window.confirm(`删除「${profile.name}」？`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await postJson('/api/model', { action: 'delete-profile', id: profile.id });
      notify('模型配置已删除', 'success');
      setView('overview');
      await load();
      onRefreshOverview();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading && data === null) {
    return (
      <section className="model-settings-page">
        <Skeleton rows={4} height={16} />
      </section>
    );
  }

  if (loadError !== null || data === null) {
    return (
      <section className="model-settings-page">
        <InlineError message={`读取模型配置失败：${loadError ?? '状态为空'}`} onRetry={() => void load()} />
      </section>
    );
  }

  if (view === 'form') {
    return (
      <section className="model-settings-page">
        <div className="model-form-head">
          <div>
            <p className="model-eyebrow">{editingId === null ? 'NEW CONNECTION' : 'EDIT CONNECTION'}</p>
            <h3>{editingId === null ? '新增模型配置' : '编辑模型配置'}</h3>
            <p>预设只填入连接信息；模型和模型能力由你确认。</p>
          </div>
          <button type="button" className="model-back" onClick={() => { setView('overview'); setActionError(null); }}>
            ← 返回模型接入
          </button>
        </div>

        <div className="model-form-card">
          <div className="model-form-top">
            <label className="model-field">
              <span>预设</span>
              <select value={presetId} onChange={(e) => choosePreset(e.target.value)}>
                <option value="">选择预设</option>
                {data.presets
                  .filter(
                    (preset) =>
                      preset.kind === modelType ||
                      (modelType === 'rerank' && preset.id === presetId),
                  )
                  .map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.label}</option>
                  ))}
              </select>
              <small>不提供“自定义”；未覆盖的端点可选择一个兼容预设后修改 Base URL。</small>
            </label>
            <label className="model-field">
              <span>配置名称</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：OpenRouter · 工作" />
              <small>名称唯一，显示在配置列表里。</small>
            </label>
          </div>

          <label className="model-field">
            <span>Base URL</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
            <small>需要兼容 OpenAI 风格的 /v1/chat/completions。</small>
          </label>

          <label className="model-field">
            <span>API Key</span>
            <div className="model-key-row">
              {editingProfile?.hasKey === true && !keyEditing ? (
                <>
                  <input value="••••••••••••••••" readOnly aria-label="已保存的 API Key" />
                  <span className="model-key-state">已保存 · {sourceLabel(editingProfile.keySource)}</span>
                  <button type="button" className="model-key-edit" onClick={() => setKeyEditing(true)}>
                    更换 Key
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="text"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={editingProfile?.hasKey === true ? '输入新的 API Key' : '粘贴 API Key'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {editingProfile?.hasKey === true && (
                    <button
                      type="button"
                      className="model-key-edit"
                      onClick={() => {
                        setKeyEditing(false);
                        setApiKey('');
                      }}
                    >
                      取消更换
                    </button>
                  )}
                </>
              )}
            </div>
            <small>
              {editingId === null
                ? '首次输入会完整显示；保存后仅保留掩码，接口不会再次返回完整 Key。'
                : keyEditing
                  ? '输入新的 Key；保存后再次隐藏。'
                  : '完整 Key 不会再次返回；需要更换时点击“更换 Key”。'}
            </small>
          </label>

          <div className="model-model-section">
            <div className="model-model-head">
              <div>
                <span className="model-field-label">模型</span>
                <p>从端点读取，或手动输入模型 ID。</p>
              </div>
              <div className="model-model-actions">
                <input
                  className="model-search"
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                  placeholder="搜索或输入模型 ID"
                />
                <button type="button" className="model-ghost" disabled={discoverBusy} onClick={() => void discover()}>
                  {discoverBusy ? '获取中…' : '获取模型'}
                </button>
              </div>
            </div>

            {filteredDiscovered.length > 0 && (
              <div className="model-results">
                {filteredDiscovered.map((id) => (
                  <div className="model-result" key={id}>
                    <code>{id}</code>
                    <button type="button" className="model-add" onClick={() => addModel(id)}>＋</button>
                  </div>
                ))}
              </div>
            )}
            {filteredDiscovered.length === 0 && discovered.length > 0 && (
              <p className="model-muted">没有匹配的模型。</p>
            )}

            <div className="model-selected-head">
              <span>已选择模型</span>
              <button type="button" className="model-text-btn" onClick={addManualModel}>
                添加当前输入为模型 ID
              </button>
            </div>
            {models.length === 0 ? (
              <p className="model-empty">还没有选择模型。点击搜索结果旁的“＋”加入。</p>
            ) : (
              <div className="model-selected-list">
                {models.map((model) => (
                  <div className="model-selected" key={model.id}>
                    <div className="model-selected-top">
                      <code>{model.id}</code>
                      <span className="model-kind-badge">{kindLabel(model.kind)}</span>
                      <button type="button" className="model-remove" aria-label={`移除 ${model.id}`} onClick={() => setModels((prev) => prev.filter((m) => m.id !== model.id))}>
                        ×
                      </button>
                    </div>
                    {model.kind === 'chat' ? (
                      <div className="model-caps">
                        <span className="model-caps-label">能力</span>
                        {CAPABILITIES.map((cap) => (
                          <button
                            key={cap.key}
                            type="button"
                            className={`model-cap${model.capabilities[cap.key] ? ' is-on' : ''}`}
                            onClick={() => toggleCapability(model.id, cap.key)}
                          >
                            {model.capabilities[cap.key] ? '✓ ' : ''}{cap.label}
                          </button>
                        ))}
                      </div>
                    ) : model.kind === 'embedding' ? (
                      <label className="model-dimension">
                        <span>向量维度</span>
                        <input
                          type="number"
                          min={1}
                          value={model.dimension ?? 1536}
                          onChange={(e) => {
                            const value = Math.max(1, Number(e.target.value) || 1);
                            setModels((prev) => prev.map((m) => (m.id === model.id ? { ...m, dimension: value } : m)));
                          }}
                        />
                        <small>必须和端点实际输出维度一致</small>
                      </label>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {actionError !== null && <p className="model-error">{actionError}</p>}
          {notice !== null && <p className="model-notice">{notice}</p>}
          <div className="model-form-actions">
            {editingProfile !== null && (
              <button type="button" className="model-danger" disabled={busy} onClick={() => void removeProfile(editingProfile)}>
                删除配置
              </button>
            )}
            <button type="button" className="model-ghost" onClick={() => setView('overview')}>取消</button>
            <button type="button" className="model-primary" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </section>
    );
  }

  const typedProfiles = data.profiles
    .map((profile) => ({
      ...profile,
      models: profile.models.filter((m) => m.kind === modelType),
    }))
    .filter((profile) => profile.models.length > 0);
  /** 本地资产按页签归属展示；对话页没有本地资产时自然为空。 */
  const localModels = data.localModels.filter((model) => model.kind === modelType);
  const typeLabel =
    modelType === 'chat'
      ? '对话模型'
      : modelType === 'embedding'
        ? '嵌入模型'
        : modelType === 'rerank'
          ? '重排模型'
          : '语音模型';

  return (
    <section className="model-settings-page">
      {actionError !== null && <p className="model-error">{actionError}</p>}

      <div className="model-type-tabs" role="tablist" aria-label="模型类型">
        {([
          ['chat', '对话模型'],
          ['embedding', '嵌入模型'],
          ['rerank', '重排模型'],
          ['tts', '语音模型'],
        ] as const).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={modelType === kind}
            className={`model-type-tab${modelType === kind ? ' is-active' : ''}`}
            onClick={() => setModelType(kind)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="model-type-head">
        <h3>{typeLabel}</h3>
        <span className="model-muted">
          {localModels.length > 0 ? `${localModels.length} 个本地 · ` : ''}
          {typedProfiles.length} 个外部配置
        </span>
        <button type="button" className="model-primary" onClick={resetForm}>＋ 新增配置</button>
      </div>


      {localModels.length > 0 && (
        <div className="model-local-block">
          <div className="model-local-head">
            <span className="model-field-label">本地模型</span>
          </div>
          <div className="model-local-list">
            {localModels.map((model) => (
              <article className="model-local-card" key={model.id}>
                <div className="model-local-main">
                  <strong>{model.label}</strong>
                  <div className="model-local-tags">
                    <span className="model-kind-badge">{kindLabel(model.kind)}</span>
                    <span className="model-local-source">本地</span>
                    {model.dimension !== null && <span>{model.dimension} 维</span>}
                  </div>
                </div>
                <span className={`model-local-state${model.available ? ' is-ready' : ''}`}>
                  {model.available ? '可用' : '不可用'}
                </span>
              </article>
            ))}
          </div>
        </div>
      )}

      {typedProfiles.length > 0 && (
        <div className="model-profile-block">
          <div className="model-local-head">
            <span className="model-field-label">外部连接</span>
          </div>
          <div className="model-profile-list">
            {typedProfiles.map((profile) => (
              <div className="model-profile" key={profile.id}>
                <div className="model-profile-main">
                  <strong>{profile.name}</strong>
                  <span>{profile.models.length} 个模型 · {profile.baseUrl}</span>
                </div>
                <span className="model-profile-meta">
                  {profile.hasKey ? sourceLabel(profile.keySource) : '未配置 Key'}
                </span>
                <button type="button" className="model-row-btn" onClick={() => editProfile(profile)}>编辑</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {typedProfiles.length === 0 && (
        <div className="model-empty-state">
          <p>
            {modelType === 'rerank'
              ? '还没有外部 LLM 重排连接。本地重排模型不依赖连接，始终可用。'
              : `还没有${typeLabel}连接。添加一条连接后，这里会列出它提供的${typeLabel}。`}
          </p>
          {modelType === 'rerank' && (
            <p className="model-empty-detail">
              外部重排是用 OpenAI 兼容 LLM 对候选片段精排，不是专用 rerank HTTP 协议；
              只有端点确实支持对话补全时才添加。
            </p>
          )}
          <button type="button" className="model-primary" onClick={resetForm}>添加连接</button>
        </div>
      )}


      {modelType === 'tts' ? (
        <TtsSettingsSection
          profiles={data.profiles as unknown as readonly TtsProfile[]}
          role={data.tts}
          voices={data.ttsVoices}
          {...(data.ttsVoicesByPreset !== undefined ? { voicesByPreset: data.ttsVoicesByPreset } : {})}
          notify={notify}
          onChanged={load}
        />
      ) : null}
    </section>
  );
}
