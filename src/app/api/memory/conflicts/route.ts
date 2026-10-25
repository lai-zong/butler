/**
 * 记忆冲突读取（只读）
 *
 * GET /api/memory/conflicts
 *
 * 来源是 `conflict.detected` 事件（自动检测只写事件，不改 MemoryEntry）。
 * 返回 memoryId / otherMemoryId / 原因 / 检测器，供 MemoryView 显示。
 */

import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ConflictRow {
  readonly memoryId: string;
  readonly otherMemoryId: string;
  readonly reason: string;
  readonly detector: string;
  readonly createdAt: number;
  readonly other: {
    readonly content: string;
    readonly memClass: string;
    readonly kind: string;
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();
  const store = rt.bootstrapped.memory;
  const seen = new Set<string>();
  const rows: ConflictRow[] = [];

  for (const event of rt.bootstrapped.log.all()) {
    if (event.type !== 'conflict.detected') continue;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const memoryId = asString(p['memoryId']);
    const memoryIds = Array.isArray(p['memoryIds'])
      ? p['memoryIds'].filter((x): x is string => typeof x === 'string')
      : [];
    const otherMemoryId = memoryIds[0] ?? '';
    if (memoryId.length === 0 || otherMemoryId.length === 0) continue;

    const entry = store.get(memoryId);
    const other = store.get(otherMemoryId);
    if (entry === undefined || other === undefined) continue;

    const key = `${memoryId}|${otherMemoryId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      memoryId,
      otherMemoryId,
      reason: asString(p['reason']) || '检测到可能冲突',
      detector: asString(p['detector']) || 'unknown',
      createdAt: event.createdAt,
      other: {
        content: other.content,
        memClass: other.memClass,
        kind: other.kind,
      },
    });
  }

  return NextResponse.json({ ok: true, conflicts: rows });
}
