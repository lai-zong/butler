/**
 * MCP 接线：把"写好但从未被调用"的客户端真正装起来（B10）
 *
 * ★★ 这个文件补的是**审计发现的最大空转**：
 *
 *   核查证据（全量引用扫描）：
 *   | 方法 | 生产调用 |
 *   |---|---|
 *   | `registerTransport` | **0** |
 *   | `addServer` | **0** |
 *   | `connect` | **0** |
 *   | `toToolSpecs` | **0** |
 *   | `callTool` | **0** |
 *
 *   `McpClient` 在 `bootstrap.ts` 里被构造出来后，**只被界面读取空列表**。
 *   `adapters/mcp/stdio.ts`（唯一传输实现）只被 `validate:5` 使用。
 *   于是方案 B10「外部 MCP server 的工具可用」在运行时**根本达不到**。
 *
 * ⚠️ 三条纪律：
 *
 *   ① **单个 server 失败不影响启动、也不影响别的 server**
 *      MCP server 是外部进程，挂掉是常态。启动流程不能因为它崩。
 *
 *   ② **只连接 `enabled` 的 server**
 *      禁用的服务器不该被启动 —— 否则"禁用"只是界面上的字。
 *
 *   ③ **配置必须过 `validateConfig`**
 *      它是既有的校验入口（含"不许出现凭证明文"）。绕过它就等于没有校验。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { McpClient, McpTransportFactory } from './client.js';
import type { McpServerConfig } from './types.js';
import { DEFAULT_POLICY, type McpServerPolicy } from './types.js';
import { validateConfig } from './types.js';
import type { ToolSpec } from '../tools/types.js';

/** 注册工具的最小接口（避免把 ToolFramework 整个类型拖进来）*/
export interface ToolRegistrar {
  registerAll(specs: readonly ToolSpec[]): void;
}

export interface LoadMcpConfigResult {
  readonly configs: readonly McpServerConfig[];
  /** 被丢弃的条目及原因 —— **如实报告，不静默忽略** */
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
}

/**
 * 解析 MCP 配置文件（JSON）。
 *
 * 期望形状：`{ "servers": [ { id, name, transport, command, args, env, enabled, policy } ] }`
 *
 * ⚠️ 不用 zod：这里的输入来自用户手写配置，**报错信息要指向具体条目**，
 *    而不是"schema 校验失败"。
 */
export function parseMcpConfig(raw: unknown): LoadMcpConfigResult {
  const rejected: { index: number; reason: string }[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    /**
     * ⚠️ 数组也是 `typeof 'object'` —— 只靠 typeof 会让 `[]` 落进后面分支，
     *    报"缺少 servers"，用户看不出真正错在哪。手写配置的报错必须准。
     */
    return {
      configs: [],
      rejected: [
        {
          index: -1,
          reason: Array.isArray(raw) ? '根节点应为对象，不能是数组' : '配置文件不是对象',
        },
      ],
    };
  }
  const servers = (raw as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) {
    return { configs: [], rejected: [{ index: -1, reason: '缺少 servers 数组' }] };
  }

  const configs: McpServerConfig[] = [];
  for (const [i, item] of servers.entries()) {
    if (typeof item !== 'object' || item === null) {
      rejected.push({ index: i, reason: '条目不是对象' });
      continue;
    }
    const o = item as Record<string, unknown>;

    const id = typeof o['id'] === 'string' ? o['id'].trim() : '';
    const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
    const transport = o['transport'];
    if (id === '') {
      rejected.push({ index: i, reason: '缺少 id' });
      continue;
    }
    if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
      rejected.push({ index: i, reason: `transport 非法：${String(transport)}` });
      continue;
    }

    const cfg = {
      id,
      name: name === '' ? id : name,
      transport,
      ...(typeof o['command'] === 'string' ? { command: o['command'] } : {}),
      ...(Array.isArray(o['args']) ? { args: o['args'].map((a) => String(a)) } : {}),
      ...(typeof o['env'] === 'object' && o['env'] !== null
        ? { env: o['env'] as Record<string, string> }
        : {}),
      ...(typeof o['envFromVault'] === 'object' && o['envFromVault'] !== null
        ? { envFromVault: o['envFromVault'] as Record<string, string> }
        : {}),
      ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'] } : {}),
      ...(typeof o['url'] === 'string' ? { url: o['url'] } : {}),
      enabled: o['enabled'] !== false,
    } as Omit<McpServerConfig, 'policy'>;

    // ★ 走既有校验入口（含凭证明文检查）
    const problems = validateConfig(cfg);
    if (problems.length > 0) {
      rejected.push({
        index: i,
        reason: problems.map((p) => `${p.field}: ${p.message}`).join('；'),
      });
      continue;
    }

    // ★ 策略也必须从配置恢复；否则写回的 manual/允许项重启后会被默认值覆盖。
    const rawPolicy = o['policy'];
    const rp =
      typeof rawPolicy === 'object' && rawPolicy !== null
        ? (rawPolicy as Record<string, unknown>)
        : null;
    const level =
      rp?.['level'] === 'manual' || rp?.['level'] === 'readOnly' || rp?.['level'] === 'normal'
        ? rp['level']
        : DEFAULT_POLICY.level;
    const policy: McpServerPolicy = {
      level,
      disabledTools: Array.isArray(rp?.['disabledTools'])
        ? rp['disabledTools'].filter((x): x is string => typeof x === 'string')
        : DEFAULT_POLICY.disabledTools,
      allowMemoryWrite: rp?.['allowMemoryWrite'] === true,
      allowDangerousTools: rp?.['allowDangerousTools'] === true,
    };

    configs.push({
      ...cfg,
      policy,
    } as McpServerConfig);
  }

  return { configs, rejected };
}

