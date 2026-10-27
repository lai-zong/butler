/**
 * 从文档中选择性记住一条稳定事实。
 *
 * 这是用户明确点选的动作，不是 AI 猜测，因此直接生效为 active；
 * 不再走“先入候选、等审核”的旧路径（手动审核已停用）。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DEFAULT_USER_ID, getRuntime } from '@/app/runtime';
import { getDocumentStore } from '@/app/server/documents.js';
import type { DomainId } from '@/core/domain/types.js';
import type { MemoryClass, MemoryKind } from '@/core/memory/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'principle'];
const CLASSES: readonly MemoryClass[] = ['global_constraint', 'global_shared', 'sensitive', 'domain'];
const DOMAINS: readonly DomainId[] = ['life', 'health', 'study', 'work', 'code'];

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const rec = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const content = typeof rec['content'] === 'string' ? rec['content'].trim() : '';
  if (content.length === 0 || content.length > 500) {
    return NextResponse.json({ error: 'content 必须为 1—500 字' }, { status: 400 });
  }
  const kind = KINDS.includes(rec['kind'] as MemoryKind)
    ? (rec['kind'] as MemoryKind)
    : 'fact';
  const memClass = CLASSES.includes(rec['memClass'] as MemoryClass)
    ? (rec['memClass'] as MemoryClass)
    : 'domain';
  const domain = DOMAINS.includes(rec['domain'] as DomainId)
    ? (rec['domain'] as DomainId)
    : undefined;
  if (memClass === 'domain' && domain === undefined) {
    return NextResponse.json({ error: 'domain 类记忆必须指定 domain' }, { status: 400 });
  }

  const doc = await getDocumentStore().get(id);
  if (doc === null) return NextResponse.json({ error: '找不到这个文档' }, { status: 404 });

  const rt = await getRuntime();
  const created = rt.bootstrapped.memory.create(
    { kind: 'user', userId: DEFAULT_USER_ID },
    {
      memClass,
      kind,
      content,
      confidence: 0.95,
      evidence: [`文档：${doc.name}（${doc.id}）`],
      lifecycle: 'active',
      ...(domain !== undefined ? { domain } : {}),
    },
  );

  if (!created.ok) {
    return NextResponse.json(
      { error: created.reason ?? '当前不能写入这条记忆' },
      { status: 409 },
    );
  }

  await rt.bootstrapped.log.flushPersistence().catch(() => undefined);

  return NextResponse.json({
    ok: true,
    created: 1,
    ids: [created.entry.id],
    active: true,
  });
}
