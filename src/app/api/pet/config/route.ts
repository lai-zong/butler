/**
 * 桌宠配置：设置页读取/保存用户偏好。
 *
 * Python 桌宠进程也会直接读取同一个 JSON；这里不启动/控制进程，
 * 避免一个 HTTP 设置页拥有静默结束用户桌宠进程的权力。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  isPetDisplayMode,
  isPetProactiveFrequency,
  isPetThinkingLevel,
  listPetAssets,
  loadPetConfig,
  savePetConfig,
  type PetConfigUpdate,
  type PetModelChoice,
  type PetProactiveScenarios,
} from '@/app/server/petConfig.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const [config, assets] = await Promise.all([loadPetConfig(), listPetAssets()]);
  return NextResponse.json({ ok: true, config, assets });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = record(await req.json());
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const patch: PetConfigUpdate = {
    ...(typeof body['enabled'] === 'boolean' ? { enabled: body['enabled'] } : {}),
    ...(isPetDisplayMode(body['displayMode']) ? { displayMode: body['displayMode'] } : {}),
    ...(typeof body['autoStart'] === 'boolean' ? { autoStart: body['autoStart'] } : {}),
    ...(typeof body['size'] === 'number' ? { size: body['size'] } : {}),
    ...(typeof body['sprite'] === 'string' ? { sprite: body['sprite'] } : {}),
    ...(typeof body['alwaysOnTop'] === 'boolean' ? { alwaysOnTop: body['alwaysOnTop'] } : {}),
    ...(body['model'] === null
      ? { model: null }
      : typeof body['model'] === 'object' && body['model'] !== null
        ? { model: body['model'] as PetModelChoice }
        : {}),
    ...(isPetThinkingLevel(body['thinkingLevel'])
      ? { thinkingLevel: body['thinkingLevel'] }
      : {}),
    ...(typeof body['persona'] === 'string' ? { persona: body['persona'] } : {}),
    ...(typeof body['proactiveEnabled'] === 'boolean'
      ? { proactiveEnabled: body['proactiveEnabled'] }
      : {}),
    ...(isPetProactiveFrequency(body['proactiveFrequency'])
      ? { proactiveFrequency: body['proactiveFrequency'] }
      : {}),
    ...(typeof body['quietStart'] === 'string' ? { quietStart: body['quietStart'] } : {}),
    ...(typeof body['quietEnd'] === 'string' ? { quietEnd: body['quietEnd'] } : {}),
    ...(typeof body['proactiveScenarios'] === 'object' && body['proactiveScenarios'] !== null
      ? { proactiveScenarios: body['proactiveScenarios'] as PetProactiveScenarios }
      : {}),
  };

  try {
    const config = await savePetConfig(patch);
    const assets = await listPetAssets();
    return NextResponse.json({ ok: true, config, assets });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
