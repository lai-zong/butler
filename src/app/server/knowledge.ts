/**
 * 知识库检索域。
 *
 * 与记忆检索刻意分开：
 *   · 独立的配置：knowledge-config.json
 *   · 独立的索引：knowledge-index.json
 *   · 独立的嵌入角色；即使使用同一个模型连接，也不与记忆共享向量空间
 *
 * 当前检索策略是数据结论后的默认值：
 *   字面优先混合（lexical-first），语义只补足字面没有覆盖的结果。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalBgeEmbedding, LOCAL_EMBEDDING_MODEL } from '@/adapters/embedding/localBge.js';
import { OpenAIEmbedding } from '@/adapters/embedding/openaiEmbedding.js';
import { LocalBgeReranker, LOCAL_RERANKER_MODEL } from '@/adapters/rerank/localBgeReranker.js';
import {
  DOCUMENT_CHUNK_VERSION,
  type DocumentStore,
} from '@/core/documents/store.js';
import {
  lexicalFirstHybrid,
  semanticOnly,
  type KnowledgeHit,
  type KnowledgeRetrievalMode,
} from '@/core/documents/retrieval.js';
import {
  DOCUMENT_VECTOR_INDEX_VERSION,
  parseVectorIndex,
  searchVectorIndex,
  type DocumentVectorEntry,
  type DocumentVectorIndexData,
  type SemanticDocumentHit,
} from '@/core/documents/vectorIndex.js';
import { getDocumentStore } from './documents.js';
import {
  loadProfileStore,
  resolveProfileModel,
  resolveProfileSecret,
} from './modelProfiles.js';
import { presetById } from './modelPresets.js';

export const KNOWLEDGE_CONFIG_FILE = 'knowledge-config.json';
export const KNOWLEDGE_INDEX_FILE = 'knowledge-index.json';
export const KNOWLEDGE_SEMANTIC_MIN = 0.5;
const EMBED_BATCH = 16;

export type KnowledgeEmbedding =
  | { readonly kind: 'builtin'; readonly label: string; readonly dimension: number }
  | {
      readonly kind: 'profile';
      readonly profileId: string;
      readonly modelId: string;
      readonly label: string;
      readonly dimension: number;
    };

export interface KnowledgeConfig {
  readonly version: 1;
  readonly mode: KnowledgeRetrievalMode;
  readonly embedding: KnowledgeEmbedding;
  /** 本地 cross-encoder 重排；默认关闭，避免每次查询都加载大模型。 */
  readonly rerank: boolean;
}

export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  version: 1,
  mode: 'hybrid',
  embedding: {
    kind: 'builtin',
    label: LOCAL_EMBEDDING_MODEL,
    dimension: 768,
  },
  rerank: false,
};

export interface KnowledgeEmbeddingChoice {
  readonly kind: 'builtin' | 'profile';
  readonly label: string;
  readonly dimension: number;
  readonly profileId?: string;
  readonly modelId?: string;
  readonly profileName?: string;
  readonly baseUrl?: string;
  readonly hasKey?: boolean;
  readonly requiresKey?: boolean;
}

export interface KnowledgeIndexStatus {
  readonly ready: boolean;
  readonly model: string | null;
  readonly dimension: number | null;
  readonly indexedChunks: number;
  readonly staleReason: string | null;
  readonly rebuiltAt: number | null;
}

export interface KnowledgeStatus {
  readonly mode: KnowledgeRetrievalMode;
  readonly embedding: KnowledgeEmbedding;
  readonly rerank: boolean;
  readonly rerankAvailable: boolean;
  readonly rerankModel: string | null;
  readonly semanticMin: number;
  readonly documents: number;
  readonly chunks: number;
  readonly index: KnowledgeIndexStatus;
}

export interface KnowledgeSearchResult {
  readonly hits: readonly KnowledgeHit[];
  readonly mode: KnowledgeRetrievalMode;
  readonly fallbackReason: string | null;
  readonly rerankUsed: boolean;
}

interface StoredIndex extends DocumentVectorIndexData {
  readonly rebuiltAt: number | null;
}

function dataDir(): string {
  return process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
}

