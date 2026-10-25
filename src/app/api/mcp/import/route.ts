/**
 * MCP 配置导入（替换 mcp.json 并重建运行时）
 *
 * POST /api/mcp/import
 *   { confirm: true, document: <导出的 MCP 配置 JSON> }
 *
 * ★ 必须先 confirm；导入会替换服务器配置并重建运行时。
 * ★ env 值不会从导出文件恢复；导入 JSON 里可显式提供 env。
 */

import { copyFile } from 'node:fs/promises';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime, resetRuntime } from '@/app/runtime';
import { parseMcpConfigExport } from '@/core/mcp/transfer.js';
import { saveMcpConfigFile } from '@/core/mcp/wiring.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  readonly confirm?: unknown;
  readonly document?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  if (body.confirm !== true) {
    return NextResponse.json({ error: '导入 MCP 配置需要 confirm: true' }, { status: 400 });
  }
  if (rt.activeTurns > 0) {
    return NextResponse.json({ error: '还有对话正在执行；等它结束后再导入' }, { status: 409 });
  }
  if (rt.activityRuntime.scheduler.isRunning()) {
    return NextResponse.json({ error: '定时任务正在运行；等它结束后再导入' }, { status: 409 });
  }

  const parsed = parseMcpConfigExport(body.document);
  if (parsed === null) {
    return NextResponse.json(
      { error: '不是合法的 MCP 配置导出文档（需要 schema + servers）' },
      { status: 400 },
    );
  }
  if (parsed.rejected.length > 0) {
    return NextResponse.json(
      { error: '配置中有条目未通过校验', rejected: parsed.rejected },
      { status: 400 },
    );
  }

  const backup = `${rt.mcpConfigPath}.before-import-${rt.clock.now()}`;
  let backedUp = false;
  try {
    await copyFile(rt.mcpConfigPath, backup);
    backedUp = true;
  } catch {
    // 首次导入没有 mcp.json，不是错误
  }

  saveMcpConfigFile(rt.mcpConfigPath, parsed.configs);
  await resetRuntime();

  return NextResponse.json({
    ok: true,
    imported: parsed.configs.length,
    rejected: [],
    backup: backedUp ? backup : null,
    envOmitted: true,
    note: '导出文件不含 env 值；需要环境变量的 server 请在导入 JSON 里显式添加 env。',
  });
}
