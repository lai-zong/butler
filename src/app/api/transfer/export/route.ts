/**
 * 数据导出端点（v8 · 方案 §5.5）
 *
 * `GET /api/transfer/export` → 下载单个 JSON 文件
 *
 * ★ 三条要点：
 *   ① **只读**：不产生任何事件、不改任何状态
 *   ② **单文件**：方案要求单 JSON（多文件包漏一个就是静默的数据缺失）
 *   ③ **凭证失败即拒**：扫描到疑似凭证就 400 并说明位置，
 *      不悄悄写进文件、也不悄悄替换成 `***`（那会让导入后与原文不符）
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

  const result = buildExport({
    events: log.all(),
    // ⚠️ `ButlerRuntime` 不暴露 userId —— 它只作为 `BootstrapArgs` 传给 bootstrap。
    //    这里用同一个来源（`DEFAULT_USER_ID`），保证与重建时用的是同一个值。
    userId: DEFAULT_USER_ID,
    appVersion: APP_VERSION,
    now: rt.clock.now(),
  });

  if (result.doc === undefined) {
    /**
     * ⚠️ 扫描到疑似凭证时**拒绝导出**。
     *
     * 为什么不脱敏后照常导出：脱敏会让导出文件与原文不一致，
     * 导入回去之后行为可能变（比如某个工具的参数被替换成 `***`）。
     * 宁可让用户知道"这里有问题需要处理"，也不要制造一份"看着完整、其实被改过"的数据。
     */
    const where = result.rejection?.where ?? [];
    return NextResponse.json(
      {
        error: '导出被拒绝：事件数据里出现了像凭证的内容。请先清理它，或改用凭证存储。',
        where: where.slice(0, 20),
        suspiciousCount: where.length,
      },
      { status: 400 },
    );
  }

  const body = JSON.stringify(result.doc, null, 2);
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
