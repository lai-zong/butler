'use client';

/**
 * 知识库 · 检索设置
 *
 * 知识库自己的检索模式、嵌入模型、重排开关与向量索引。
 * 这是知识库自己的检索域设置，不与其它功能共用一个面板。
 *
 * ★ 换嵌入模型后旧索引会失效：只提示“需要重建索引”，不假装已经生效。
 * ★ 本地重排模型不存在时，不允许把开关打开。
 */

import { useCallback, useEffect, useState } from 'react';

import { InlineError, Skeleton } from '../components/Common';
import { Modal } from '../components/Modal';
import { Switch } from '../components/Switch';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import { formatDateTime, formatNumber } from '../lib/format.js';
import type {
  KnowledgeEmbeddingChoice,
  KnowledgeEmbeddingView,
  KnowledgeRetrievalMode,
  KnowledgeRetrievalMutationResponse,
  KnowledgeRetrievalResponse,
  ToastMessage,
} from '../lib/types.js';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}

type BusyKind = 'mode' | 'embedding' | 'rerank' | 'rebuild';

const MODES: readonly {
  readonly mode: KnowledgeRetrievalMode;
  readonly label: string;
  readonly detail: string;
}[] = [
  {
    mode: 'hybrid',
    label: '混合检索（推荐）',
    detail: '字面优先、语义补足；条款号与数字不会被语义分数挤下去。',
  },
  {
    mode: 'lexical',
    label: '字面检索',
    detail: '只按关键词与短语匹配，不需要向量索引。',
  },
  {
    mode: 'semantic',
    label: '纯语义检索',
    detail: '只按语义相似度排序；需要语义索引就绪。',
  },
];

function modeLabel(mode: KnowledgeRetrievalMode): string {
  return MODES.find((item) => item.mode === mode)?.label ?? mode;
}

function choiceKey(choice: KnowledgeEmbeddingChoice): string {
  return choice.kind === 'profile'
    ? `profile:${choice.profileId ?? ''}:${choice.modelId ?? ''}`
    : 'builtin';
}

function choiceDisabledReason(choice: KnowledgeEmbeddingChoice): string | null {
  if (choice.kind === 'builtin') return null;
  if (choice.dimension <= 0) return '未设维度';
  if (choice.requiresKey === true && choice.hasKey !== true) return '缺少 Key';
  return null;
}

function isCurrentEmbedding(
  current: KnowledgeEmbeddingView,
  choice: KnowledgeEmbeddingChoice,
): boolean {
  if (choice.kind === 'builtin') return current.kind === 'builtin';
  return current.kind === 'profile'
    && current.profileId === choice.profileId
    && current.modelId === choice.modelId;
}

/** 当前嵌入模型名要作为主视觉：这里只取模型名，来源与维度留给小字。 */
function currentEmbeddingName(data: KnowledgeRetrievalResponse): string {
  const embedding = data.config.embedding;
  return embedding.kind === 'builtin' ? embedding.label : embedding.modelId;
}

function currentEmbeddingMeta(data: KnowledgeRetrievalResponse): string {
  const embedding = data.config.embedding;
  if (embedding.kind === 'builtin') {
    return `本地 · 离线 · ${embedding.dimension} 维`;
  }
  const choice = data.choices.find(
    (item) => item.kind === 'profile' && item.profileId === embedding.profileId,
  );
  return `远程 · ${embedding.dimension} 维 · ${choice?.profileName ?? '未找到配置'}`;
}

