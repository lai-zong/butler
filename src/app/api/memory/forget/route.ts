/**
 * 遗忘（彻底删除）端点 —— 方案 D4 / “遗忘权”
 *
 * `POST /api/memory/forget  { id }`
 *
 * ⚠️ 三条纪律（与 store.forget 的语义一致）：
 *   ① 硬约束**不可遗忘** —— 否则可能把过敏史删掉
 *   ② 删除事件里只留“已删除”这一事实，不落内容
 *   ③ 失败返回 409 并说明原因，不假装成功
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DEFAULT_USER_ID, getRuntime } from '@/app/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REASON_LABEL: Record<string, string> = {
  not_found: '找不到这条记忆',
  hard_constraint_cannot_be_forgotten: '全局硬约束需要显式确认后才能删除',
  user_confirmation_required: '硬约束只能由用户本人删除',
  confirmation_required: '删除硬约束需要显式确认',
  not_hard_constraint: '这条记忆不是硬约束',
  domain_not_owner: '没有权限删除这条记忆',
  butler_write_only: '这条记忆只能由管家写入',
  sensitive_no_grant: '敏感域尚未授权',
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { id?: unknown; hardConstraintConfirmation?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; hardConstraintConfirmation?: unknown };
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id.length === 0) {
    return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  }

  const rt = await getRuntime();
  const store = rt.bootstrapped.memory;
  const entry = store.get(id);
  const hardConfirmed = body.hardConstraintConfirmation === 'confirmed';
  const res =
    entry?.memClass === 'global_constraint'
      ? hardConfirmed
        ? store.forgetHardConstraint({ kind: 'user', userId: DEFAULT_USER_ID }, id, 'confirmed')
        : { ok: false, reason: 'hard_constraint_cannot_be_forgotten' }
      : store.forget({ kind: 'user', userId: DEFAULT_USER_ID }, id);

  if (!res.ok) {
    const reason = res.reason ?? 'unknown';
    return NextResponse.json(
      { error: REASON_LABEL[reason] ?? '这条记忆当前不能删除', reason },
      { status: 409 },
    );
  }

  // 删除是状态变更，必须尽快落盘（与 /api/chat 同一口径）
  await rt.bootstrapped.log.flushPersistence().catch(() => undefined);

  return NextResponse.json({ ok: true, id });
}
