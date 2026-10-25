/**
 * 记忆冲突裁决（显式用户操作）
 *
 * POST /api/memory/verdict
 *   { winnerId, loserId }
 *
 * ★ 这不是自动冲突检测：检测仍缺。这里只提供“用户已经明确选边”后的
 *   生产调用 —— winner 计一次成功，loser 降权 0.05，不删除任何一条。
 *   没有证据/冲突内容的自动裁决不做，避免凭猜测改记忆。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  readonly winnerId?: unknown;
  readonly loserId?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const winnerId = typeof body.winnerId === 'string' ? body.winnerId.trim() : '';
  const loserId = typeof body.loserId === 'string' ? body.loserId.trim() : '';
  if (winnerId.length === 0 || loserId.length === 0) {
    return NextResponse.json({ error: 'winnerId 与 loserId 都必须给出' }, { status: 400 });
  }
  if (winnerId === loserId) {
    return NextResponse.json({ error: 'winnerId 与 loserId 不能相同' }, { status: 400 });
  }

  const rt = await getRuntime();
  const store = rt.bootstrapped.memory;
  const winner = store.get(winnerId);
  const loser = store.get(loserId);
  if (winner === undefined || loser === undefined) {
    return NextResponse.json(
      { error: '找不到指定的记忆', winner: winner !== undefined, loser: loser !== undefined },
      { status: 404 },
    );
  }
  if (
    winner.memClass === 'sensitive' ||
    loser.memClass === 'sensitive' ||
    winner.memClass === 'global_constraint' ||
    loser.memClass === 'global_constraint'
  ) {
    return NextResponse.json(
      { error: '敏感域 / 全局硬约束记忆不能通过此端点做裁决' },
      { status: 409 },
    );
  }

  const won = store.recordVerdict(winnerId, 'won');
  const lost = store.recordVerdict(loserId, 'lost');
  if (!won.ok || !lost.ok) {
    return NextResponse.json({ error: '裁决失败：记忆状态已变化' }, { status: 409 });
  }

  rt.bootstrapped.log.append({
    type: 'conflict.resolved',
    actor: 'user',
    payload: {
      action: 'manualVerdict',
      winnerId,
      loserId,
      winnerFitness: won.fitnessAfter,
      loserFitness: lost.fitnessAfter,
      note: '用户显式裁决；只降权/计成功，不删除记忆',
    },
    createdAt: rt.clock.now(),
  });
  await rt.bootstrapped.log.flushPersistence();

  return NextResponse.json({
    ok: true,
    winner: { id: winnerId, fitnessBefore: won.fitnessBefore, fitnessAfter: won.fitnessAfter },
    loser: { id: loserId, fitnessBefore: lost.fitnessBefore, fitnessAfter: lost.fitnessAfter },
  });
}
