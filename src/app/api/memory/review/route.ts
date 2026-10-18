/**
 * 记忆审核（界面入口）
 *
 * `POST /api/memory/review  { id, decision: 'approve' | 'reject', reason? }`
 *
 * ★★ 这个端点是**治理闭环缺的那一半**：
 *   在此之前 `store.review()` 的唯一生产调用来自 `admission.ts` 的**自主准入**（system），
 *   而判为"待审核"的候选**没有任何人类入口** —— 它们会永远停在 candidate。
 *
 * ⚠️ 三条纪律：
 *   ① 走 `store.review` 的正规路径（它负责状态机、事件、fitness 初始化）
 *   ② 元信息标 `decidedBy: 'user'` —— 审计时必须能区分"用户点的"与"系统自判的"
 *   ③ 找不到/状态不对时返回 409，而不是假装成功
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime, DEFAULT_USER_ID } from '@/app/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ReviewBody {
  readonly id?: unknown;
  readonly decision?: unknown;
  readonly reason?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: ReviewBody;
  try {
    body = (await req.json()) as ReviewBody;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id.length === 0) {
    return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  }

  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return NextResponse.json({ error: "decision 只能是 'approve' 或 'reject'" }, { status: 400 });
  }

  const reason = typeof body.reason === 'string' ? body.reason : '';

  const rt = await getRuntime();
  const store = rt.bootstrapped.memory;

  const res = store.review(
    { kind: 'user', userId: DEFAULT_USER_ID },
    id,
    decision,
    reason,
    { decidedBy: 'user' },
  );

  if (!res.ok) {
    /**
     * ⚠️ 409 而不是 200：让界面知道"这次没生效"。
     *    否则用户点了"批准"，界面显示成功，而记忆状态其实没变。
     */
    return NextResponse.json(
      { error: res.reason ?? '这条记忆当前不能这样处理', id },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    id,
    decision,
    lifecycle: res.entry.lifecycle,
  });
}
