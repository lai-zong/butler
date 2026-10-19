/**
 * 数据导出端点（v8 · 方案 §5.5；v9 自动脱敏）
 *
 * `GET /api/transfer/export` → 下载单个 JSON 文件
 *
 * ★ 三条要点：
 *   ① **只读**：不产生任何事件、不改任何状态
 *   ② **单文件**：方案要求单 JSON（多文件包漏一个就是静默的数据缺失）
 *   ③ **自动脱敏**：凭证替换为占位符并写清单；个人信息保留但标记；
 *      练习答案不导出。**不再因为数据内容而 400** ——
 *      事件流是 append-only，拒绝导出等于让用户永久失去备份能力。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { DEFAULT_USER_ID, getRuntime } from '@/app/runtime';
import { buildExport } from '@/core/transfer/export.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 应用版本：用事件格式版本表示，避免依赖 package.json 的读取 */
const APP_VERSION = 'v8';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  const log = rt.bootstrapped.log;

  const doc = buildExport({
    events: log.all(),
    // ⚠️ `ButlerRuntime` 不暴露 userId —— 它只作为 `BootstrapArgs` 传给 bootstrap。
    //    这里用同一个来源（`DEFAULT_USER_ID`），保证与重建时用的是同一个值。
    userId: DEFAULT_USER_ID,
    appVersion: APP_VERSION,
    now: rt.clock.now(),
  });

  const body = JSON.stringify(doc, null, 2);
  const stamp = new Date(rt.clock.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 单文件下载；文件名带时间戳，便于用户区分多次导出
      'Content-Disposition': `attachment; filename="butler-export-${stamp}.json"`,
      // 导出内容可能含个人数据，禁止中间层缓存
      'Cache-Control': 'no-store',
    },
  });
}
