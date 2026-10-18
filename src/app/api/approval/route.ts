/**
 * 用户答复确认请求（C6 询问开关的答复端）
 *
 * `POST /api/approval  { id, allow }`
 *
 * ★ 为什么需要**单独的端点**：
 *   确认请求是在 SSE 流里推出去的（`{ type:'approval', id, ... }`），
 *   而用户点"允许"是一次**新的 HTTP 请求** ——
 *   两者不在同一个闭包里，只能靠 `core/tools/approval.ts` 的按 id 登记表接上。
 *
 * ⚠️ 答复只对**当前挂着的那一条**有效：
 *   id 已经答复过、超时了、或流已经结束（被 `denyAllPending` 清掉）都会返回 404，
 *   不会"补答"一个已经作废的请求。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { pendingApprovalCount, resolveApproval } from '@/core/tools/approval.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { id?: unknown; allow?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; allow?: unknown };
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (id.length === 0) {
    return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  }
  if (typeof body.allow !== 'boolean') {
    return NextResponse.json({ error: 'allow 必须是布尔值' }, { status: 400 });
  }

  const accepted = resolveApproval(id, body.allow);
  if (!accepted) {
    /**
     * ⚠️ 找不到 = 已经答复过 / 已超时 / 流已结束。
     *    返回 409 而不是 200：让调用方知道"这一答复没有生效"，
     *    否则界面会以为成功，而工具那边其实已经按"拒绝"走了。
     */
    return NextResponse.json(
      { error: '该确认请求已失效（可能已答复、已超时或本轮已结束）', pending: pendingApprovalCount() },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, allow: body.allow, pending: pendingApprovalCount() });
}

/** 诊断：当前挂着几个确认（界面可用来判断"有没有待处理请求"） */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ pending: pendingApprovalCount() });
}
