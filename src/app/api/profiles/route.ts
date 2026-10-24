/**
 * 画像快照 —— 「成长对比」的只读数据源（方案 § 3.3）
 *
 * GET /api/profiles
 *   → { ok, profiles: ProfileSummary[], skipped }
 *     列出所有**完整**快照；旧版本只有计数的事件计入 skipped，不伪造。
 *
 * GET /api/profiles?from=<id>&to=<id>
 *   → { ok, delta: ProfileDelta }
 *     delta 里带完整 from/to（perDomain、principleList、summary）与差值。
 *
 * ★ 为什么放在这里而不是 overview：
 *   overview 是首屏/侧栏的高频接口；快照列表只在打开「演化 → 成长对比」时
 *   需要。分开放，避免首屏为一个低频视图多扫一遍事件。
 *
 * ★ 为什么只读：
 *   快照是**只读派生**，不写记忆库、不参与演化。生成由周复盘任务负责
 *   （`captureProfile`），这里不做"立刻生成"——那会让"成长"变成手动摆拍。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { diffProfiles } from '@/core/activity/profile.js';
import {
  findProfile,
  readProfileHistory,
  summarizeProfile,
} from '@/core/activity/profileHistory.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const history = readProfileHistory(rt.bootstrapped.log.all());

  const fromId = (req.nextUrl.searchParams.get('from') ?? '').trim();
  const toId = (req.nextUrl.searchParams.get('to') ?? '').trim();

  // ── 列表 ──
  if (fromId.length === 0 && toId.length === 0) {
    return NextResponse.json({
      ok: true,
      profiles: history.profiles.map(summarizeProfile),
      skipped: history.skipped,
    });
  }

  // ── 对比 ──
  if (fromId.length === 0 || toId.length === 0) {
    return NextResponse.json(
      { error: 'from 与 to 必须同时给出' },
      { status: 400 },
    );
  }

  const from = findProfile(history, fromId);
  const to = findProfile(history, toId);
  if (from === undefined || to === undefined) {
    return NextResponse.json(
      {
        error: '找不到指定的快照（可能是旧版本只记了计数，无法重建）',
        available: history.profiles.map((p) => p.id),
      },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, delta: diffProfiles(from, to) });
}
