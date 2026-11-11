/**
 * 删除记忆 —— 第一步：移入存档区（可恢复）
 *
 * `POST /api/memory/forget  { id, reason? }`
 *
 * ★ 删除现在是两步（用户确认的产品规则）：
 *   ① 这里：记忆移出记忆库与召回，**原文移进存档区**，随时可恢复；
 *   ② 存档区里再点「彻底删除」：抹除事件流原文，只留指纹。
 *
 * ⚠️ 三条纪律不变：
 *   · 硬约束（过敏/禁忌）不走存档：确认后直接销毁，避免来回操作搅浑安全边界；
 *   · 事件里不落原文，只留 contentHash；
 *   · 失败返回 409 并说明原因，不假装成功。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DEFAULT_USER_ID, getRuntime } from '@/app/runtime';
import { newArchiveId } from '@/core/memory/archive.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REASON_LABEL: Record<string, string> = {
  not_found: '找不到这条记忆',
  hard_constraint_cannot_be_forgotten: '全局硬约束需要显式确认后才能删除',
  hard_constraint_requires_confirmation: '全局硬约束需要显式确认后才能删除',
  user_confirmation_required: '硬约束只能由用户本人删除',
  confirmation_required: '删除硬约束需要显式确认',
  not_hard_constraint: '这条记忆不是硬约束',
  domain_not_owner: '没有权限删除这条记忆',
  butler_write_only: '这条记忆只能由管家写入',
  sensitive_no_grant: '敏感域尚未授权',
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { id?: unknown; hardConstraintConfirmation?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as {
      id?: unknown;
      hardConstraintConfirmation?: unknown;
      reason?: unknown;
    };
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id.length === 0) {
    return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  }
  const reason =
    typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim().slice(0, 200)
      : '用户删除';

  const rt = await getRuntime();
  const store = rt.bootstrapped.memory;
  const entry = store.get(id);

  // ── 硬约束：保持原语义（确认后直接销毁，不进存档区）──
  if (entry?.memClass === 'global_constraint') {
    const hardConfirmed = body.hardConstraintConfirmation === 'confirmed';
    const res = hardConfirmed
      ? store.forgetHardConstraint({ kind: 'user', userId: DEFAULT_USER_ID }, id, 'confirmed')
      : { ok: false, reason: 'hard_constraint_cannot_be_forgotten' as const };
    if (!res.ok) {
      const key = res.reason ?? 'unknown';
      return NextResponse.json(
        { error: REASON_LABEL[key] ?? '这条记忆当前不能删除', reason: key },
        { status: 409 },
      );
    }
    await rt.bootstrapped.log.flushPersistence().catch(() => undefined);
    return NextResponse.json({ ok: true, id, archived: false, hardConstraint: true });
  }

  // ── 普通/敏感记忆：移入存档区 ──
  const archiveId = newArchiveId(rt.clock.now(), rt.bootstrapped.log.length);
  const res = store.takeOutForArchive({
    actor: { kind: 'user', userId: DEFAULT_USER_ID },
    id,
    archiveId,
  });
  if (!res.ok || res.entry === undefined) {
    const key = res.reason ?? 'unknown';
    return NextResponse.json(
      { error: REASON_LABEL[key] ?? '这条记忆当前不能删除', reason: key },
      { status: 409 },
    );
  }

  /**
   * 顺序：先写存档、再刷事件。
   *
   * ⚠️ 反过来的话，进程在两步之间崩溃会出现"记忆没了、存档也没有"——
   *    而这一步的卖点恰恰是"删了还能找回"。
   */
  const sessionId = req.headers.get('x-butler-session');
  await rt.memoryArchive.append({
    archiveId,
    memory: res.entry,
    reason,
    archivedAt: rt.clock.now(),
    ...(sessionId !== null && sessionId.length > 0 ? { sessionId } : {}),
  });
  await rt.bootstrapped.log.flushPersistence().catch(() => undefined);

  return NextResponse.json({
    ok: true,
    id,
    archived: true,
    archiveId,
    note: '已移入存档区；在存档区再次删除才会彻底抹除',
  });
}
