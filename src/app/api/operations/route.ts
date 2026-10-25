/**
 * 操作记忆（方案 § 6.3）
 *
 * GET  /api/operations
 *   → { ok, now, counts, apps, operations: [...] }
 * POST /api/operations
 *   { kind:'preference'|'environment', content, taskLabel, evidence? }
 *   → 显式新增一条偏好/环境记忆
 *
 * ★ GET 只读：
 *   方法记忆的写入发生在工具真实执行之后（成功/失败/耗时），
 *   由核心层按证据记录；界面不能手动改成功率。
 *
 * ★ POST 只新增“用户明确说出的偏好/环境事实”，不修改历史成功率；
 *   这是用户输入，不是模型推测。凭证内容一律拒绝。
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
import { containsCredential } from '@/core/tools/redact.js';

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

interface OperationBody {
  readonly kind?: unknown;
  readonly content?: unknown;
  readonly taskLabel?: unknown;
  readonly evidence?: unknown;
}

const MAX_CONTENT = 2_000;
const MAX_TASK_LABEL = 200;
const MAX_EVIDENCE = 1_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: OperationBody;
  try {
    body = (await req.json()) as OperationBody;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const kind = body.kind;
  if (kind !== 'preference' && kind !== 'environment') {
    return NextResponse.json(
      { error: "kind 只能是 'preference' 或 'environment'" },
      { status: 400 },
    );
  }

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const taskLabel = typeof body.taskLabel === 'string' ? body.taskLabel.trim() : '';
  const evidence = typeof body.evidence === 'string' ? body.evidence.trim() : undefined;

  if (content.length === 0 || content.length > MAX_CONTENT) {
    return NextResponse.json(
      { error: `content 必须是 1–${MAX_CONTENT} 字符` },
      { status: 400 },
    );
  }
  if (taskLabel.length === 0 || taskLabel.length > MAX_TASK_LABEL) {
    return NextResponse.json(
      { error: `taskLabel 必须是 1–${MAX_TASK_LABEL} 字符` },
      { status: 400 },
    );
  }
  if (evidence !== undefined && evidence.length > MAX_EVIDENCE) {
    return NextResponse.json(
      { error: `evidence 最多 ${MAX_EVIDENCE} 字符` },
      { status: 400 },
    );
  }

  const fields = [content, taskLabel, ...(evidence !== undefined ? [evidence] : [])];
  if (fields.some((s) => containsCredential(s))) {
    return NextResponse.json(
      { error: '内容包含凭证，拒绝写入操作记忆' },
      { status: 400 },
    );
  }

  const rt = await getRuntime();
  const store = rt.bootstrapped.operations;
  const created = kind === 'preference'
    ? store.recordPreference({
        content,
        taskLabel,
        ...(evidence !== undefined ? { evidence } : {}),
      })
    : store.recordEnvironment({
        content,
        taskLabel,
        ...(evidence !== undefined ? { evidence } : {}),
      });

  await rt.bootstrapped.log.flushPersistence();

  return NextResponse.json({
    ok: true,
    operation: {
      id: created.id,
      kind: created.kind,
      content: created.content,
      taskLabel: created.taskLabel,
      evidenceCount: created.evidence.length,
      createdAt: created.createdAt,
    },
  });
}