function modelRoot(): string {
  const configured = process.env['BUTLER_MODEL_DIR']?.trim() ?? '';
  return configured.length > 0 ? configured : join(dataDir(), 'models');
}

function normalizeEmbedding(raw: unknown): KnowledgeEmbedding {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_KNOWLEDGE_CONFIG.embedding;
  const value = raw as Record<string, unknown>;
  if (value['kind'] === 'profile') {
    const profileId = typeof value['profileId'] === 'string' ? value['profileId'] : '';
    const modelId = typeof value['modelId'] === 'string' ? value['modelId'] : '';
    const dimension = typeof value['dimension'] === 'number' && value['dimension'] > 0
      ? Math.round(value['dimension'])
      : 0;
    if (profileId.length > 0 && modelId.length > 0 && dimension > 0) {
      return {
        kind: 'profile',
        profileId,
        modelId,
        label: typeof value['label'] === 'string' && value['label'].length > 0 ? value['label'] : modelId,
        dimension,
      };
    }
  }
  const dimension = typeof value['dimension'] === 'number' && value['dimension'] > 0
    ? Math.round(value['dimension'])
    : DEFAULT_KNOWLEDGE_CONFIG.embedding.dimension;
  return {
    kind: 'builtin',
    label: typeof value['label'] === 'string' && value['label'].length > 0
      ? value['label']
      : LOCAL_EMBEDDING_MODEL,
    dimension,
  };
}

function normalizeMode(raw: unknown): KnowledgeRetrievalMode {
  return raw === 'lexical' || raw === 'semantic' || raw === 'hybrid' ? raw : 'hybrid';
}

export function parseKnowledgeConfig(raw: unknown): KnowledgeConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_KNOWLEDGE_CONFIG;
  const value = raw as Record<string, unknown>;
  return {
    version: 1,
    mode: normalizeMode(value['mode']),
    embedding: normalizeEmbedding(value['embedding']),
    rerank: value['rerank'] === true,
  };
}

export async function loadKnowledgeConfig(dir = dataDir()): Promise<KnowledgeConfig> {
  try {
    const raw = JSON.parse(await readFile(join(dir, KNOWLEDGE_CONFIG_FILE), 'utf8')) as unknown;
    return parseKnowledgeConfig(raw);
  } catch {
    return DEFAULT_KNOWLEDGE_CONFIG;
  }
}

export async function saveKnowledgeConfig(
  config: KnowledgeConfig,
  dir = dataDir(),
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, KNOWLEDGE_CONFIG_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify(
      {
        version: 1,
        mode: config.mode,
        embedding: config.embedding,
        rerank: config.rerank,
      },
      null,
      2,
    ),
    'utf8',
  );
  await rename(tmp, file);
}

async function loadIndex(dir = dataDir()): Promise<StoredIndex | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, KNOWLEDGE_INDEX_FILE), 'utf8')) as {
      rebuiltAt?: unknown;
    };
    const parsed = parseVectorIndex(raw);
    if (parsed === null) return null;
    return {
      ...parsed,
      rebuiltAt: typeof raw.rebuiltAt === 'number' ? raw.rebuiltAt : null,
    };
  } catch {
    return null;
  }
}

async function saveIndex(index: StoredIndex, dir = dataDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, KNOWLEDGE_INDEX_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({
      version: DOCUMENT_VECTOR_INDEX_VERSION,
      model: index.model,
      dimension: index.dimension,
      chunkVersion: index.chunkVersion,
      rebuiltAt: index.rebuiltAt,
      entries: index.entries,
    }),
    'utf8',
  );
  await rename(tmp, file);
}

async function removeIndexFile(dir = dataDir()): Promise<void> {
  await rm(join(dir, KNOWLEDGE_INDEX_FILE), { force: true });
}

async function collectChunks(store: DocumentStore): Promise<{
  readonly chunks: readonly DocumentVectorEntry[];
  readonly documentCount: number;
}> {
  const documents = await store.list();
  const chunks: DocumentVectorEntry[] = [];
  for (const summary of documents) {
    const doc = await store.get(summary.id);
    if (doc === null) continue;
    for (const chunk of doc.chunks) {
      chunks.push({
        chunkId: chunk.id,
        documentId: doc.id,
        name: doc.name,
        chunkIndex: chunk.index,
        text: chunk.text,
        vector: [],
      });
    }
  }
  return { chunks, documentCount: documents.length };
}

