/**
 * 操作记忆 —— 只读数据源（方案 § 6.3）
 *
 * GET /api/operations
 *   → { ok, now, counts, apps, operations: [...] }
 *
 * ★ 为什么只读：
 *   操作记忆的写入发生在工具真实执行之后（成功/失败/耗时），
 *   由核心层按证据记录。界面手动改成功率会让"记忆"变成可编造的展示。
 *
 * ★ 为什么默认不返回 evidence 原文：
 *   evidence 是指向事件/任务的引用，可能含路径或任务文本；
 *   这里只返回条数，详情要展开时再单条取（后续若要，另加端点）。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import type { OperationKind } from '@/core/memory/operation.js';
import { PATH_LABEL, successRate, summarizeOperation } from '@/core/memory/operations.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KINDS: readonly OperationKind[] = ['method', 'preference', 'environment'];

const KIND_LABEL: Record<OperationKind, string> = {
  method: '方法',
  preference: '偏好',
  environment: '环境',
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const all = rt.bootstrapped.operations.all();

  const kindParam = (req.nextUrl.searchParams.get('kind') ?? '').trim();
  if (kindParam.length > 0 && !(KINDS as readonly string[]).includes(kindParam)) {
    return NextResponse.json(
      { error: `kind 只能是 ${KINDS.join(' / ')}` },
      { status: 400 },
    );
  }

  const appParam = (req.nextUrl.searchParams.get('app') ?? '').trim();
  const filtered = all.filter(
    (m) =>
      (kindParam.length === 0 || m.kind === kindParam) &&
      (appParam.length === 0 || m.app === appParam),
  );

  const counts: Record<OperationKind, number> = {
    method: 0,
    preference: 0,
    environment: 0,
  };
  for (const m of all) counts[m.kind] += 1;

  const apps = [...new Set(all.map((m) => m.app).filter((a): a is string => typeof a === 'string' && a.length > 0))]
    .sort((a, b) => a.localeCompare(b));

  const operations = [...filtered]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      kindLabel: KIND_LABEL[m.kind],
      taskLabel: m.taskLabel,
      taskSignature: m.taskSignature,
      app: m.app ?? null,
      content: m.content,
      path: m.path ?? null,
      pathLabel: m.path !== undefined ? PATH_LABEL[m.path] : null,
      confidence: m.confidence,
      effectiveness:
        m.effectiveness !== undefined
          ? {
              attempts: m.effectiveness.attempts,
              succeeded: m.effectiveness.succeeded,
              successRate: successRate(m),
              lastUsedAt: m.effectiveness.lastUsedAt,
              lastFailure: m.effectiveness.lastFailure ?? null,
              avgDurationMs: m.effectiveness.avgDurationMs,
              consecutiveFailures: m.effectiveness.consecutiveFailures ?? 0,
            }
          : null,
      summary: summarizeOperation(m),
      evidenceCount: m.evidence.length,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

  return NextResponse.json({
    ok: true,
    now: Date.now(),
    counts,
    apps,
    operations,
  });
}
