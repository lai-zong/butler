/**
 * 记忆演化的用户干预入口（方案 §8.6：可观测 + 可干预）。
 *
 * POST /api/memory/evolution
 *   { id, action: 'boost' | 'lower' | 'revive' | 'archive' }
 *
 * 每次都走 EvolutionEngine 的正式方法：会落干预事件与演化日志，
 * 不是直接改 store 字段。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { toMemoryDto } from '@/app/server/uiData.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  readonly id?: unknown;
  readonly action?: unknown;
}

const DELTA = 0.1;

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const action = typeof body.action === 'string' ? body.action : '';
  if (id.length === 0) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  if (!['boost', 'lower', 'revive', 'archive'].includes(action)) {
    return NextResponse.json(
      { error: "action 只能是 boost / lower / revive / archive" },
      { status: 400 },
    );
  }

  const rt = await getRuntime();
  const entry = rt.bootstrapped.memory.get(id);
  if (entry === undefined) {
    return NextResponse.json({ error: '找不到这条记忆' }, { status: 404 });
  }

  let ok = false;
  if (action === 'boost') ok = rt.evolution.adjustWeight(id, DELTA, '用户手动提升权重');
  else if (action === 'lower') ok = rt.evolution.adjustWeight(id, -DELTA, '用户手动降低权重');
  else if (action === 'revive') ok = rt.evolution.forceRevive(id);
  else ok = rt.evolution.forceArchive(id);

  if (!ok) {
    return NextResponse.json(
      { error: entry.memClass === 'global_constraint' ? '全局硬约束不参与演化干预' : '当前状态不允许这个操作' },
      { status: 409 },
    );
  }

  const updated = rt.bootstrapped.memory.get(id);
  return NextResponse.json({
    ok: true,
    action,
    item: updated !== undefined ? toMemoryDto(updated) : null,
  });
}
