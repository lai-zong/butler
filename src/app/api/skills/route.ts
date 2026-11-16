/**
 * 本地技能库 API（V1：Markdown-only）。
 *
 * GET    /api/skills               列出技能
 * POST   /api/skills { action:'add', name, description, content }
 * POST   /api/skills { action:'delete', id }
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DATA_DIR } from '@/app/runtime';
import { addSkill, deleteSkill, loadSkillStore } from '@/app/server/skills.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function bodyRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function GET(): Promise<NextResponse> {
  try {
    const skills = await loadSkillStore(DATA_DIR);
    return NextResponse.json({ ok: true, skills });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '读取技能库失败' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const body = bodyRecord(raw);
  if (body === null) return NextResponse.json({ error: '请求体必须是对象' }, { status: 400 });
  const action = body['action'];

  try {
    if (action === 'add') {
      const name = typeof body['name'] === 'string' ? body['name'] : '';
      const description = typeof body['description'] === 'string' ? body['description'] : '';
      const content = typeof body['content'] === 'string' ? body['content'] : '';
      const skill = await addSkill(DATA_DIR, { name, description, content });
      return NextResponse.json({ ok: true, skill, skills: await loadSkillStore(DATA_DIR) });
    }
    if (action === 'delete') {
      const id = typeof body['id'] === 'string' ? body['id'] : '';
      if (id.length === 0) return NextResponse.json({ error: '缺少技能 id' }, { status: 400 });
      const removed = await deleteSkill(DATA_DIR, id);
      if (!removed) return NextResponse.json({ error: '找不到这个技能' }, { status: 404 });
      return NextResponse.json({ ok: true, skills: await loadSkillStore(DATA_DIR) });
    }
    return NextResponse.json({ error: '未知 action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '技能操作失败' },
      { status: 400 },
    );
  }
}