/** 索引是否真的对应当前文档片段，而不只是模型/维度相同。 */
function indexMatchesChunks(index: StoredIndex | null, chunks: readonly DocumentVectorEntry[]): boolean {
  if (index === null || index.entries.length !== chunks.length) return false;
  const current = new Set(chunks.map((chunk) => chunk.chunkId));
  return index.entries.every((entry) => current.has(entry.chunkId));
}

export class KnowledgeService {
  private index: StoredIndex | null | undefined;
  private embeddingCache: { readonly key: string; readonly port: LocalBgeEmbedding | OpenAIEmbedding; readonly model: string; readonly dimension: number } | null = null;
  private reranker: LocalBgeReranker | null = null;
  private rerankerUnavailable: string | null = null;
  private lastIndexError: string | null = null;

  constructor(
    private readonly dir = dataDir(),
    private readonly store: DocumentStore = getDocumentStore(),
  ) {}

  private async loadIndexOnce(): Promise<StoredIndex | null> {
    if (this.index === undefined) this.index = await loadIndex(this.dir);
    return this.index;
  }

  private async resolveEmbedding(config: KnowledgeConfig): Promise<{
    readonly port: LocalBgeEmbedding | OpenAIEmbedding;
    readonly model: string;
    readonly dimension: number;
  }> {
    const key = config.embedding.kind === 'builtin'
      ? `builtin:${LOCAL_EMBEDDING_MODEL}`
      : `profile:${config.embedding.profileId}:${config.embedding.modelId}:${config.embedding.dimension}`;
    if (this.embeddingCache?.key === key) return this.embeddingCache;

    if (config.embedding.kind === 'builtin') {
      const port = new LocalBgeEmbedding(modelRoot());
      if (!port.isAvailable()) throw new Error('本地 BGE 模型不存在');
      const resolved = { key, port, model: port.model, dimension: config.embedding.dimension };
      this.embeddingCache = resolved;
      return resolved;
    }

    const resolved = await resolveProfileModel(
      this.dir,
      config.embedding.profileId,
      config.embedding.modelId,
      'embedding',
    );
    if (resolved === null) throw new Error('知识库嵌入模型配置不可用');
    if (resolved.model.dimension === undefined || resolved.model.dimension <= 0) {
      throw new Error('知识库嵌入模型缺少向量维度');
    }
    const port = new OpenAIEmbedding({
      model: resolved.model.id,
      baseUrl: resolved.profile.baseUrl,
      apiKey: resolved.config.apiKey.length > 0 ? resolved.config.apiKey : 'local',
      dimensions: resolved.model.dimension,
    });
    const result = {
      key,
      port,
      model: port.model,
      dimension: resolved.model.dimension,
    };
    this.embeddingCache = result;
    return result;
  }

