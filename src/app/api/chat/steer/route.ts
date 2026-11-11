/**
 * 当前轮中途消息（steering）。
 *
 * 三种用法：
 *   1. 普通运行中：{ sessionId, text } → 排队，下一次模型调用前注入；
 *   2. 审批中直接发消息：{ sessionId, text, cancelApprovals:true }
 *      → 取消本轮所有 pending，再排队；
 *   3. 审批按钮 + 可选文字：{ sessionId, approvalId, allow, text? }
 *      → 先答复审批，再排队（文字可空）。
 *
 * 没有活跃轮次时返回 409，前端应退回普通 /api/chat。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { resolveApproval } from '@/core/tools/approval.js';
import {
  cancelTurnApprovals,
  hasActiveTurn,
  steerTurn,
} from '@/core/tools/steering.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_TEXT = 20_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const record =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'].trim() : '';
  const text = typeof record['text'] === 'string' ? record['text'].trim() : '';
  const cancelApprovals = record['cancelApprovals'] === true;
  const approvalId = typeof record['approvalId'] === 'string' ? record['approvalId'] : '';
  const allowRaw = record['allow'];

  if (sessionId.length === 0) {
    return NextResponse.json({ error: '缺少 sessionId' }, { status: 400 });
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ error: '消息过长' }, { status: 400 });
  }
  if (approvalId.length > 0 && typeof allowRaw !== 'boolean') {
    return NextResponse.json({ error: 'allow 必须是布尔值' }, { status: 400 });
  }
  if (text.length === 0 && approvalId.length === 0 && !cancelApprovals) {
    return NextResponse.json({ error: '没有可处理的内容' }, { status: 400 });
  }
  if (!hasActiveTurn(sessionId)) {
    return NextResponse.json(
      { error: '当前没有正在执行的轮次', code: 'no_active_turn' },
      { status: 409 },
    );
  }

  /**
   * 审批按钮可能带文字：先答复审批，再入队。
   * 入队发生在同步代码里，工具恢复后的下一轮一定能看到它。
   */
  if (approvalId.length > 0) {
    if (!resolveApproval(approvalId, allowRaw === true)) {
      return NextResponse.json(
        { error: '该确认请求已失效（可能已答复或本轮已结束）' },
        { status: 409 },
      );
    }
  }

  let queued = false;
  let cancelled = 0;

  if (text.length > 0) {
    const steered = steerTurn(sessionId, text, { cancelApprovals });
    if (!steered.ok) {
      return NextResponse.json(
        { error: '当前没有正在执行的轮次', code: 'no_active_turn' },
        { status: 409 },
      );
    }
    queued = steered.queued;
    cancelled = steered.cancelled;
  } else if (cancelApprovals) {
    cancelled = cancelTurnApprovals(sessionId);
  }

  return NextResponse.json({ ok: true, queued, cancelled });
}
