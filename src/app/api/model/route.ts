/**
 * 模型厂商状态、验证与切换。
 *
 * GET  /api/model          当前模型 + 各 provider 是否配置（不返回 Key）
 * POST /api/model          { action:'validate'|'switch', provider, model? }
 *
 * 纪律：
 *   · 只允许切到“已配置 Key/端点且验证通过”的 provider；
 *   · MODEL_PROVIDER 环境变量存在时锁定，UI 不能覆盖；
 *   · 不返回、不记录任何 Key 明文；
 *   · OpenAI 兼容/Ollama 当前只承诺非流式；流式能力在响应里如实标注。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DATA_DIR, getRuntime, resetRuntime } from '@/app/runtime';
import {
  buildProviderConfig,
  createProviderModel,
  isModelProviderId,
  listProviderStatuses,
  loadSelection,
  saveSelection,
  type ModelProviderId,
} from '@/app/server/modelProvider.js';
import { msg } from '@/core/ports/model.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  readonly action?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
}

function providerOf(body: Body): ModelProviderId | null {
  return isModelProviderId(body.provider) ? body.provider : null;
}

async function validateProvider(args: {
  readonly provider: ModelProviderId;
  readonly model?: string;
}): Promise<{
  readonly ok: true;
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly latencyMs: number;
  readonly text: string;
}> {
  const built = await buildProviderConfig({
    provider: args.provider,
    ...(args.model !== undefined ? { selection: { provider: args.provider, model: args.model } } : {}),
  });
  const model = createProviderModel(args.provider, built.config);
  const started = Date.now();
  const res = await model.complete({
    purpose: 'routing',
    messages: [msg.user('只回复 OK 两个字母，不要解释。')],
    // 256 是给“会先思考再回答”的本地模型留的余量；32 会被思考吃光。
    maxOutputTokens: 256,
    temperature: 0,
    thinking: 'disabled',
    signal: AbortSignal.timeout(120_000),
  });
  if (res.text.trim().length === 0) {
    throw new Error(`模型返回空文本（finish_reason=${res.finishReason}）`);
  }
  return {
    ok: true,
    provider: args.provider,
    model: res.model,
    latencyMs: Date.now() - started,
    text: res.text.slice(0, 80),
  };
}

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const loaded = await loadSelection(DATA_DIR);
  const providers = await listProviderStatuses();
  const describe = rt.model?.describe() ?? null;
  return NextResponse.json(
    {
      ok: true,
      current: {
        provider: loaded.selection.provider,
        model: describe?.model ?? null,
        providerLabel:
          describe?.provider === 'deepseek'
            ? 'deepseek'
            : loaded.selection.provider === 'ollama'
              ? 'ollama'
              : loaded.selection.provider,
        capabilities: describe?.capabilities ?? null,
        streaming: loaded.selection.provider === 'deepseek',
      },
      selection: loaded.selection,
      envLocked: loaded.envLocked,
      providers,
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
  const provider = providerOf(body);
  if (provider === null) {
    return NextResponse.json({ error: 'provider 只能是 deepseek / openai / ollama' }, { status: 400 });
  }
  const model = typeof body.model === 'string' && body.model.trim().length > 0
    ? body.model.trim()
    : undefined;

  if (action === 'validate') {
    try {
      return NextResponse.json(await validateProvider({ provider, ...(model !== undefined ? { model } : {}) }));
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 502 },
      );
    }
  }

  if (action === 'switch') {
    const loaded = await loadSelection(DATA_DIR);
    if (loaded.envLocked) {
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

    let checked: Awaited<ReturnType<typeof validateProvider>>;
    try {
      checked = await validateProvider({ provider, ...(model !== undefined ? { model } : {}) });
    } catch (err) {
      return NextResponse.json(
        { error: `验证失败：${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }

    await saveSelection(DATA_DIR, {
      provider,
      ...(model !== undefined ? { model } : {}),
    });
    await resetRuntime();
    const next = await getRuntime();
    return NextResponse.json({
      ok: true,
      switched: {
        provider,
        model: checked.model,
        latencyMs: checked.latencyMs,
        streaming: provider === 'deepseek',
      },
      current: {
        provider,
        model: next.model?.describe().model ?? null,
        capabilities: next.model?.describe().capabilities ?? null,
      },
    });
  }

  return NextResponse.json({ error: `未知 action：${action}` }, { status: 400 });
}
