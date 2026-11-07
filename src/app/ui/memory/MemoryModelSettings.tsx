'use client';

/**
 * 记忆 · 模型设置
 *
 * 记忆自己的三个模型角色在这里选：抽取、语义嵌入、召回重排。
 * 设置 → 模型接入只管理连接与模型目录，不再承担角色选择。
 *
 * ★ 切嵌入模型会清空记忆语义缓存，所以先确认再提交。
 * ★ 角色为空就是“未配置”：不会静默回退到对话模型。
 */

import { useCallback, useEffect, useState } from 'react';

import { InlineError, Skeleton } from '../components/Common';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import type { ToastMessage } from '../lib/types.js';

type ModelKind = 'chat' | 'embedding' | 'rerank';

interface ModelEntryView {
  readonly id: string;
  readonly kind: ModelKind;
  readonly dimension?: number;
}

interface ProfileView {
  readonly id: string;
  readonly name: string;
  readonly models: readonly ModelEntryView[];
  readonly hasKey: boolean;
  readonly requiresKey?: boolean;
}

interface RoleSelectionView {
  readonly profileId: string;
  readonly modelId: string;
}

type EmbeddingRoleView =
  | {
      readonly kind: 'builtin';
      readonly label: string;
      readonly dimension: number;
    }
  | {
      readonly kind: 'profile';
      readonly profileId: string;
      readonly modelId: string;
      readonly label: string;
      readonly dimension: number;
    };

/** 只取本组件需要的角色字段；其余响应字段不参与渲染。 */
interface ModelRoleResponse {
  readonly profiles: readonly ProfileView[];
  readonly memory: RoleSelectionView | null;
  readonly rerank: RoleSelectionView | null;
  readonly embedding: EmbeddingRoleView;
}

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onChanged: () => void;
}

interface ChatChoice {
  readonly profileId: string;
  readonly profileName: string;
  readonly modelId: string;
  readonly missingKey: boolean;
}

interface EmbeddingChoice {
  readonly profileId: string;
  readonly profileName: string;
  readonly modelId: string;
  readonly dimension: number;
  readonly missingKey: boolean;
}

interface RerankChoice {
  readonly profileId: string;
  readonly profileName: string;
  readonly modelId: string;
  readonly missingKey: boolean;
}

type RoleKind = 'memory' | 'embedding' | 'rerank';

function encodeValue(profileId: string, modelId: string): string {
  return `${profileId}::${modelId}`;
}

function decodeValue(value: string): { readonly profileId: string; readonly modelId: string } | null {
  const [profileId, modelId] = value.split('::');
  if (profileId === undefined || modelId === undefined) return null;
  if (profileId.length === 0 || modelId.length === 0) return null;
  return { profileId, modelId };
}

function embeddingValue(role: EmbeddingRoleView): string {
  return role.kind === 'profile' ? encodeValue(role.profileId, role.modelId) : '';
}

