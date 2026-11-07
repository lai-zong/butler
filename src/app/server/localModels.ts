/**
 * 随程序提供的本地模型资产。
 *
 * 它们不是远程 API 连接，也不能像普通 profile 一样填写 Base URL/Key；
 * 但必须出现在模型接入页，避免用户只看到远程配置、不知道本地 BGE/重排存在。
 */

import { join } from 'node:path';

import { LocalBgeEmbedding, LOCAL_EMBEDDING_MODEL } from '@/adapters/embedding/localBge.js';
import { LocalBgeReranker, LOCAL_RERANKER_MODEL } from '@/adapters/rerank/localBgeReranker.js';

export type LocalModelKind = 'embedding' | 'rerank';

export interface LocalModelInfo {
  readonly id: string;
  readonly label: string;
  readonly kind: LocalModelKind;
  readonly source: 'local';
  readonly dimension: number | null;
  readonly available: boolean;
  readonly description: string;
}

function modelRoot(): string {
  const dir = process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
  const configured = process.env['BUTLER_MODEL_DIR']?.trim() ?? '';
  return configured.length > 0 ? configured : join(dir, 'models');
}

export function localModelViews(): readonly LocalModelInfo[] {
  const root = modelRoot();
  return [
    {
      id: 'local-bge-embedding',
      label: LOCAL_EMBEDDING_MODEL,
      kind: 'embedding',
      source: 'local',
      dimension: 768,
      available: new LocalBgeEmbedding(root).isAvailable(),
      description: '本地 BGE 中文嵌入模型；离线运行，用于记忆与知识库向量化。',
    },
    {
      id: 'local-bge-reranker',
      label: LOCAL_RERANKER_MODEL,
      kind: 'rerank',
      source: 'local',
      dimension: null,
      available: new LocalBgeReranker(root).isAvailable(),
      description: '本地 bge cross-encoder 重排模型；按查询对候选片段重新打分。',
    },
  ];
}
