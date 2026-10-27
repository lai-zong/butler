/**
 * 模型接入：用户配置、模型发现、当前模型切换。
 *
 * GET  /api/model：配置与当前状态（不返回 Key）
 * POST /api/model：
 *   - discover { presetId, baseUrl, profileId?, apiKey? }
 *   - create-profile { name, presetId, baseUrl, models, apiKey?, activate? }
 *   - update-profile { id, name, presetId, baseUrl, models, apiKey? }
 *   - delete-profile { id }
 *   - switch { profileId, modelId }
 *   - test { profileId, modelId }
 *
 * ★ 不保存/不返回 Key 明文；Key 只写本机凭证库。
 * ★ 流式与非流式由适配器自行处理，不做保存前验证。
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DATA_DIR, getRuntime, resetRuntime } from '@/app/runtime';
import { DeepSeekModel } from '@/adapters/model/deepseek.js';
import { OpenAICompatibleModel } from '@/adapters/model/openaiCompatible.js';
import { msg } from '@/core/ports/model.js';
import { isProviderEnvLocked } from '@/app/server/modelProvider.js';
import {
  createProfile,
  deleteProfileSecret,
  discoverModels,
  findModel,
  findProfile,
  DEFAULT_EMBEDDING_ROLE,
  loadProfileStore,
  resolveProfileSecret,
  saveProfileStore,
  updateProfile,
  updateProfileSecret,
  type ModelProfile,
} from '@/app/server/modelProfiles.js';
import { MODEL_PRESETS, presetById } from '@/app/server/modelPresets.js';
import { loadModelRoles, saveModelRoles } from '@/app/server/modelRoles.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  readonly action?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly presetId?: unknown;
  readonly baseUrl?: unknown;
  readonly models?: unknown;
  readonly apiKey?: unknown;
  readonly sessionId?: unknown;
  readonly profileId?: unknown;
  readonly modelId?: unknown;
  readonly activate?: unknown;
  readonly mode?: unknown;
}

async function profileView(profile: ModelProfile): Promise<Record<string, unknown>> {
  const secret = await resolveProfileSecret(profile);
  return {
    id: profile.id,
    name: profile.name,
    presetId: profile.presetId,
    baseUrl: profile.baseUrl,
    models: profile.models,
    hasKey: secret.key.length > 0,
    keySource: secret.source,
    requiresKey: presetById(profile.presetId)?.requiresKey ?? true,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

async function activeView(store: Awaited<ReturnType<typeof loadProfileStore>>): Promise<Record<string, unknown> | null> {
  if (store.active === null) return null;
  const profile = findProfile(store, store.active.profileId);
  if (profile === undefined) return null;
  const model = findModel(profile, store.active.modelId);
  if (model === undefined) return null;
  return {
    profileId: profile.id,
    profileName: profile.name,
    modelId: model.id,
    presetId: profile.presetId,
    baseUrl: profile.baseUrl,
    capabilities: model.capabilities,
  };
}

function nameTaken(profiles: readonly ModelProfile[], name: string, exceptId?: string): boolean {
  const normalized = name.trim().toLowerCase();
  return profiles.some((p) => p.id !== exceptId && p.name.trim().toLowerCase() === normalized);
}

function modelsOf(body: Body): readonly unknown[] {
  return Array.isArray(body.models) ? body.models : [];
}

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const store = await loadProfileStore(DATA_DIR);
  const roles = await loadModelRoles(DATA_DIR);
  const profiles = await Promise.all(store.profiles.map(profileView));
  const active = await activeView(store);
  const describe = rt.model?.describe() ?? null;
  return NextResponse.json(
    {
      ok: true,
      profiles,
      active,
      lastChat: store.lastChat,
      lastReview: store.lastReview,
      memory: roles.memory,
      rerank: roles.rerank,
      embedding: store.embedding,
      presets: MODEL_PRESETS,
      envLocked: isProviderEnvLocked(),
      runtime: describe,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const store = await loadProfileStore(DATA_DIR);

  if (action === 'discover') {
    const presetId = typeof body.presetId === 'string' ? body.presetId : '';
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
    if (presetById(presetId) === undefined) {
      return NextResponse.json({ error: '未知的模型预设' }, { status: 400 });
    }
    try {
      const models = await discoverModels({
        presetId,
        baseUrl,
        ...(typeof body.profileId === 'string' ? { profileId: body.profileId } : {}),
        ...(typeof body.apiKey === 'string' && body.apiKey.trim().length > 0
          ? { apiKey: body.apiKey.trim() }
          : {}),
        dataDir: DATA_DIR,
      });
      return NextResponse.json({ ok: true, models });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
  }

  if (action === 'create-profile') {
    try {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const presetId = typeof body.presetId === 'string' ? body.presetId : '';
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
      if (nameTaken(store.profiles, name)) {
        return NextResponse.json({ error: '配置名称已存在' }, { status: 409 });
      }
      let profile = createProfile({ name, presetId, baseUrl, models: modelsOf(body) });
      if (typeof body.apiKey === 'string' && body.apiKey.trim().length > 0) {
        profile = await updateProfileSecret(profile, body.apiKey);
      }
      const profiles = [...store.profiles, profile];
      const chatModel = profile.models.find((m) => m.kind === 'chat');
      const activate = body.activate !== false && chatModel !== undefined;
      if (activate) {
        const preset = presetById(profile.presetId);
        const secret = await resolveProfileSecret(profile);
        if (preset?.requiresKey === true && secret.key.length === 0) {
          return NextResponse.json({ error: '这个预设需要 API Key，填写后才能保存并启用。' }, { status: 400 });
        }
      }
      const active = activate && chatModel !== undefined
        ? { profileId: profile.id, modelId: chatModel.id }
        : store.active;
      await saveProfileStore(DATA_DIR, { version: 1, profiles, active, lastChat: store.lastChat, lastReview: store.lastReview, embedding: store.embedding });
      if (activate) await resetRuntime();
      return NextResponse.json({ ok: true, profile: await profileView(profile), active });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  }

  if (action === 'update-profile') {
    const id = typeof body.id === 'string' ? body.id : '';
    const existing = findProfile(store, id);
    if (existing === undefined) {
      return NextResponse.json({ error: '找不到这个模型配置' }, { status: 404 });
    }
    try {
      const nextName = typeof body.name === 'string' ? body.name.trim() : existing.name;
      if (nameTaken(store.profiles, nextName, id)) {
        return NextResponse.json({ error: '配置名称已存在' }, { status: 409 });
      }
      let updated = updateProfile(existing, {
        name: nextName,
        baseUrl: body.baseUrl,
        presetId: body.presetId,
        models: body.models,
      });
      if (typeof body.apiKey === 'string' && body.apiKey.trim().length > 0) {
        updated = await updateProfileSecret(updated, body.apiKey);
      }
      const profiles = store.profiles.map((p) => (p.id === id ? updated : p));
      let active = store.active;
      if (active?.profileId === id && !updated.models.some((m) => m.id === active!.modelId && m.kind === 'chat')) {
        const firstChat = profiles
          .flatMap((p) => p.models.filter((m) => m.kind === 'chat').map((m) => ({ profileId: p.id, modelId: m.id })))[0];
        active = firstChat ?? null;
      }
      const hasChat = (choice: { readonly profileId: string; readonly modelId: string } | null): boolean =>
        choice !== null &&
        profiles.some((p) => p.id === choice.profileId && p.models.some((m) => m.id === choice.modelId && m.kind === 'chat'));
      const lastChat = hasChat(store.lastChat) ? store.lastChat : active;
      const lastReview = hasChat(store.lastReview) ? store.lastReview : null;
      await saveProfileStore(DATA_DIR, { version: 1, profiles, active, lastChat, lastReview, embedding: store.embedding });
      await resetRuntime();
      return NextResponse.json({ ok: true, profile: await profileView(updated), active });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  }

  if (action === 'delete-profile') {
    const id = typeof body.id === 'string' ? body.id : '';
    const existing = findProfile(store, id);
    if (existing === undefined) {
      return NextResponse.json({ error: '找不到这个模型配置' }, { status: 404 });
    }
    await deleteProfileSecret(existing);
    const profiles = store.profiles.filter((p) => p.id !== id);
    const firstChat = profiles
      .flatMap((p) => p.models.filter((m) => m.kind === 'chat').map((m) => ({ profileId: p.id, modelId: m.id })))[0] ?? null;
    const active = store.active?.profileId === id ? firstChat : store.active;
    const validChat = (choice: { readonly profileId: string; readonly modelId: string } | null): boolean =>
      choice !== null &&
      profiles.some((p) => p.id === choice.profileId && p.models.some((m) => m.id === choice.modelId && m.kind === 'chat'));
    const lastChat = validChat(store.lastChat) ? store.lastChat : active;
    const lastReview = validChat(store.lastReview) ? store.lastReview : null;
    const embedding = store.embedding.kind === 'profile' && store.embedding.profileId === id
      ? DEFAULT_EMBEDDING_ROLE
      : store.embedding;
    await saveProfileStore(DATA_DIR, { version: 1, profiles, active, lastChat, lastReview, embedding });
    const roles = await loadModelRoles(DATA_DIR);
    if (roles.memory?.profileId === id || roles.rerank?.profileId === id) {
      await saveModelRoles(DATA_DIR, {
        ...roles,
        ...(roles.memory?.profileId === id ? { memory: null } : {}),
        ...(roles.rerank?.profileId === id ? { rerank: null } : {}),
      });
    }
    await resetRuntime();
    return NextResponse.json({ ok: true, active });
  }

  if (action === 'set-memory' || action === 'set-rerank') {
    const rt = await getRuntime();
    if (rt.activeTurns > 0) {
      return NextResponse.json(
        { error: '有对话正在执行，等这一轮结束后再更换模型角色。' },
        { status: 409 },
      );
    }
    const role = action === 'set-memory' ? 'memory' : 'rerank';
    const profileId = typeof body.profileId === 'string' ? body.profileId : '';
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const profile = findProfile(store, profileId);
    const model = profile !== undefined ? findModel(profile, modelId) : undefined;
    const expectedKind = role === 'memory' ? 'chat' : 'rerank';
    if (profile === undefined || model === undefined || model.kind !== expectedKind) {
      return NextResponse.json({ error: '找不到这个模型' }, { status: 404 });
    }
    const roles = await loadModelRoles(DATA_DIR);
    await saveModelRoles(DATA_DIR, {
      ...roles,
      [role]: { profileId, modelId },
    });
    await resetRuntime();
    return NextResponse.json({ ok: true, [role]: { profileId, modelId } });
  }

  if (action === 'set-embedding') {
    const rt = await getRuntime();
    if (rt.activeTurns > 0) {
      return NextResponse.json(
        { error: '有对话正在执行，等这一轮结束后再更换嵌入模型。' },
        { status: 409 },
      );
    }
    if (body.mode === 'builtin') {
      await saveProfileStore(DATA_DIR, { ...store, embedding: DEFAULT_EMBEDDING_ROLE });
      await resetRuntime();
      return NextResponse.json({ ok: true, embedding: DEFAULT_EMBEDDING_ROLE });
    }
    const profileId = typeof body.profileId === 'string' ? body.profileId : '';
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const profile = findProfile(store, profileId);
    const model = profile !== undefined ? findModel(profile, modelId) : undefined;
    if (profile === undefined || model === undefined || model.kind !== 'embedding') {
      return NextResponse.json({ error: '找不到这个嵌入模型' }, { status: 404 });
    }
    if (model.dimension === undefined || model.dimension <= 0) {
      return NextResponse.json({ error: '这个嵌入模型还没有配置向量维度。' }, { status: 400 });
    }
    const preset = presetById(profile.presetId);
    const secret = await resolveProfileSecret(profile);
    if (preset?.requiresKey === true && secret.key.length === 0) {
      return NextResponse.json({ error: '这个配置还没有 API Key。' }, { status: 400 });
    }
    const embedding = {
      kind: 'profile' as const,
      label: model.id,
      dimension: model.dimension,
      profileId,
      modelId,
    };
    await saveProfileStore(DATA_DIR, { ...store, embedding });
    await resetRuntime();
    return NextResponse.json({ ok: true, embedding });
  }

  if (action === 'rebuild-embedding') {
    const rt = await getRuntime();
    rt.semantic.clear();
    return NextResponse.json({ ok: true, rebuilt: true });
  }

  if (action === 'switch') {
    if (isProviderEnvLocked()) {
      return NextResponse.json(
        { error: 'MODEL_PROVIDER 已由环境变量锁定；请先删除该环境变量再切换。' },
        { status: 409 },
      );
    }
    const rt = await getRuntime();
    if (rt.activeTurns > 0) {
      return NextResponse.json(
        { error: '有对话正在执行，等这一轮结束后再切换模型。' },
        { status: 409 },
      );
    }
    const profileId = typeof body.profileId === 'string' ? body.profileId : '';
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const profile = findProfile(store, profileId);
    if (profile === undefined || findModel(profile, modelId) === undefined) {
      return NextResponse.json({ error: '找不到这个模型' }, { status: 404 });
    }
    const preset = presetById(profile.presetId);
    const secret = await resolveProfileSecret(profile);
    if (preset?.requiresKey === true && secret.key.length === 0) {
      return NextResponse.json({ error: '这个配置还没有 API Key，不能设为当前模型。' }, { status: 400 });
    }
    const active = { profileId, modelId };
    await saveProfileStore(DATA_DIR, { ...store, active });
    await resetRuntime();
    return NextResponse.json({ ok: true, active });
  }

  if (action === 'select-chat') {
    const profileId = typeof body.profileId === 'string' ? body.profileId : '';
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const profile = findProfile(store, profileId);
    const model = profile !== undefined ? findModel(profile, modelId) : undefined;
    if (profile === undefined || model === undefined || model.kind !== 'chat') {
      return NextResponse.json({ error: '找不到这个对话模型' }, { status: 404 });
    }
    const preset = presetById(profile.presetId);
    const secret = await resolveProfileSecret(profile);
    if (preset?.requiresKey === true && secret.key.length === 0) {
      return NextResponse.json({ error: '这个配置还没有 API Key。' }, { status: 400 });
    }
    if (sessionId.length === 0) {
      return NextResponse.json({ error: '缺少 sessionId' }, { status: 400 });
    }
    const rt = await getRuntime();
    const updated = rt.bootstrapped.chat.setSessionModel(sessionId, profileId, modelId);
    if (updated === undefined) {
      return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
    }
    const lastChat = { profileId, modelId };
    await saveProfileStore(DATA_DIR, { ...store, lastChat });
    return NextResponse.json({ ok: true, lastChat });
  }

  if (action === 'test') {
    const profileId = typeof body.profileId === 'string' ? body.profileId : '';
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const profile = findProfile(store, profileId);
    const model = profile !== undefined ? findModel(profile, modelId) : undefined;
    if (profile === undefined || model === undefined) {
      return NextResponse.json({ error: '找不到这个模型' }, { status: 404 });
    }
    const secret = await resolveProfileSecret(profile);
    const preset = presetById(profile.presetId);
    if (preset === undefined) return NextResponse.json({ error: '未知的模型预设' }, { status: 400 });
    if (preset.requiresKey && secret.key.length === 0) {
      return NextResponse.json({ error: '还没有配置 API Key' }, { status: 400 });
    }
    try {
      const cfg = {
        apiKey: secret.key.length > 0 ? secret.key : 'local',
        baseUrl: profile.baseUrl,
        model: model.id,
        timeoutMs: Number(process.env['MODEL_TIMEOUT_MS'] ?? 90_000),
        maxStructuredRetries: 1,
        thinkingParam: preset.adapter === 'deepseek',
      };
      const client =
        preset.adapter === 'deepseek'
          ? new DeepSeekModel(cfg)
          : new OpenAICompatibleModel(cfg, preset.adapter === 'ollama' ? 'ollama' : 'openai-compatible');
      const started = Date.now();
      const res = await client.complete({
        purpose: 'routing',
        messages: [msg.user('只回复 OK 两个字母，不要解释。')],
        maxOutputTokens: 256,
        temperature: 0,
        thinking: 'disabled',
        signal: AbortSignal.timeout(120_000),
      });
      return NextResponse.json({
        ok: true,
        latencyMs: Date.now() - started,
        model: res.model,
        text: res.text.slice(0, 80),
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({ error: `未知 action：${action}` }, { status: 400 });
}
