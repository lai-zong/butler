/**
 * MCP 配置导出（只导出配置，不含 env 值）
 *
 * GET /api/mcp/export
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { buildMcpConfigExport } from '@/core/mcp/transfer.js';
import { loadMcpConfigFile } from '@/core/mcp/wiring.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const rt = await getRuntime();
  /**
   * 不能只读 mcp.listServers()：运行时会跳过 disabled 的 server，
   * 但导出必须包含它们，否则备份会悄悄少配置。
   */
  const loaded = loadMcpConfigFile(rt.mcpConfigPath);
  const configs = loaded?.configs ?? rt.bootstrapped.mcp.listServers().map((s) => s.config);
  const doc = buildMcpConfigExport(configs, rt.clock.now());
  const body = JSON.stringify(doc, null, 2);
  const stamp = new Date(rt.clock.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="butler-mcp-config-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
