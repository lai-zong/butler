/**
 * 执行检查点回退。
 *
 * ⚠️ 这是破坏性操作：
 *   · 截断事件流到检查点 seq；
 *   · 之后的产出物标记为已取代（不删除内容）；
 *   · 需要重建运行时（记忆/会话/产出物/检查点全部从事件重放）。
 *
 * 因此必须满足：
 *   ① 显式 `confirm: true`；
 *   ② 没有正在执行的对话轮次；
 *   ③ 没有正在运行的定时任务；
 *   ④ 目标检查点可回退（planRollback 已校验）。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime, resetRuntime } from '@/app/runtime';
import { RollbackError } from '@/core/checkpoint/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  readonly id?: unknown;
  readonly confirm?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id.length === 0) {
    return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  }
  if (body.confirm !== true) {
    return NextResponse.json(
      { error: '回退是破坏性操作，需要 confirm: true' },
      { status: 400 },
    );
  }
  if (rt.activeTurns > 0) {
    return NextResponse.json(
      { error: '还有对话正在执行；等它结束后再回退' },
      { status: 409 },
    );
  }
  if (rt.activityRuntime.scheduler.isRunning()) {
    return NextResponse.json(
      { error: '定时任务正在运行；等它结束后再回退' },
      { status: 409 },
    );
  }

  try {
    const result = rt.bootstrapped.checkpoints.rollback(id, {
      artifacts: rt.bootstrapped.artifacts,
    });

    // 事件流已截断/追加；先把落盘刷掉，再重建整个运行时。
    await rt.bootstrapped.log.flushPersistence();
    await resetRuntime();

    // 重建后再标记待复核：先重建能确认这些记忆在回退后的状态里仍然存在，
    // 避免给一条已经被截断掉的记忆写“待复核”事件。
    const after = await getRuntime();
    let reviewedMemories = 0;
    for (const memoryId of result.memoriesToReview) {
      if (after.bootstrapped.memory.markForReview(memoryId)) reviewedMemories += 1;
    }
    if (reviewedMemories > 0) {
      await after.bootstrapped.log.flushPersistence();
    }

    return NextResponse.json({
      ok: true,
      fromSeq: result.fromSeq,
      toSeq: result.toSeq,
      discardedEvents: result.discarded.length,
      superseded: result.superseded,
      memoriesToReview: result.memoriesToReview,
      reviewedMemories,
      rolledBackAt: result.rolledBackAt,
    });
  } catch (err) {
    if (err instanceof RollbackError) {
      return NextResponse.json({ error: err.message, reason: err.reason }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