export function MemoryModelSettings({ open, onClose, notify, onChanged }: Props): JSX.Element {
  const [data, setData] = useState<ModelRoleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<RoleKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      setData(await fetchJson<ModelRoleResponse>('/api/model'));
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setActionError(null);
    setNotice(null);
    void load(false);
  }, [open, load]);

  const chatChoices: readonly ChatChoice[] = data === null
    ? []
    : data.profiles.flatMap((profile) =>
        profile.models
          .filter((model) => model.kind === 'chat')
          .map((model) => ({
            profileId: profile.id,
            profileName: profile.name,
            modelId: model.id,
            missingKey: profile.requiresKey === true && !profile.hasKey,
          })),
      );

  const embeddingChoices: readonly EmbeddingChoice[] = data === null
    ? []
    : data.profiles.flatMap((profile) =>
        profile.models
          .filter((model) => model.kind === 'embedding')
          .map((model) => ({
            profileId: profile.id,
            profileName: profile.name,
            modelId: model.id,
            dimension: model.dimension ?? 0,
            missingKey: profile.requiresKey === true && !profile.hasKey,
          })),
      );

  const rerankChoices: readonly RerankChoice[] = data === null
    ? []
    : data.profiles.flatMap((profile) =>
        profile.models
          .filter((model) => model.kind === 'rerank')
          .map((model) => ({
            profileId: profile.id,
            profileName: profile.name,
            modelId: model.id,
            missingKey: profile.requiresKey === true && !profile.hasKey,
          })),
      );

  const memory = data?.memory ?? null;
  const rerank = data?.rerank ?? null;
  const memoryProfile = memory === null
    ? null
    : data?.profiles.find((profile) => profile.id === memory.profileId) ?? null;
  const rerankProfile = rerank === null
    ? null
    : data?.profiles.find((profile) => profile.id === rerank.profileId) ?? null;
  const embeddingProfileId = data !== null && data.embedding.kind === 'profile'
    ? data.embedding.profileId
    : null;
  const embeddingProfile = embeddingProfileId === null
    ? null
    : data?.profiles.find((profile) => profile.id === embeddingProfileId) ?? null;

  async function submit(kind: RoleKind, body: unknown, message: string): Promise<void> {
    setBusy(kind);
    setActionError(null);
    setNotice(null);
    try {
      await postJson('/api/model', body);
      await load(true);
      setNotice(message);
      notify(message, 'success');
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveMemory(value: string): Promise<void> {
    if (value === '') {
      if (memory === null) return;
      await submit('memory', { action: 'clear-memory' }, '记忆抽取模型已清空；不会自动回退到对话模型。');
      return;
    }
    const choice = decodeValue(value);
    if (choice === null) return;
    if (memory !== null && memory.profileId === choice.profileId && memory.modelId === choice.modelId) return;
    await submit(
      'memory',
      { action: 'set-memory', profileId: choice.profileId, modelId: choice.modelId },
      '记忆抽取模型已更新。',
    );
  }

  async function saveEmbedding(value: string): Promise<void> {
    if (data === null) return;
    const current = embeddingValue(data.embedding);
    if (value === current) return;
    const target = value === ''
      ? '本地 BGE（768 维，离线）'
      : embeddingChoices.find((choice) => encodeValue(choice.profileId, choice.modelId) === value)?.modelId ?? value;
    const confirmed = typeof window === 'undefined'
      ? false
      : window.confirm(
          `切换记忆语义嵌入模型到「${target}」？\n\n切换会清空已有的记忆语义缓存，下次召回时用新模型重新生成；期间语义召回可能暂时退回字面召回。`,
        );
    if (!confirmed) return;

    if (value === '') {
      await submit('embedding', { action: 'set-embedding', mode: 'builtin' }, '记忆语义嵌入模型已切换为本地 BGE；语义缓存已清空。');
      return;
    }
    const choice = decodeValue(value);
    if (choice === null) return;
    await submit(
      'embedding',
      { action: 'set-embedding', profileId: choice.profileId, modelId: choice.modelId },
      '记忆语义嵌入模型已切换；语义缓存已清空，下次召回时重新生成。',
    );
  }

  async function saveRerank(value: string): Promise<void> {
    if (value === '') {
      if (rerank === null) return;
      await submit('rerank', { action: 'clear-rerank' }, '重排模型已清空；恢复为本地 embedding 重排。');
      return;
    }
    const choice = decodeValue(value);
    if (choice === null) return;
    if (rerank !== null && rerank.profileId === choice.profileId && rerank.modelId === choice.modelId) return;
    await submit(
      'rerank',
      { action: 'set-rerank', profileId: choice.profileId, modelId: choice.modelId },
      '记忆召回重排模型已更新。',
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="记忆模型设置"
      description="只影响记忆抽取、语义嵌入与召回重排；对话模型仍由输入框右下角选择。"
      footer={
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>
        </div>
      }
    >
      {loading && data === null ? (
        <Skeleton rows={4} height={16} />
      ) : loadError !== null || data === null ? (
        <InlineError
          message={`读取记忆模型设置失败：${loadError ?? '状态为空'}`}
          onRetry={() => void load(false)}
        />
      ) : (
        <div className="mms">
          <div className="mms-role">
            <h4 className="mms-role-title">记忆抽取模型</h4>
            <select
              className="mms-role-select"
              value={memory === null ? '' : encodeValue(memory.profileId, memory.modelId)}
              disabled={busy !== null}
              aria-label="选择记忆抽取模型"
              onChange={(event) => void saveMemory(event.target.value)}
            >
              <option value="">未配置</option>
              {chatChoices.map((choice) => (
                <option
                  key={encodeValue(choice.profileId, choice.modelId)}
                  value={encodeValue(choice.profileId, choice.modelId)}
                  disabled={choice.missingKey}
                >
                  {choice.profileName} · {choice.modelId}{choice.missingKey ? ' · 缺少 Key' : ''}
                </option>
              ))}
            </select>
            <p className="mms-role-note">
              {memory === null
                ? '未配置：记忆抽取不会自动回退到对话模型。'
                : `当前来自配置「${memoryProfile?.name ?? '已删除的配置'}」· 对话模型。`}
            </p>
          </div>

          <div className="mms-role">
            <h4 className="mms-role-title">记忆语义嵌入模型</h4>
            <select
              className="mms-role-select"
              value={embeddingValue(data.embedding)}
              disabled={busy !== null}
              aria-label="选择记忆语义嵌入模型"
              onChange={(event) => void saveEmbedding(event.target.value)}
            >
              <option value="">本地 BGE · 768 维</option>
              {embeddingChoices.map((choice) => (
                <option
                  key={encodeValue(choice.profileId, choice.modelId)}
                  value={encodeValue(choice.profileId, choice.modelId)}
                  disabled={choice.missingKey || choice.dimension <= 0}
                >
                  {choice.modelId} · {choice.profileName}
                  {choice.dimension > 0 ? ` · ${choice.dimension} 维` : ' · 未设维度'}
                  {choice.missingKey ? ' · 缺少 Key' : ''}
                </option>
              ))}
            </select>
            <p className="mms-role-note">
              {data.embedding.kind === 'builtin'
                ? `来源：本地 · ${data.embedding.dimension} 维 · 离线；切换会清空语义缓存。`
                : `来源：远程配置「${embeddingProfile?.name ?? '已删除的配置'}」· ${data.embedding.dimension} 维；切换会清空语义缓存。`}
            </p>
          </div>

          <div className="mms-role">
            <h4 className="mms-role-title">记忆召回重排模型</h4>
            <select
              className="mms-role-select"
              value={rerank === null ? '' : encodeValue(rerank.profileId, rerank.modelId)}
              disabled={busy !== null}
              aria-label="选择记忆召回重排模型"
              onChange={(event) => void saveRerank(event.target.value)}
            >
              <option value="">本地 embedding 重排</option>
              {rerankChoices.map((choice) => (
                <option
                  key={encodeValue(choice.profileId, choice.modelId)}
                  value={encodeValue(choice.profileId, choice.modelId)}
                  disabled={choice.missingKey}
                >
                  {choice.profileName} · {choice.modelId}{choice.missingKey ? ' · 缺少 Key' : ''}
                </option>
              ))}
            </select>
            <p className="mms-role-note">
              {rerank === null
                ? '当前：本地 embedding 重排 · 用本地向量打分，不调用外部模型。'
                : `当前：外部 LLM 重排 · 配置「${rerankProfile?.name ?? '已删除的配置'}」· OpenAI 兼容精排。`}
            </p>
          </div>

          {actionError !== null && <p className="model-error">{actionError}</p>}
          {notice !== null && <p className="model-notice">{notice}</p>}
          {busy !== null && <p className="mms-note">正在保存…</p>}
          {chatChoices.length === 0 && (
            <p className="mms-note">还没有可用的对话模型连接；先到 设置 → 模型接入 添加连接。</p>
          )}
          {rerankChoices.length === 0 && (
            <p className="mms-note">当前没有外部重排模型连接；本地 embedding 重排仍然可用。</p>
          )}
          <p className="mms-note">这里只显示模型与所属配置，不显示也不读取 Key。</p>
        </div>
      )}
    </Modal>
  );
}
