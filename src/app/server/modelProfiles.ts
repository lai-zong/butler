/**
 * 用户自定义模型配置（连接 + 模型目录）。
 *
 * ★ 这里刻意不保存“默认模型”：
 *   模型选择是运行时状态（顶部当前模型 / 未来对话级选择），
 *   不属于某一个连接配置。
 *
 * ★ API Key 永远不写进 JSON；只保存凭证库引用。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { DeepSeekConfig } from '@/adapters/model/deepseek.js';
import { getCredentialVault } from './credentials.js';
import { loadSelection, specOf } from './modelProvider.js';
import { presetById, type ModelPreset } from './modelPresets.js';

export type ModelCapabilityKey = 'vision' | 'imageGeneration' | 'audio' | 'tools' | 'reasoning';
export type ProfileModelKind = 'chat' | 'embedding' | 'rerank';

export interface ProfileModel {
  readonly id: string;
  readonly kind: ProfileModelKind;
  readonly capabilities: Readonly<Record<ModelCapabilityKey, boolean>>;
  /** 仅嵌入模型使用；本地 BGE 为 768。 */
  readonly dimension?: number;
}

export interface EmbeddingRole {
  readonly kind: 'builtin' | 'profile';
  readonly label: string;
  readonly dimension: number;
  readonly profileId?: string;
  readonly modelId?: string;
}

export type ProfileCredential =
  | { readonly kind: 'vault'; readonly id: string }
  | { readonly kind: 'env'; readonly name: string }
  | null;

export interface ModelProfile {
  readonly id: string;
  readonly name: string;
  readonly presetId: string;
  readonly baseUrl: string;
  readonly models: readonly ProfileModel[];
  readonly credential: ProfileCredential;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ActiveModel {
  readonly profileId: string;
  readonly modelId: string;
}

export interface ModelProfileStore {
  readonly version: 1;
  readonly profiles: readonly ModelProfile[];
  readonly active: ActiveModel | null;
  /** 最近一次在对话中选择的模型；新对话继承它。 */
  readonly lastChat: ActiveModel | null;
  /** 最近一次监督员审查使用的模型；新审查继承它。 */
  readonly lastReview: ActiveModel | null;
  /** 系统级嵌入角色；对话不再有默认模型。 */
  readonly embedding: EmbeddingRole;
}

export const MODEL_PROFILES_FILE = 'model-profiles.json';

export const DEFAULT_EMBEDDING_ROLE: EmbeddingRole = {
  kind: 'builtin',
  label: 'bge-base-zh-v1.5',
  dimension: 768,
};

export const EMPTY_CAPABILITIES: Readonly<Record<ModelCapabilityKey, boolean>> = {
  vision: false,
  imageGeneration: false,
  audio: false,
  tools: false,
  reasoning: false,
};

function defaultCapabilities(adapter: ModelPreset['adapter']): Readonly<Record<ModelCapabilityKey, boolean>> {
  return {
    vision: adapter === 'deepseek',
    imageGeneration: false,
    audio: false,
    tools: true,
    reasoning: adapter === 'deepseek',
  };
}

function cleanModels(models: readonly unknown[]): readonly ProfileModel[] {
  const seen = new Set<string>();
  const out: ProfileModel[] = [];
  for (const raw of models) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as { id?: unknown; kind?: unknown; capabilities?: unknown; dimension?: unknown };
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const kind: ProfileModelKind = item.kind === 'embedding' || item.kind === 'rerank' ? item.kind : 'chat';
    const c = typeof item.capabilities === 'object' && item.capabilities !== null
      ? (item.capabilities as Record<string, unknown>)
      : {};
    out.push({
      id,
      kind,
      capabilities: {
        vision: c['vision'] === true,
        imageGeneration: c['imageGeneration'] === true,
        audio: c['audio'] === true,
        tools: c['tools'] === true,
        reasoning: c['reasoning'] === true,
      },
      ...(kind === 'embedding' && typeof item.dimension === 'number' && item.dimension > 0
        ? { dimension: Math.round(item.dimension) }
        : {}),
    });
  }
  return out;
}

