/**
 * MCP 服务器管理。
 *
 * GET  : 列表 / 状态 / 工具 / 配置路径 / 被丢弃条目
 * POST : { action: 'add' | 'connect' | 'disconnect' | 'enable' | 'disable' | 'remove', ... }
 *
 * ★ 配置写回 `mcp.json`；运行中的 McpClient 与文件保持一致。
 * ★ 只返回 env 的键名，不返回值 —— 配置界面不能把密钥打印到浏览器。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { parseMcpPolicy } from '@/core/mcp/policy.js';
import { loadMcpConfigFile, saveMcpConfigFile } from '@/core/mcp/wiring.js';
import {
  DEFAULT_POLICY,
  MCP_TOOL_PREFIX,
  type McpServerConfig,
  type McpTransport,
} from '@/core/mcp/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  readonly action?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly transport?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly url?: unknown;
  readonly enabled?: unknown;
  readonly policy?: unknown;
  readonly envFromVault?: unknown;
}

function syncTools(rt: Awaited<ReturnType<typeof getRuntime>>): void {
  for (const t of rt.tools.list()) {
    if (t.name.startsWith(MCP_TOOL_PREFIX)) rt.tools.unregister(t.name);
  }
  rt.tools.registerAll(rt.bootstrapped.mcp.toToolSpecs());
}

function persist(rt: Awaited<ReturnType<typeof getRuntime>>): void {
  saveMcpConfigFile(
    rt.mcpConfigPath,
    rt.bootstrapped.mcp.listServers().map((s) => s.config),
  );
}

function view(
  rt: Awaited<ReturnType<typeof getRuntime>>,
): Record<string, unknown> {
  const file = loadMcpConfigFile(rt.mcpConfigPath);
  return {
    ok: true,
    configPath: rt.mcpConfigPath,
    rejected: file?.rejected ?? [],
    availableTransports: (['stdio', 'sse', 'http'] as const).filter((t) => rt.bootstrapped.mcp.hasTransport(t)),
    servers: rt.bootstrapped.mcp.listServers().map((s) => ({
      id: s.config.id,
      name: s.config.name,
      transport: s.config.transport,
      enabled: s.config.enabled,
      state: s.state,
      lastError: s.lastError ?? null,
      command: s.config.command ?? null,
      url: s.config.url ?? null,
      envKeys: Object.keys(s.config.env ?? {}),
    vaultEnvKeys: Object.keys(s.config.envFromVault ?? {}),
      policy: s.config.policy,
      notices: s.notices.length,
      tools: s.tools.map((t) => ({
        name: t.name,
        qualifiedName: t.qualifiedName,
        description: t.description,
        tier: t.tier,
        disabled: s.config.policy.disabledTools.includes(t.name),
      })),
    })),
    registeredTools: rt.tools.list().filter((t) => t.name.startsWith(MCP_TOOL_PREFIX)).length,
  };
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(view(await getRuntime()));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const rt = await getRuntime();
  const mcp = rt.bootstrapped.mcp;
  const action = typeof body.action === 'string' ? body.action : '';
  const id = typeof body.id === 'string' ? body.id.trim() : '';

  try {
    if (action === 'add') {
      const transport = body.transport;
      if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
        return NextResponse.json({ error: 'transport 只能是 stdio / sse / http' }, { status: 400 });
      }
      if (!mcp.hasTransport(transport)) {
        return NextResponse.json(
          { error: `${transport} 传输尚未实现；当前仅支持 stdio` },
          { status: 400 },
        );
      }
      if (id.length === 0) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
      if (mcp.getServer(id) !== undefined) {
        return NextResponse.json({ error: `服务器 id 已存在：${id}` }, { status: 409 });
      }
      const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : id;
      const args = Array.isArray(body.args)
        ? body.args.map((a) => String(a)).filter((a) => a.length > 0)
        : undefined;
      const envFromVault =
        typeof body.envFromVault === 'object' && body.envFromVault !== null
          ? Object.fromEntries(
              Object.entries(body.envFromVault as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
                .map(([k, v]) => [k.trim(), String(v).trim()]),
            )
          : undefined;
      const config: McpServerConfig = {
        id,
        name,
        transport: transport as McpTransport,
        enabled: body.enabled !== false,
        policy: DEFAULT_POLICY,
        ...(typeof body.command === 'string' && body.command.trim().length > 0
          ? { command: body.command.trim() }
          : {}),
        ...(args !== undefined && args.length > 0 ? { args } : {}),
        ...(envFromVault !== undefined && Object.keys(envFromVault).length > 0
          ? { envFromVault }
          : {}),
        ...(typeof body.url === 'string' && body.url.trim().length > 0
          ? { url: body.url.trim() }
          : {}),
      };
      const added = mcp.addServer(config);
      if (!added.ok) {
        return NextResponse.json({ error: added.problems.join('；') }, { status: 400 });
      }
      persist(rt);
      syncTools(rt);
      return NextResponse.json({ ok: true, ...view(rt) });
    }

    if (action === 'remove') {
      if (!mcp.removeServer(id)) {
        return NextResponse.json({ error: '找不到这个服务器' }, { status: 404 });
      }
      persist(rt);
      syncTools(rt);
      return NextResponse.json({ ok: true, ...view(rt) });
    }

    if (id.length === 0) {
      return NextResponse.json({ error: '缺少 id' }, { status: 400 });
    }

    if (action === 'connect') {
      const r = await mcp.connect(id);
      syncTools(rt);
      return NextResponse.json({ ok: r.ok, reason: r.reason ?? null, ...view(rt) });
    }

    if (action === 'disconnect') {
      const ok = await mcp.disconnect(id, '用户从设置页断开');
      syncTools(rt);
      return NextResponse.json({ ok, ...view(rt) });
    }

    if (action === 'enable' || action === 'disable') {
      const enabled = action === 'enable';
      const ok = await mcp.setEnabled(id, enabled);
      if (ok) persist(rt);
      syncTools(rt);
      return NextResponse.json({ ok, ...view(rt) });
    }

    if (action === 'updatePolicy') {
      const server = mcp.getServer(id);
      if (server === undefined) {
        return NextResponse.json({ error: '找不到这个服务器' }, { status: 404 });
      }
      const parsed = parseMcpPolicy(body.policy, server.config.policy);
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      if (!mcp.setPolicy(id, parsed.policy)) {
        return NextResponse.json({ error: '找不到这个服务器' }, { status: 404 });
      }
      // setPolicy 只改运行中的 config；落盘与工具表同步由这里负责。
      persist(rt);
      syncTools(rt);
      return NextResponse.json({ ok: true, ...view(rt) });
    }

    return NextResponse.json({ error: `未知 action：${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
