/**
 * 敏感域授权（后端入口；MemoryView 已接入）
 *
 * POST /api/memory/grant
 *   { memoryId, taskId, purpose, ttlMs?, to? }
 *
 * DELETE /api/memory/grant
 *   { taskId }
 *
 * 设计依据：方案 §2.2⑥ / §13.8.2
 *   · 只对 sensitive 记忆生效；
 *   · 授权按 taskId 生效，TTL 只是兜底；
 *   · 任务结束或用户撤销时立即失效；
 *   · 所有授权/读取/过期都落事件。
 *
 * ⚠️ 安全语义固定在这里；MemoryView 的授权入口只调用本 API，不重复实现规则。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { DOMAIN_IDS, type DomainId } from '@/core/domain/types.js';
import {
  MAX_GRANT_TTL_MS,
  MIN_GRANT_TTL_MS,
  type MemoryStore,
} from '@/core/memory/store.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface GrantBody {
  readonly memoryId?: unknown;
  readonly taskId?: unknown;
  readonly purpose?: unknown;
  readonly ttlMs?: unknown;
  readonly to?: unknown;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseDomain(value: unknown): DomainId | null {
  return typeof value === 'string' && (DOMAIN_IDS as readonly string[]).includes(value)
    ? (value as DomainId)
    : null;
}

function getStore(): Promise<MemoryStore> {
  return getRuntime().then((rt) => rt.bootstrapped.memory);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: GrantBody;
  try {
    body = (await req.json()) as GrantBody;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const memoryId = asNonEmptyString(body.memoryId);
  const taskId = asNonEmptyString(body.taskId);
  const purpose = asNonEmptyString(body.purpose);
  if (memoryId.length === 0) {
    return NextResponse.json({ error: '缺少 memoryId' }, { status: 400 });
  }
  if (taskId.length === 0) {
    return NextResponse.json({ error: '缺少 taskId' }, { status: 400 });
  }
  if (purpose.length === 0) {
    return NextResponse.json({ error: '缺少 purpose' }, { status: 400 });
  }

  const store = await getStore();
  const entry = store.get(memoryId);
  if (entry === undefined) {
    return NextResponse.json({ error: '找不到这条记忆' }, { status: 404 });
  }
  if (entry.memClass !== 'sensitive') {
    return NextResponse.json(
      { error: '只有敏感域记忆需要授权' },
      { status: 409 },
    );
  }

  const to = parseDomain(body.to) ?? entry.domain ?? null;
  if (to === null) {
    return NextResponse.json(
      { error: '这条敏感记忆没有领域标签，必须显式提供 to' },
      { status: 400 },
    );
  }

  let ttlMs = DEFAULT_TTL_MS;
  if (body.ttlMs !== undefined) {
    if (typeof body.ttlMs !== 'number' || !Number.isFinite(body.ttlMs)) {
      return NextResponse.json({ error: 'ttlMs 必须是数字' }, { status: 400 });
    }
    ttlMs = Math.floor(body.ttlMs);
  }
  if (ttlMs < MIN_GRANT_TTL_MS || ttlMs > MAX_GRANT_TTL_MS) {
    return NextResponse.json(
      {
        error: `ttlMs 必须在 ${MIN_GRANT_TTL_MS}–${MAX_GRANT_TTL_MS} 之间`,
      },
      { status: 400 },
    );
  }

  const result = store.grant({
    actor: { kind: 'user', userId: 'local' },
    memoryId,
    to,
    taskId,
    purpose,
    ttlMs,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason ?? '授权失败', reason: result.reason },
      { status: 409 },
    );
  }

  await getRuntime().then((rt) => rt.bootstrapped.log.flushPersistence());

  return NextResponse.json({
    ok: true,
    memoryId,
    taskId,
    to,
    expiresAt: result.expiresAt ?? null,
    ttlMs,
  });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  let body: GrantBody;
  try {
    body = (await req.json()) as GrantBody;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const taskId = asNonEmptyString(body.taskId);
  if (taskId.length === 0) {
    return NextResponse.json({ error: '缺少 taskId' }, { status: 400 });
  }

  const store = await getStore();
  const removed = store.revokeGrantsForTask(taskId);
  if (removed > 0) {
    await getRuntime().then((rt) => rt.bootstrapped.log.flushPersistence());
  }

  return NextResponse.json({ ok: true, taskId, removed });
}
