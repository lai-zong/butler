/**
 * 日记读取端点 —— 只读。
 *
 * GET /api/diary?day=YYYY-MM-DD&sessionId=...
 * GET /api/diary?id=diary_...
 *
 * 日记是派生的当日经历摘要；真正的来源仍是原始消息与事件。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { dayWindow } from '@/core/diary/time.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function publicDiary(d: {
  readonly id: string;
  readonly sessionId: string;
  readonly dayKey: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly content: string;
  readonly items: readonly unknown[];
  readonly sourceMessageIds: readonly string[];
  readonly model: string;
  readonly promptVersion: string;
  readonly createdAt: number;
}) {
  return {
    id: d.id,
    sessionId: d.sessionId,
    dayKey: d.dayKey,
    startAt: d.startAt,
    endAt: d.endAt,
    content: d.content,
    items: d.items,
    sourceMessageIds: d.sourceMessageIds,
    model: d.model,
    promptVersion: d.promptVersion,
    createdAt: d.createdAt,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const sp = req.nextUrl.searchParams;
  const id = (sp.get('id') ?? '').trim();
  const day = (sp.get('day') ?? '').trim();
  const sessionId = (sp.get('sessionId') ?? '').trim();

  if (id.length > 0) {
    const found = rt.diary.all().find((d) => d.id === id);
    if (!found) return NextResponse.json({ error: '找不到这篇日记' }, { status: 404 });
    return NextResponse.json({ ok: true, diary: publicDiary(found) });
  }

  if (day.length > 0) {
    try {
      dayWindow(day);
    } catch {
      return NextResponse.json({ error: '日期格式应为 YYYY-MM-DD' }, { status: 400 });
    }
  }

  const items = rt.diary
    .list({
      ...(day.length > 0 ? { dayKey: day } : {}),
      ...(sessionId.length > 0 ? { sessionId } : {}),
    })
    .map(publicDiary);

  return NextResponse.json({ ok: true, items, total: items.length });
}
