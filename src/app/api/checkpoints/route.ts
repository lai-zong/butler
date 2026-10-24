/**
 * 检查点只读端点 —— 审计空间的「检查点」页签。
 *
 * 只做两件事：
 *   · GET /api/checkpoints        列出检查点（含失效原因）
 *   · GET /api/checkpoints?id=... 生成回退影响预览
 *
 * 不提供回退执行：回退是破坏性操作，第一版先让用户看清“会影响什么”。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import type { Checkpoint, RollbackPlan } from '@/core/checkpoint/types.js';
import { RollbackError } from '@/core/checkpoint/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function checkpointDto(cp: Checkpoint, labels: ReadonlyMap<string, string>): Record<string, unknown> {
  return {
    id: cp.id,
    seq: cp.seq,
    kind: cp.kind,
    label: cp.label,
    detail: cp.detail,
    createdAt: cp.createdAt,
    invalidatedBy: cp.invalidatedBy ?? null,
    artifactRefs: cp.snapshot.artifacts.map((a) => ({
      artifactId: a.artifactId,
      version: a.version,
      label: labels.get(a.artifactId) ?? a.artifactId,
    })),
    memoryCount: cp.snapshot.memories.length,
    usage: cp.snapshot.usage,
    completedSteps: cp.snapshot.completedSteps.length,
    pendingSteps: cp.snapshot.pendingSteps.length,
    failedSteps: cp.snapshot.failedSteps.length,
  };
}

function planDto(plan: RollbackPlan): Record<string, unknown> {
  return {
    toSeq: plan.toSeq,
    discardedEvents: plan.discardedEvents,
    artifactImpact: plan.artifactImpact,
    memoryImpact: plan.memoryImpact,
    keepSteps: plan.keepSteps,
    redoSteps: plan.redoSteps,
    executable: plan.executable,
    blockedReason: plan.blockedReason ?? null,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const checkpoints = rt.bootstrapped.checkpoints;

  // 检查点由事件流派生；启动时 sync 过一次，之后新事件需要再扫一遍才可见。
  checkpoints.sync();

  const id = req.nextUrl.searchParams.get('id');
  const all = checkpoints.all();
  const list = [...all].reverse();
  const labels = new Map(rt.bootstrapped.artifacts.all().map((a) => [a.id, a.label]));

  if (id === null || id.trim().length === 0) {
    return NextResponse.json({
      ok: true,
      now: rt.clock.now(),
      total: list.length,
      valid: checkpoints.valid().length,
      checkpoints: list.map((cp) => checkpointDto(cp, labels)),
    });
  }

  const checkpoint = checkpoints.byId(id);
  if (checkpoint === undefined) {
    return NextResponse.json({ error: '找不到这个检查点', reason: 'checkpoint_not_found' }, { status: 404 });
  }

  try {
    const plan = checkpoints.planRollback(id);
    return NextResponse.json({
      ok: true,
      now: rt.clock.now(),
      checkpoint: checkpointDto(checkpoint, labels),
      preview: planDto(plan),
    });
  } catch (err) {
    if (err instanceof RollbackError) {
      return NextResponse.json(
        {
          error: err.message,
          reason: err.reason,
          checkpoint: checkpointDto(checkpoint, labels),
        },
        { status: 409 },
      );
    }
    throw err;
  }
}