function normalizeProfile(raw: unknown): ModelProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const id = typeof p['id'] === 'string' ? p['id'].trim() : '';
  const name = typeof p['name'] === 'string' ? p['name'].trim() : '';
  const presetId = typeof p['presetId'] === 'string' ? p['presetId'].trim() : '';
  const baseUrl = typeof p['baseUrl'] === 'string' ? p['baseUrl'].trim() : '';
  if (id.length === 0 || name.length === 0 || presetId.length === 0 || baseUrl.length === 0) return null;
  const models = Array.isArray(p['models']) ? cleanModels(p['models']) : [];
  if (models.length === 0) return null;
  const credentialRaw = p['credential'];
  let credential: ProfileCredential = null;
  if (typeof credentialRaw === 'object' && credentialRaw !== null) {
    const c = credentialRaw as Record<string, unknown>;
    if (c['kind'] === 'vault' && typeof c['id'] === 'string') {
      credential = { kind: 'vault', id: c['id'] };
    } else if (c['kind'] === 'env' && typeof c['name'] === 'string') {
      credential = { kind: 'env', name: c['name'] };
    }
  }
  const now = Date.now();
  return {
    id,
    name,
    presetId,
    baseUrl,
    models,
    credential,
    createdAt: typeof p['createdAt'] === 'number' ? p['createdAt'] : now,
    updatedAt: typeof p['updatedAt'] === 'number' ? p['updatedAt'] : now,
  };
}

async function legacyStore(dataDir: string): Promise<ModelProfileStore> {
  const loaded = await loadSelection(dataDir);
  const provider = loaded.selection.provider;
  const spec = specOf(provider);
  const model = loaded.selection.model ?? spec.defaultModel;
  const baseUrl = process.env[spec.baseUrlEnv]?.trim() || spec.defaultBaseUrl;
  const now = Date.now();
  const profile: ModelProfile = {
    id: `legacy-${provider}`,
    name: spec.label,
    presetId: provider,
    baseUrl,
    models: [{
      id: model,
      kind: 'chat',
      capabilities: defaultCapabilities(spec.id === 'deepseek' ? 'deepseek' : spec.id === 'ollama' ? 'ollama' : 'openai'),
    }],
    credential: { kind: 'env', name: spec.keyName },
    createdAt: now,
    updatedAt: now,
  };
  return {
    version: 1,
    profiles: [profile],
    active: { profileId: profile.id, modelId: model },
    lastChat: { profileId: profile.id, modelId: model },
    lastReview: null,
    embedding: DEFAULT_EMBEDDING_ROLE,
  };
}

function validateEmbeddingRole(
  role: EmbeddingRole,
  profiles: readonly ModelProfile[],
): EmbeddingRole {
  if (role.kind !== 'profile' || role.profileId === undefined || role.modelId === undefined) {
    return role;
  }
  const profile = profiles.find((p) => p.id === role.profileId);
  const model = profile?.models.find((m) => m.id === role.modelId && m.kind === 'embedding');
  if (model === undefined) return DEFAULT_EMBEDDING_ROLE;
  return {
    kind: 'profile',
    label: model.id,
    dimension: model.dimension ?? role.dimension,
    profileId: profile!.id,
    modelId: model.id,
  };
}

function firstChatSelection(profiles: readonly ModelProfile[]): ActiveModel | null {
  for (const profile of profiles) {
    const model = profile.models.find((m) => m.kind === 'chat');
    if (model !== undefined) return { profileId: profile.id, modelId: model.id };
  }
  return null;
}

function normalizeEmbedding(raw: unknown): EmbeddingRole {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_EMBEDDING_ROLE;
  const e = raw as Record<string, unknown>;
  const dimension = typeof e['dimension'] === 'number' && e['dimension'] > 0
    ? Math.round(e['dimension'])
    : DEFAULT_EMBEDDING_ROLE.dimension;
  if (e['kind'] === 'profile') {
    const profileId = typeof e['profileId'] === 'string' ? e['profileId'] : undefined;
    const modelId = typeof e['modelId'] === 'string' ? e['modelId'] : undefined;
    if (profileId !== undefined && modelId !== undefined) {
      return {
        kind: 'profile',
        label: typeof e['label'] === 'string' ? e['label'] : modelId,
        dimension,
        profileId,
        modelId,
      };
    }
  }
  return { ...DEFAULT_EMBEDDING_ROLE, dimension };
}