/** 从文件读配置；文件不存在时返回 null（**不是错误**，没配就是没配）*/
export function loadMcpConfigFile(path: string): LoadMcpConfigResult | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return parseMcpConfig(JSON.parse(text));
  } catch (err) {
    return {
      configs: [],
      rejected: [{ index: -1, reason: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}

/**
 * 原子写回配置。
 *
 * ⚠️ 只写 `{ servers: [...] }`，不碰别的字段；写临时文件再 rename，
 *    避免进程在写到一半时留下半截 JSON。
 */
export function saveMcpConfigFile(
  path: string,
  configs: readonly McpServerConfig[],
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ servers: configs }, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export interface WireMcpArgs {
  readonly mcp: McpClient;
  readonly tools: ToolRegistrar;
  readonly configs: readonly McpServerConfig[];
  /**
   * 要登记的传输工厂。
   *
   * ★ 不登记传输，`connect` 必然失败（"没有可用传输"）——
   *   这也是原来空转的一半原因：`stdioTransportFactory` 从未被调用过。
   */
  readonly transports?: readonly McpTransportFactory[];
  readonly onError?: (serverId: string, err: unknown) => void;
}

export interface WireMcpResult {
  /** 连接成功并注册了工具的 server */
  readonly connected: readonly string[];
  /** 失败的 server 及原因（**如实返回，供界面显示**）*/
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
  /** 禁用的 server（未尝试连接）*/
  readonly skipped: readonly string[];
  /** 一共注册了多少个 MCP 工具 */
  readonly toolsRegistered: number;
}

/**
 * 连接配置里的 server 并把它们的工具注册进工具框架。
 *
 * ⚠️ 返回结果而不是抛异常：调用方要把"哪个 server 没连上、为什么"显示出来。
 */
export async function wireMcpServers(args: WireMcpArgs): Promise<WireMcpResult> {
  const connected: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  const skipped: string[] = [];
  let toolsRegistered = 0;

  // ── ⓪ 先登记传输（缺这一步，后面全部 connect 失败）──
  for (const t of args.transports ?? []) {
    args.mcp.registerTransport(t);
  }

  for (const cfg of args.configs) {
    if (!cfg.enabled) {
      skipped.push(cfg.id);
      continue;
    }

    // ① 登记
    /**
     * ★★ 必须在这里补默认策略，**不能假设调用方已经规范化**。
     *
     * ⚠️ 端到端实测抓到的崩溃：`McpClient.addServer` 直接读
     *    `config.policy.level`，而调用方（含界面、含配置解析前的路径）
     *    很可能只给了 `{id,name,transport,command}`。
     *    单测没抓到（假客户端不会崩），真进程一跑就 TypeError。
     *
     * 用既有 `DEFAULT_POLICY`（manual / 不许写记忆 / 不许危险操作），
     * 不另造默认值 —— 两份默认值迟早漂移。
     */
    const normalized = {
      ...cfg,
      policy: (cfg as { policy?: McpServerPolicy }).policy ?? DEFAULT_POLICY,
    } as McpServerConfig;

    const added = args.mcp.addServer(normalized);
    if (!added.ok) {
      failed.push({ id: cfg.id, reason: added.problems.join('；') });
      continue;
    }

    // ② 连接
    try {
      const r = await args.mcp.connect(cfg.id);
      if (!r.ok) {
        failed.push({ id: cfg.id, reason: r.reason ?? '连接失败（未给出原因）' });
        continue;
      }
    } catch (err) {
      args.onError?.(cfg.id, err);
      failed.push({
        id: cfg.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // ③ 取工具并注册（**这一步以前从未发生**）
    try {
      const specs = args.mcp.toToolSpecs();
      if (specs.length > 0) {
        args.tools.registerAll(specs);
        toolsRegistered += specs.length;
      }
    } catch (err) {
      args.onError?.(cfg.id, err);
      failed.push({ id: cfg.id, reason: `取工具失败：${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    connected.push(cfg.id);
  }

  /**
   * ⚠️ **这里刻意不再落 `mcp.toolsDiscovered`**。
   *
   * 实测发现（端到端验证 18 抓到）：`McpClient.connect()` 内部**已经**落过
   * 这个事件（`tools/list` 之后），我原来在接线层又落了一条，
   * 于是同一个 server 会留下**两条同类型事件** —— 审计流被污染，
   * 读事件的人会以为发现了两轮工具。
   *
   * 事件是真相源，重复落等于数据失真。接线结果改由**返回值**交给调用方，
   * 运行时只打日志、不进事件流。
   */
  return { connected, failed, skipped, toolsRegistered };
}