  private async refreshIndex(config: KnowledgeConfig, force: boolean): Promise<StoredIndex | null> {
    if (config.mode === 'lexical') return this.loadIndexOnce();
    const embedding = await this.resolveEmbedding(config);
    const { chunks, documentCount } = await collectChunks(this.store);
    const existing = force ? null : await this.loadIndexOnce();
    const sameShape =
      existing !== null &&
      existing.model === embedding.model &&
      existing.dimension === embedding.dimension &&
      existing.chunkVersion === DOCUMENT_CHUNK_VERSION;
    const byChunk = new Map<string, DocumentVectorEntry>();
    if (sameShape) {
      for (const entry of existing.entries) {
        const chunk = chunks.find((c) => c.chunkId === entry.chunkId);
        if (chunk !== undefined) byChunk.set(entry.chunkId, { ...entry, ...chunk, vector: entry.vector });
      }
    }
    const missing = chunks.filter((chunk) => !byChunk.has(chunk.chunkId));
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const batch = missing.slice(i, i + EMBED_BATCH);
      const vectors = await embedding.port.embed(batch.map((chunk) => chunk.text));
      if (vectors.length !== batch.length) {
        throw new Error(`嵌入返回数量不一致：期望 ${batch.length}，实际 ${vectors.length}`);
      }
      for (let j = 0; j < batch.length; j += 1) {
        const vector = vectors[j];
        const chunk = batch[j];
        if (vector === undefined || chunk === undefined) {
          throw new Error('嵌入返回缺失片段向量');
        }
        if (vector.length !== embedding.dimension) {
          throw new Error(`嵌入维度不一致：期望 ${embedding.dimension}，实际 ${vector.length}`);
        }
        byChunk.set(chunk.chunkId, { ...chunk, vector });
      }
    }
    const entries = chunks
      .map((chunk) => byChunk.get(chunk.chunkId))
      .filter((entry): entry is DocumentVectorEntry => entry !== undefined)
      .map((entry) => ({ ...entry }));
    const next: StoredIndex = {
      version: DOCUMENT_VECTOR_INDEX_VERSION,
      model: embedding.model,
      dimension: embedding.dimension,
      chunkVersion: DOCUMENT_CHUNK_VERSION,
      rebuiltAt: Date.now(),
      entries,
    };
    this.index = next;
    this.lastIndexError = null;
    await saveIndex(next, this.dir);
    // 让文档数量参与状态判断；这里仅保留可观测性。
    void documentCount;
    return next;
  }

  async status(): Promise<KnowledgeStatus> {
    const config = await loadKnowledgeConfig(this.dir);
    const { chunks, documentCount } = await collectChunks(this.store);
    const index = await this.loadIndexOnce();
    const shapeMatches =
      index !== null &&
      index.chunkVersion === DOCUMENT_CHUNK_VERSION &&
      indexMatchesChunks(index, chunks);
    const modeMatches = config.mode === 'lexical' || (
      index !== null &&
      (config.embedding.kind === 'builtin'
        ? index.model === LOCAL_EMBEDDING_MODEL
        : index.model === config.embedding.modelId) &&
      index.dimension === config.embedding.dimension
    );
    return {
      mode: config.mode,
      embedding: config.embedding,
      rerank: config.rerank,
      rerankAvailable: new LocalBgeReranker(modelRoot()).isAvailable(),
      rerankModel: LOCAL_RERANKER_MODEL,
      semanticMin: KNOWLEDGE_SEMANTIC_MIN,
      documents: documentCount,
      chunks: chunks.length,
      index: {
        ready: config.mode === 'lexical' || (shapeMatches && modeMatches),
        model: index?.model ?? null,
        dimension: index?.dimension ?? null,
        indexedChunks: index?.entries.length ?? 0,
        staleReason: this.lastIndexError,
        rebuiltAt: index?.rebuiltAt ?? null,
      },
    };
  }

  async embeddingChoices(): Promise<readonly KnowledgeEmbeddingChoice[]> {
    const store = await loadProfileStore(this.dir);
    const choices: KnowledgeEmbeddingChoice[] = [{
      kind: 'builtin',
      label: LOCAL_EMBEDDING_MODEL,
      dimension: 768,
    }];
    for (const profile of store.profiles) {
      for (const model of profile.models) {
        if (model.kind !== 'embedding') continue;
        const secret = await resolveProfileSecret(profile);
        const preset = presetById(profile.presetId);
        choices.push({
          kind: 'profile',
          label: model.id,
          dimension: model.dimension ?? 0,
          profileId: profile.id,
          modelId: model.id,
          profileName: profile.name,
          baseUrl: profile.baseUrl,
          hasKey: secret.key.length > 0,
          requiresKey: preset?.requiresKey ?? true,
        });
      }
    }
    return choices;
  }

  async search(query: string, limit = 8): Promise<KnowledgeSearchResult> {
    const config = await loadKnowledgeConfig(this.dir);
    const lexical = await this.store.search(query, limit);
    if (config.mode === 'lexical') {
      return {
        hits: lexical.map((hit) => ({ ...hit, retrieval: 'lexical' as const })),
        mode: 'lexical',
        fallbackReason: null,
        rerankUsed: false,
      };
    }

    let semantic: readonly SemanticDocumentHit[] = [];
    try {
      const embedding = await this.resolveEmbedding(config);
      let index = await this.loadIndexOnce();
      const current = await collectChunks(this.store);
      const shapeMatches =
        index !== null &&
        index.model === embedding.model &&
        index.dimension === embedding.dimension &&
        index.chunkVersion === DOCUMENT_CHUNK_VERSION &&
        indexMatchesChunks(index, current.chunks);
      if (!shapeMatches) {
        index = await this.refreshIndex(config, index === null);
      }
      if (index === null || !indexMatchesChunks(index, current.chunks)) {
        throw new Error('知识库语义索引与当前文档不一致');
      }
      const queryVector = (await embedding.port.embed([query]))[0];
      if (queryVector === undefined) throw new Error('查询向量生成失败');
      semantic = searchVectorIndex(index, queryVector, KNOWLEDGE_SEMANTIC_MIN, 10);
      this.lastIndexError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastIndexError = message;
      return {
        hits: lexical.map((hit) => ({ ...hit, retrieval: 'lexical' as const })),
        mode: 'lexical',
        fallbackReason: `语义检索不可用，已回退字面检索：${message}`,
        rerankUsed: false,
      };
    }

    let hits: readonly KnowledgeHit[] = config.mode === 'semantic'
      ? semanticOnly(semantic, limit)
      : lexicalFirstHybrid(lexical, semantic, limit);

    let rerankUsed = false;
    let fallbackReason: string | null = null;
    if (config.rerank && hits.length > 1) {
      try {
        this.reranker ??= new LocalBgeReranker(modelRoot());
        if (!this.reranker.isAvailable()) throw new Error('本地重排模型不存在');
        const scores = await this.reranker.scoreTexts(query, hits.map((hit) => hit.text));
        hits = hits.map((hit, i) => ({
          ...hit,
          score: scores[i] ?? hit.score,
          rerankScore: scores[i] ?? 0,
        })).sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
        rerankUsed = true;
        this.rerankerUnavailable = null;
      } catch (err) {
        this.rerankerUnavailable = err instanceof Error ? err.message : String(err);
        fallbackReason = `重排不可用，保留当前排序：${this.rerankerUnavailable}`;
      }
    }

    return {
      hits,
      mode: config.mode,
      fallbackReason,
      rerankUsed,
    };
  }

  async rebuild(): Promise<KnowledgeStatus> {
    const config = await loadKnowledgeConfig(this.dir);
    try {
      await this.refreshIndex(config, true);
    } catch (err) {
      this.lastIndexError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    return this.status();
  }

  async onDocumentsChanged(): Promise<void> {
    const config = await loadKnowledgeConfig(this.dir);
    if (config.mode === 'lexical') return;
    try {
      await this.refreshIndex(config, false);
    } catch (err) {
      this.lastIndexError = err instanceof Error ? err.message : String(err);
    }
  }

  async removeDocument(documentId: string): Promise<void> {
    const index = await this.loadIndexOnce();
    if (index === null) return;
    const entries = index.entries.filter((entry) => entry.documentId !== documentId);
    if (entries.length === index.entries.length) return;
    const next = { ...index, entries, rebuiltAt: Date.now() };
    this.index = next;
    await saveIndex(next, this.dir);
  }

  async setConfig(config: KnowledgeConfig): Promise<void> {
    const previous = await loadKnowledgeConfig(this.dir);
    await saveKnowledgeConfig(config, this.dir);
    const embeddingChanged =
      previous.embedding.kind !== config.embedding.kind ||
      previous.embedding.dimension !== config.embedding.dimension ||
      (previous.embedding.kind === 'profile' &&
        config.embedding.kind === 'profile' &&
        (previous.embedding.profileId !== config.embedding.profileId ||
          previous.embedding.modelId !== config.embedding.modelId));
    if (embeddingChanged) {
      this.index = null;
      this.embeddingCache = null;
      this.reranker = null;
      this.lastIndexError = null;
      await removeIndexFile(this.dir);
    }
  }
}

let service: KnowledgeService | null = null;

export function getKnowledgeService(): KnowledgeService {
  if (service === null) service = new KnowledgeService();
  return service;
}

export function resetKnowledgeService(): void {
  service = null;
}
