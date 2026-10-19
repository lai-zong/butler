/**
 * 记忆列表端点 —— 记忆治理页的唯一数据来源
 *
 * `GET /api/memory`                     → 列表 + 全量统计
 * `GET /api/memory?id=mem_x`            → 单条详情 + 版本历史
 *
 * 设计纪律：
 *   ① 只读：不产生事件
 *   ② 统计永远基于**全量**，不基于筛选结果 —— 否则界面上的「待审 3 条」
 *      会随着过滤器变化，用户无法知道真实状态
 *   ③ 不在服务端做模糊的语义排序：界面要的是可预测的顺序
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { computeMemoryStats, toMemoryDto } from '@/app/server/uiData.js';
import { isDomainId } from '@/core/domain/types.js';
import type { MemoryClass, MemoryKind, MemoryLifecycle } from '@/core/memory/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLASSES: readonly MemoryClass[] = ['global_constraint', 'global_shared', 'sensitive', 'domain'];
const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'principle', 'summary'];
const LIFECYCLES: readonly MemoryLifecycle[] = ['candidate', 'active', 'dormant', 'archived'];

/** 默认排序：候选优先，其次按更新时间。让“等你决定”的东西先出现。 */
const LIFECYCLE_PRIORITY: Record<MemoryLifecycle, number> = {
  candidate: 0,
  active: 1,
  dormant: 2,
  archived: 3,
};

const MAX_ITEMS = 500;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const store = rt.bootstrapped.memory;
  const sp = req.nextUrl.searchParams;

  // ── 单条详情 ──
  const id = (sp.get('id') ?? '').trim();
  if (id.length > 0) {
    const entry = store.get(id);
    if (entry === undefined) {
      return NextResponse.json({ error: '找不到这条记忆' }, { status: 404 });
    }
    const revisions = store.revisionsOf(id).map((r) => ({
      id: r.id,
      version: r.version,
      reason: r.reason,
      actor: r.actor,
      createdAt: r.createdAt,
      before: r.patch.before,
      after: r.patch.after,
    }));
    return NextResponse.json({ ok: true, item: toMemoryDto(entry), revisions });
  }

  // ── 筛选 ──
  const q = (sp.get('q') ?? '').trim().toLowerCase();
  const lifecycleRaw = sp.get('lifecycle');
  const kindRaw = sp.get('kind');
  const classRaw = sp.get('memClass');
  const domainRaw = sp.get('domain');
  const sort = sp.get('sort') ?? 'priority';

  const lifecycle =
    lifecycleRaw !== null && (LIFECYCLES as readonly string[]).includes(lifecycleRaw)
      ? (lifecycleRaw as MemoryLifecycle)
      : undefined;
  const kind =
    kindRaw !== null && (KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as MemoryKind)
      : undefined;
  const memClass =
    classRaw !== null && (CLASSES as readonly string[]).includes(classRaw)
      ? (classRaw as MemoryClass)
      : undefined;
  const domain = domainRaw !== null && isDomainId(domainRaw) ? domainRaw : undefined;

  let items = store.all().filter((e) => {
    if (lifecycle !== undefined && e.lifecycle !== lifecycle) return false;
    if (kind !== undefined && e.kind !== kind) return false;
    if (memClass !== undefined && e.memClass !== memClass) return false;
    if (domain !== undefined && e.domain !== domain) return false;
    if (q.length > 0) {
      const haystack = [
        e.content,
        e.subject ?? '',
        e.principle?.condition ?? '',
        e.principle?.action ?? '',
      ]
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  items = [...items].sort((a, b) => {
    switch (sort) {
      case 'created':
        return b.createdAt - a.createdAt;
      case 'fitness':
        return b.fitness - a.fitness;
      case 'confidence':
        return b.confidence - a.confidence;
      case 'hits':
        return b.hitCount - a.hitCount;
      case 'updated':
        return b.updatedAt - a.updatedAt;
      default: {
        const lp = LIFECYCLE_PRIORITY[a.lifecycle] - LIFECYCLE_PRIORITY[b.lifecycle];
        return lp !== 0 ? lp : b.updatedAt - a.updatedAt;
      }
    }
  });

  const truncated = items.length > MAX_ITEMS;
  const page = truncated ? items.slice(0, MAX_ITEMS) : items;

  return NextResponse.json({
    ok: true,
    items: page.map(toMemoryDto),
    total: items.length,
    truncated,
    stats: computeMemoryStats(store.all()),
  });
}
