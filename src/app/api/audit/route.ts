/**
 * 审计端点 —— 让用户看到"它凭什么这么说"
 *
 * 设计依据：方案 § 4.1（`constraint.injected` 支撑可审计性）、自查清单
 *   「`constraint.injected` 事件可查——用户能看到某任务注入了哪些约束」
 *   「`grant.*` 事件可查——敏感域授权与使用全程留痕」
 *
 * ★ 两种用法：
 *   GET /api/audit                  → 会话级总览
 *   GET /api/audit?from=1&to=40     → 某一轮的依据（seq 区间）
 *
 * ⚠️ 只读端点：不产生任何事件，可被任意次调用。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { readSessionAudit, readTurnAudit, hasAuditContent } from '@/core/audit/readAudit.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const log = rt.bootstrapped.log;

  const fromRaw = req.nextUrl.searchParams.get('from');
  const toRaw = req.nextUrl.searchParams.get('to');

  // 没给区间 → 会话级总览
  if (fromRaw === null || toRaw === null) {
    const audit = readSessionAudit(log);
    return NextResponse.json({ ok: true, scope: 'session', audit, hasContent: hasAuditContent(audit) });
  }

  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    return NextResponse.json(
      { error: 'from / to 必须是递增的正整数 seq' },
      { status: 400 },
    );
  }

  /**
   * ⚠️ 不存在的 seq 区间返回空结果而不是报错。
   *
   *   理由：界面在流式过程中会不断请求"到目前为止的依据"，
   *   而事件数在增长。为了一个"还没产生"的区间报错，
   *   会让界面在正常路径上处理异常 —— 那是把正常情况当错误处理。
   */
  const audit = readTurnAudit(log, { fromSeq: from, toSeq: to });

  return NextResponse.json({
    ok: true,
    scope: 'turn',
    audit,
    hasContent: hasAuditContent(audit),
  });
}