export function KnowledgeRetrievalSettings({ open, onClose, notify }: Props): JSX.Element {
  const [data, setData] = useState<KnowledgeRetrievalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      setData(await fetchJson<KnowledgeRetrievalResponse>('/api/knowledge/retrieval'));
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

  function applyMutation(res: KnowledgeRetrievalMutationResponse): void {
    setData((previous) => previous === null
      ? previous
      : {
          ...previous,
          config: res.config,
          status: res.status,
          choices: res.choices ?? previous.choices,
        });
  }

  async function submit(
    kind: BusyKind,
    body: unknown,
  ): Promise<KnowledgeRetrievalMutationResponse | null> {
    setBusy(kind);
    setActionError(null);
    setNotice(null);
    try {
      const res = await postJson<KnowledgeRetrievalMutationResponse>(
        '/api/knowledge/retrieval',
        body,
      );
      applyMutation(res);
      return res;
    } catch (err) {
      setActionError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function chooseMode(mode: KnowledgeRetrievalMode): Promise<void> {
    if (data === null || data.config.mode === mode) return;
    const res = await submit('mode', { action: 'set-mode', mode });
    if (res === null) return;
    if (mode !== 'lexical' && !res.status.index.ready) {
      setNotice(`检索模式已切换为「${modeLabel(mode)}」；索引尚未就绪，需要重建后语义检索才会生效。`);
    } else {
      setNotice(`检索模式已切换为「${modeLabel(mode)}」。`);
    }
    notify('知识库检索模式已更新', 'success');
  }

  async function chooseEmbedding(choice: KnowledgeEmbeddingChoice): Promise<void> {
    if (data === null || isCurrentEmbedding(data.config.embedding, choice)) return;
    const body = choice.kind === 'builtin'
      ? { action: 'set-embedding', kind: 'builtin' }
      : {
          action: 'set-embedding',
          kind: 'profile',
          profileId: choice.profileId,
          modelId: choice.modelId,
        };
    const res = await submit('embedding', body);
    if (res === null) return;
    setNotice(`知识库嵌入模型已切换为「${choice.kind === 'builtin' ? '本地 BGE' : choice.label}」；需要重建索引后才会用新模型检索。`);
    notify('知识库嵌入模型已切换，需要重建索引', 'warning');
  }

  async function toggleRerank(enabled: boolean): Promise<void> {
    const res = await submit('rerank', { action: 'set-rerank', enabled });
    if (res === null) return;
    setNotice(enabled
      ? '知识库重排已开启；检索时会用本地 cross-encoder 重新排序。'
      : '知识库重排已关闭。');
    notify(enabled ? '知识库重排已开启' : '知识库重排已关闭', 'success');
  }

  async function rebuild(): Promise<void> {
    const res = await submit('rebuild', { action: 'rebuild' });
    if (res === null) return;
    const index = res.status.index;
    if (index.ready) {
      setNotice(`索引已重建：${formatNumber(index.indexedChunks)} 个片段 · ${index.model ?? '未知模型'}`);
      notify('知识库索引已重建', 'success');
      return;
    }
    setNotice(`重建结束，但索引仍未就绪：${index.staleReason ?? '未知原因'}`);
    notify('知识库索引仍未就绪', 'warning');
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="知识库检索设置"
      description="只影响知识库文档检索；检索模式、嵌入模型、重排与索引都由这里管理。"
      variant="wide"
      footer={
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>
        </div>
      }
    >
      {loading && data === null ? (
        <Skeleton rows={6} height={16} />
      ) : loadError !== null || data === null ? (
        <InlineError
          message={`读取知识库检索设置失败：${loadError ?? '状态为空'}`}
          onRetry={() => void load(false)}
        />
      ) : (
        <div className="krs">
          <section className="krs-block">
            <div className="krs-block-head">
              <strong>检索模式</strong>
              <p>决定文档命中怎么排序；纯语义与混合模式依赖向量索引。</p>
            </div>
            <div className="model-embedding-picker krs-mode">
              {MODES.map((item) => {
                const active = data.config.mode === item.mode;
                return (
                  <button
                    key={item.mode}
                    type="button"
                    className={`model-embedding-option${active ? ' is-current' : ''}`}
                    disabled={busy !== null}
                    aria-pressed={active}
                    onClick={() => void chooseMode(item.mode)}
                  >
                    <span className="model-embedding-option-main">
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </span>
                    {active && <span className="model-embedding-option-current">当前</span>}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="krs-block">
            <div className="krs-block-head">
              <strong>知识库嵌入模型</strong>
              <p>文档片段与查询都用这个模型向量化；换模型后旧索引失效，需要重建。</p>
            </div>
            <div className="krs-current">
              <span className="krs-current-label">当前使用</span>
              <strong className="krs-current-name">{currentEmbeddingName(data)}</strong>
              <span className="krs-current-meta">{currentEmbeddingMeta(data)}</span>
            </div>
            <div className="model-embedding-picker">
              {data.choices.map((choice) => {
                const active = isCurrentEmbedding(data.config.embedding, choice);
                const reason = choiceDisabledReason(choice);
                return (
                  <button
                    key={choiceKey(choice)}
                    type="button"
                    className={`model-embedding-option${active ? ' is-current' : ''}`}
                    disabled={busy !== null || reason !== null}
                    aria-pressed={active}
                    title={reason ?? undefined}
                    onClick={() => void chooseEmbedding(choice)}
                  >
                    <span className="model-embedding-option-main">
                      <strong>{choice.kind === 'builtin' ? '本地 BGE' : choice.label}</strong>
                      <small>
                        {choice.kind === 'builtin'
                          ? `${choice.label} · ${choice.dimension} 维 · 离线`
                          : `${choice.profileName ?? '远程配置'} · ${choice.dimension > 0 ? `${choice.dimension} 维` : '未设维度'}${reason === '缺少 Key' ? ' · 缺少 Key' : ''}`}
                      </small>
                    </span>
                    {active && <span className="model-embedding-option-current">当前</span>}
                  </button>
                );
              })}
            </div>
            {data.choices.every((choice) => choice.kind === 'builtin') && (
              <p className="krs-note">
                还没有远程嵌入模型；可在 设置 → 模型接入 的「嵌入模型」页签添加连接。
              </p>
            )}
          </section>

          <section className="krs-block">
            <div className="krs-block-head">
              <strong>知识库重排</strong>
              <p>用本地 cross-encoder 对候选片段重新排序；首次开启会加载本地模型。</p>
            </div>
            <div className="krs-current">
              <span className="krs-current-label">当前重排模型</span>
              <strong className="krs-current-name">
                {data.status.rerankModel ?? '本地 cross-encoder'}
              </strong>
              <span className="krs-current-meta">
                本地 cross-encoder · {data.status.rerankAvailable ? '可用' : '不可用'}
              </span>
            </div>
            <div className="krs-rerank-row">
              <span className="krs-rerank-state">
                检索时使用重排
                <strong>{data.config.rerank ? '已开启' : '已关闭'}</strong>
              </span>
              <Switch
                checked={data.config.rerank}
                disabled={busy !== null || (!data.status.rerankAvailable && !data.config.rerank)}
                label="知识库重排开关"
                onChange={(next) => void toggleRerank(next)}
              />
            </div>
            {!data.status.rerankAvailable && (
              <p className="krs-warn">
                本地重排模型不可用；
                {data.config.rerank
                  ? '当前开启的重排会被跳过，保留原排序，建议先关闭。'
                  : '暂时不能开启重排。'}
              </p>
            )}
          </section>

          <section className="krs-block">
            <div className="krs-block-head">
              <strong>索引状态</strong>
              <p>语义检索依赖这份索引；文档变化后后端会尝试增量更新，失败时在这里显示原因。</p>
            </div>
            <div className="settings-rows">
              <div className="settings-row">
                <span className="settings-key">文档</span>
                <span className="settings-val">
                  {formatNumber(data.status.documents)} 份 · {formatNumber(data.status.chunks)} 个片段
                </span>
              </div>
              <div className="settings-row">
                <span className="settings-key">索引</span>
                <span className={`settings-val${data.status.index.ready ? '' : ' settings-warn'}`}>
                  {data.status.index.ready ? '就绪' : '未就绪'} · 已索引{' '}
                  {formatNumber(data.status.index.indexedChunks)} 个片段
                </span>
              </div>
              <div className="settings-row">
                <span className="settings-key">模型</span>
                <span className="settings-val">
                  {data.status.index.model ?? '—'}
                  {data.status.index.dimension === null ? '' : ` · ${data.status.index.dimension} 维`}
                </span>
              </div>
              <div className="settings-row">
                <span className="settings-key">重建时间</span>
                <span className="settings-val">
                  {data.status.index.rebuiltAt === null
                    ? '从未重建'
                    : formatDateTime(data.status.index.rebuiltAt)}
                </span>
              </div>
              <div className="settings-row">
                <span className="settings-key">过期原因</span>
                <span className={`settings-val${data.status.index.staleReason === null ? '' : ' settings-warn'}`}>
                  {data.status.index.staleReason ?? '—'}
                </span>
              </div>
            </div>
            {!data.status.index.ready && data.status.mode !== 'lexical' && (
              <p className="krs-warn">
                索引未就绪：语义检索会先回退到字面检索，重建索引后才会生效。
              </p>
            )}
            <div className="krs-actions">
              <button
                type="button"
                className="model-primary"
                disabled={busy !== null || data.status.mode === 'lexical'}
                onClick={() => void rebuild()}
              >
                {busy === 'rebuild' ? '重建中…' : '重建索引'}
              </button>
              <small>
                {data.status.mode === 'lexical'
                  ? '字面检索模式不需要向量索引。'
                  : '重建会用当前嵌入模型重新生成全部片段向量。'}
              </small>
            </div>
          </section>

          {actionError !== null && <p className="model-error">{actionError}</p>}
          {notice !== null && <p className="model-notice">{notice}</p>}
        </div>
      )}
    </Modal>
  );
}