export async function loadProfileStore(dataDir: string): Promise<ModelProfileStore> {
  try {
    const raw = await readFile(join(dataDir, MODEL_PROFILES_FILE), 'utf8');
    const parsed = JSON.parse(raw) as {
      profiles?: unknown;
      active?: unknown;
      lastChat?: unknown;
      lastReview?: unknown;
      embedding?: unknown;
    };
    const profiles = Array.isArray(parsed.profiles)
      ? parsed.profiles.map(normalizeProfile).filter((p): p is ModelProfile => p !== null)
      : [];
    const embedding = validateEmbeddingRole(normalizeEmbedding(parsed.embedding), profiles);
    if (profiles.length > 0) {
      const activeRaw = parsed.active;
      let active: ActiveModel | null = null;
      if (typeof activeRaw === 'object' && activeRaw !== null) {
        const a = activeRaw as Record<string, unknown>;
        if (typeof a['profileId'] === 'string' && typeof a['modelId'] === 'string') {
          active = { profileId: a['profileId'], modelId: a['modelId'] };
        }
      }
      if (
        active === null ||
        !profiles.some((p) =>
          p.id === active!.profileId &&
          p.models.some((m) => m.id === active!.modelId && m.kind === 'chat'),
        )
      ) {
        active = firstChatSelection(profiles);
      }
      let lastChat: ActiveModel | null = null;
      if (typeof parsed.lastChat === 'object' && parsed.lastChat !== null) {
        const l = parsed.lastChat as Record<string, unknown>;
        if (typeof l['profileId'] === 'string' && typeof l['modelId'] === 'string') {
          lastChat = { profileId: l['profileId'], modelId: l['modelId'] };
        }
      }
      if (lastChat === null || !profiles.some((p) => p.id === lastChat!.profileId && p.models.some((m) => m.id === lastChat!.modelId && m.kind === 'chat'))) {
        lastChat = active;
      }
      let lastReview: ActiveModel | null = null;
      if (typeof parsed.lastReview === 'object' && parsed.lastReview !== null) {
        const r = parsed.lastReview as Record<string, unknown>;
        if (typeof r['profileId'] === 'string' && typeof r['modelId'] === 'string') {
          lastReview = { profileId: r['profileId'], modelId: r['modelId'] };
        }
      }
      if (lastReview !== null && !profiles.some((p) => p.id === lastReview!.profileId && p.models.some((m) => m.id === lastReview!.modelId && m.kind === 'chat'))) {
        lastReview = null;
      }
      return { version: 1, profiles, active, lastChat, lastReview, embedding };
    }
  } catch {
    // 没有文件或损坏：尝试旧配置迁移。
  }
  const migrated = await legacyStore(dataDir);
  await saveProfileStore(dataDir, migrated);
  return migrated;
}

