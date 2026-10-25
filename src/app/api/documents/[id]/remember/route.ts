/**
 * 从文档中选择性记住一条稳定事实。
 *
 * ⚠️ 不是“整篇文档自动进记忆”：只接受用户明确提交的一条内容，
 *    先落为 candidate，仍需用户在记忆治理界面审核后才生效。
 */

import { randomUUID } from 'node:crypto';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { getDocumentStore } from '@/app/server/documents.js';
import type { DomainId } from '@/core/domain/types.js';
import { sinkCandidates } from '@/core/memory/sink.js';
import type { MemoryClass, MemoryKind } from '@/core/memory/types.js';
import type { MemoryCandidate } from '@/core/reflection/reflect.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'principle', 'summary'];
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
  const candidate: MemoryCandidate = {
    id: `cand_${randomUUID()}`,
    kind,
    content,
    confidence: 0.95,
    evidence: [`文档：${doc.name}（${doc.id}）`],
    scope: { memClass, ...(domain !== undefined ? { domain } : {}) },
    rationale: '用户从文档中明确选择记住这一条；先入候选，需审核后生效。',
    layer: 'butler',
    by: 'butler',
    createdAt: rt.clock.now(),
  };

  const sunk = sinkCandidates(
    { log: rt.bootstrapped.log, store: rt.bootstrapped.memory, clock: rt.clock },
    [candidate],
  );
  return NextResponse.json({
    ok: true,
    created: sunk.created.length,
    skipped: sunk.skipped,
    ids: sunk.created.map((m) => m.id),
    pendingReview: true,
  });
}
