/**
 * 记忆存档区 —— 单条操作
 *
 * `POST   /api/memory/archive/[id]   { action: 'restore' }`  恢复到记忆库
 * `DELETE /api/memory/archive/[id]`                           彻底删除（抹原文）
 *
 * ★ 这就是"两次删除"的第二步：只有在这里删，原文才会真正消失。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DEFAULT_USER_ID, getRuntime } from '@/app/runtime';
import { hashContent } from '@/core/events/scrub.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const rt = await getRuntime();

  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  if (body.action !== 'restore') {
    return NextResponse.json({ error: '只支持 action=restore' }, { status: 400 });
  }

  const record = await rt.memoryArchive.get(id);
  if (record === null) {
    return NextResponse.json({ error: '存档里找不到这条记录' }, { status: 404 });
  }

  const store = rt.bootstrapped.memory;
  if (store.get(record.memory.id) !== undefined) {
    return NextResponse.json(
      { error: '记忆库里已存在同 id 的记忆，无法恢复（可能已被恢复过）' },
      { status: 409 },
    );
  }

  const ok = store.restoreFromArchive(
    { kind: 'user', userId: DEFAULT_USER_ID },
    record.memory,
  );
  if (!ok) {
    return NextResponse.json({ error: '恢复失败' }, { status: 500 });
  }

  // 恢复成功后存档记录就失效了；先恢复、再删存档，避免"记忆没了、存档也删了"
  await rt.memoryArchive.remove(id);
  await rt.bootstrapped.log.flushPersistence().catch(() => undefined);

  return NextResponse.json({ ok: true, memoryId: record.memory.id, restored: true });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const rt = await getRuntime();

  const record = await rt.memoryArchive.get(id);
  if (record === null) {
    return NextResponse.json({ error: '存档里找不到这条记录' }, { status: 404 });
  }

  const store = rt.bootstrapped.memory;
  const log = rt.bootstrapped.log;
  const memoryId = record.memory.id;

  // 1) 兜底：万一它还在记忆库里（异常路径），先从库里拿掉
  if (store.get(memoryId) !== undefined) {
    store.takeOutForArchive({
      actor: { kind: 'user', userId: DEFAULT_USER_ID },
      id: memoryId,
      archiveId: id,
    });
  }

  // 2) 抹除事件流里的原文（这才是"彻底"）
  log.scrubForMemory(memoryId, record.memory.content);

  // 3) 墓碑：证明这里曾经有过内容，但不能还原
  log.append({
    type: 'intervention.forgotten',
    actor: 'user',
    payload: {
      memoryId,
      memClass: record.memory.memClass,
      hardConstraint: false,
      erased: true,
      contentHash: hashContent(record.memory.content),
      archiveId: id,
      note: '从存档区彻底删除：原文已抹除',
    },
    createdAt: rt.clock.now(),
  });

  await log.flushPersistence().catch(() => undefined);
  await rt.memoryArchive.remove(id);

  return NextResponse.json({ ok: true, memoryId, purged: true });
}