export async function saveProfileStore(dataDir: string, store: ModelProfileStore): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = join(dataDir, MODEL_PROFILES_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

export function findProfile(store: ModelProfileStore, profileId: string): ModelProfile | undefined {
  return store.profiles.find((p) => p.id === profileId);
}

export function findModel(profile: ModelProfile, modelId: string): ProfileModel | undefined {
  return profile.models.find((m) => m.id === modelId);
}

export async function resolveProfileSecret(profile: ModelProfile): Promise<{ key: string; source: 'env' | 'vault' | 'none' }> {
  const preset = presetById(profile.presetId);
  if (profile.credential?.kind === 'env') {
    const fromEnv = process.env[profile.credential.name]?.trim() ?? '';
    if (fromEnv.length > 0) return { key: fromEnv, source: 'env' };
    try {
      const vault = await getCredentialVault();
      const fromVault = await vault.resolve(profile.credential.name);
      if (fromVault !== null && fromVault.trim().length > 0) return { key: fromVault.trim(), source: 'vault' };
    } catch {
      // ignore
    }
  }
  if (profile.credential?.kind === 'vault') {
    try {
      const vault = await getCredentialVault();
      const fromVault = await vault.resolve(profile.credential.id);
      if (fromVault !== null && fromVault.trim().length > 0) return { key: fromVault.trim(), source: 'vault' };
    } catch {
      // ignore
    }
  }
  if (preset !== undefined && !preset.requiresKey) return { key: '', source: 'none' };
  return { key: '', source: 'none' };
}

export async function updateProfileSecret(profile: ModelProfile, apiKey: string): Promise<ModelProfile> {
  const vault = await getCredentialVault();
  const meta = await vault.put(`model-profile:${profile.id}`, apiKey.trim());
  return {
    ...profile,
    credential: { kind: 'vault', id: meta.id },
    updatedAt: Date.now(),
  };
}

export async function deleteProfileSecret(profile: ModelProfile): Promise<void> {
  if (profile.credential?.kind !== 'vault') return;
  try {
    const vault = await getCredentialVault();
    await vault.remove(profile.credential.id);
  } catch {
    // 凭证库不可用时不阻塞配置删除。
  }
}

export function createProfile(input: {
  readonly name: string;
  readonly presetId: string;
  readonly baseUrl: string;
  readonly models: readonly unknown[];
}): ModelProfile {
  const preset = presetById(input.presetId);
  if (preset === undefined) throw new Error('未知的模型预设');
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim();
  const models = cleanModels(input.models);
  if (name.length === 0) throw new Error('配置名称不能为空');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
  if (models.length === 0) throw new Error('至少选择一个模型');
  if (models.some((m) => m.kind === 'rerank')) {
    throw new Error('重排模型接口尚未接入，不能创建重排配置。');
  }
  const now = Date.now();
  return {
    id: `profile_${randomUUID()}`,
    name,
    presetId: preset.id,
    baseUrl,
    models,
    credential: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateProfile(
  profile: ModelProfile,
  input: {
    readonly name: unknown;
    readonly baseUrl: unknown;
    readonly models: unknown;
    readonly presetId: unknown;
  },
): ModelProfile {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const presetId = typeof input.presetId === 'string' ? input.presetId : profile.presetId;
  const models = Array.isArray(input.models) ? cleanModels(input.models) : profile.models;
  if (name.length === 0) throw new Error('配置名称不能为空');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
  if (models.length === 0) throw new Error('至少选择一个模型');
  if (models.some((m) => m.kind === 'rerank')) {
    throw new Error('重排模型接口尚未接入，不能保存重排配置。');
  }
  if (presetById(presetId) === undefined) throw new Error('未知的模型预设');
  return { ...profile, name, baseUrl, presetId, models, updatedAt: Date.now() };
}

export async function discoverModels(args: {
  readonly presetId: string;
  readonly baseUrl: string;
  readonly profileId?: string;
  readonly apiKey?: string;
  readonly dataDir?: string;
}): Promise<readonly string[]> {
  const preset = presetById(args.presetId);
  if (preset === undefined) throw new Error('未知的模型预设');
  let key = args.apiKey?.trim() ?? '';
  if (key.length === 0 && args.profileId !== undefined) {
    const store = await loadProfileStore(args.dataDir ?? process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data'));
    const profile = findProfile(store, args.profileId);
    if (profile !== undefined) key = (await resolveProfileSecret(profile)).key;
  }
  const base = args.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');

  let url: string;
  let parse: (body: unknown) => readonly string[];
  if (preset.adapter === 'ollama') {
    const root = base.replace(/\/v1$/i, '');
    url = `${root}/api/tags`;
    parse = (body) => {
      const models = (body as { models?: unknown }).models;
      if (!Array.isArray(models)) return [];
      return models.flatMap((m) => {
        if (typeof m !== 'object' || m === null) return [];
        const name = (m as { name?: unknown }).name;
        return typeof name === 'string' ? [name] : [];
      });
    };
  } else {
    url = `${base}/models`;
    parse = (body) => {
      const data = (body as { data?: unknown }).data;
      if (!Array.isArray(data)) return [];
      return data.flatMap((m) => {
        if (typeof m !== 'object' || m === null) return [];
        const id = (m as { id?: unknown }).id;
        return typeof id === 'string' ? [id] : [];
      });
    };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (key.length > 0) headers.Authorization = `Bearer ${key}`;
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  } catch (err) {
    throw new Error(`无法连接 ${url}：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）`);
  const body = (await response.json()) as unknown;
  // 对话模型过滤明显的非对话端点；嵌入类型必须保留 embedding 模型。
  const nonChat = /(embedding|rerank|whisper|tts|dall-e|moderation|transcribe)/i;
  return [...new Set(parse(body).filter((id) => id.length > 0 && (preset.kind === 'embedding' || !nonChat.test(id))))].sort();
}

export interface ResolvedModel {
  readonly profile: ModelProfile;
  readonly model: ProfileModel;
  readonly preset: ModelPreset;
  readonly config: DeepSeekConfig;
}

export async function resolveProfileModel(
  dataDir: string,
  profileId: string,
  modelId: string,
  expectedKind: ProfileModelKind = 'chat',
): Promise<ResolvedModel | null> {
  const store = await loadProfileStore(dataDir);
  const profile = findProfile(store, profileId);
  if (profile === undefined) return null;
  const model = findModel(profile, modelId);
  if (model === undefined || model.kind !== expectedKind) return null;
  const preset = presetById(profile.presetId);
  if (preset === undefined) return null;
  const secret = await resolveProfileSecret(profile);
  if (preset.requiresKey && secret.key.length === 0) return null;
  return {
    profile,
    model,
    preset,
    config: {
      apiKey: secret.key,
      baseUrl: profile.baseUrl,
      model: model.id,
      timeoutMs: Number(process.env['MODEL_TIMEOUT_MS'] ?? 90_000),
      maxStructuredRetries: 2,
      thinkingParam: preset.adapter === 'deepseek',
    },
  };
}

export async function resolveActiveModel(dataDir: string): Promise<ResolvedModel | null> {
  const store = await loadProfileStore(dataDir);
  const active = store.active;
  if (active === null) return null;
  return resolveProfileModel(dataDir, active.profileId, active.modelId, 'chat');
}

export type { ModelPreset };
