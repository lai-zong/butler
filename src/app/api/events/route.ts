/**
 * 事件流端点 —— 审计页的“原始事实”视图
 *
 * `GET /api/events?limit=60&before=123&family=memoryLifecycle&q=召回`
 *   → 倒序事件列表（只带可读摘要，不带完整 payload）
 *
 * `GET /api/events?seq=123`
 *   → 单条事件的**完整 payload**（点开某一行时才请求）
 *
 * ★ 为什么列表不直接带 payload：
 *   有的 payload 里带 agentTrace / servantReports，单条就可能几十 KB。
 *   列表只需要“是什么、什么时候、谁做的、一句话摘要”。
 *   要看原文时按 seq 精确拉取 —— 这也更符合“可审计”的做法：
 *   用户先看到结论，再决定要不要追到原始事件。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { sanitizeEventForClient, toEventDto, type EventDto } from '@/app/server/uiData.js';
import { eventFamily } from '@/app/server/uiData.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_LIMIT = 200;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const log = rt.bootstrapped.log;
  const sp = req.nextUrl.searchParams;

  // ── 单条原文 ──
  const seqRaw = sp.get('seq');
  if (seqRaw !== null) {
    const seq = Number(seqRaw);
    if (!Number.isInteger(seq) || seq < 1) {
      return NextResponse.json({ error: 'seq 必须是正整数' }, { status: 400 });
    }
    const event = log.all().find((e) => e.seq === seq);
    if (event === undefined) {
      return NextResponse.json({ error: '找不到这个 seq 的事件' }, { status: 404 });
    }
    // ★ 答案卷不出现在原始事件里（练习的"提交后才下发答案"承诺）
    return NextResponse.json({ ok: true, event: sanitizeEventForClient(event) });
  }

  // ── 列表 ──
  const family = (sp.get('family') ?? '').trim();
  const typesRaw = (sp.get('type') ?? '').trim();
  const q = (sp.get('q') ?? '').trim().toLowerCase();
  const beforeRaw = sp.get('before');
  const limitRaw = Number(sp.get('limit') ?? '60');

  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
    : 60;

  const before = beforeRaw !== null && Number.isFinite(Number(beforeRaw)) ? Number(beforeRaw) : null;
  const types = typesRaw.length > 0 ? new Set(typesRaw.split(',').map((s) => s.trim())) : null;

  let filtered = log.all().filter((e) => {
    if (before !== null && e.seq >= before) return false;
    if (family.length > 0 && family !== 'all' && eventFamily(e.type) !== family) return false;
    if (types !== null && !types.has(e.type)) return false;
    return true;
  });

  if (q.length > 0) {
    filtered = filtered.filter((e) => {
      const dto = toEventDto(e);
      return (
        e.type.toLowerCase().includes(q) ||
        dto.label.toLowerCase().includes(q) ||
        dto.summary.toLowerCase().includes(q)
      );
    });
  }

  const total = filtered.length;
  const page = filtered.slice(-limit).reverse();
  const items: EventDto[] = page.map(toEventDto);
  const oldest = page[page.length - 1];

  return NextResponse.json({
    ok: true,
    items,
    total,
    hasMore: total > page.length,
    nextBefore: oldest !== undefined ? oldest.seq : null,
  });
}
