/**
 * 知识库检索设置 —— 独立于记忆的模型角色与索引。
 *
 * GET  /api/knowledge/retrieval
 *   → 当前模式、知识库嵌入模型、重排开关、索引状态、可选嵌入连接
 *
 * POST /api/knowledge/retrieval
 *   - { action: 'set-mode', mode: 'lexical' | 'semantic' | 'hybrid' }
 *   - { action: 'set-embedding', kind: 'builtin' }
 *   - { action: 'set-embedding', kind: 'profile', profileId, modelId }
 *   - { action: 'set-rerank', enabled: boolean }
 *   - { action: 'rebuild' }
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getKnowledgeService } from '@/app/server/knowledge.js';
import {
  loadKnowledgeConfig,
  type KnowledgeEmbedding,
} from '@/app/server/knowledge.js';
import type { KnowledgeRetrievalMode } from '@/core/documents/retrieval.js';
import {
  findModel,
  findProfile,
  loadProfileStore,
  resolveProfileSecret,
} from '@/app/server/modelProfiles.js';
import { presetById } from '@/app/server/modelPresets.js';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly kind?: unknown;
  readonly profileId?: unknown;
  readonly modelId?: unknown;
  readonly enabled?: unknown;
}

function isMode(value: unknown): value is KnowledgeRetrievalMode {
  return value === 'lexical' || value === 'semantic' || value === 'hybrid';
}

async function currentState(): Promise<Record<string, unknown>> {
  const service = getKnowledgeService();
  const config = await loadKnowledgeConfig();
  return {
    ok: true,
    config,
    status: await service.status(),
    choices: await service.embeddingChoices(),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await currentState(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '知识库检索状态读取失败' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const service = getKnowledgeService();
  const config = await loadKnowledgeConfig();

  if (action === 'set-mode') {
    if (!isMode(body.mode)) {
      return NextResponse.json({ error: '检索模式不合法' }, { status: 400 });
    }
    await service.setConfig({ ...config, mode: body.mode });
    return NextResponse.json(await currentState());
  }

  if (action === 'set-embedding') {
    let embedding: KnowledgeEmbedding;
    if (body.kind === 'builtin') {
      embedding = {
        kind: 'builtin',
        label: 'bge-base-zh-v1.5',
        dimension: 768,
      };
    } else if (body.kind === 'profile') {
      const profileId = typeof body.profileId === 'string' ? body.profileId : '';
      const modelId = typeof body.modelId === 'string' ? body.modelId : '';
      const store = await loadProfileStore(
        process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data'),
      );
      const profile = findProfile(store, profileId);
      const model = profile === undefined ? undefined : findModel(profile, modelId);
      if (profile === undefined || model === undefined || model.kind !== 'embedding') {
        return NextResponse.json({ error: '找不到这个知识库嵌入模型' }, { status: 404 });
      }
      if (model.dimension === undefined || model.dimension <= 0) {
        return NextResponse.json({ error: '这个嵌入模型还没有配置向量维度' }, { status: 400 });
      }
      const secret = await resolveProfileSecret(profile);
      const preset = presetById(profile.presetId);
      if (preset?.requiresKey === true && secret.key.length === 0) {
        return NextResponse.json({ error: '这个配置还没有 API Key' }, { status: 400 });
      }
      embedding = {
        kind: 'profile',
        profileId,
        modelId,
        label: modelId,
        dimension: model.dimension,
      };
    } else {
      return NextResponse.json({ error: '未知的嵌入模型类型' }, { status: 400 });
    }
    await service.setConfig({ ...config, embedding });
    return NextResponse.json(await currentState());
  }

  if (action === 'set-rerank') {
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled 必须是布尔值' }, { status: 400 });
    }
    await service.setConfig({ ...config, rerank: body.enabled });
    return NextResponse.json(await currentState());
  }

  if (action === 'rebuild') {
    try {
      const status = await service.rebuild();
      return NextResponse.json({ ok: true, config: await loadKnowledgeConfig(), status });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : '知识库索引重建失败' },
        { status: 503 },
      );
    }
  }

  return NextResponse.json({ error: `未知 action：${action}` }, { status: 400 });
}
