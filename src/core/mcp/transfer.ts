/**
 * MCP 配置导出/导入 —— 纯转换
 *
 * 设计依据：方案 §5.5（MCP 配置导出/导入）
 *
 * ★ 安全边界：
 *   · 导出**不包含 env 值**，只列出 envKeys；
 *     环境变量可能含凭证，不能因为“配置备份”把密钥带去网盘/聊天工具。
 *   · 导入仍接受 env（用户显式粘贴/编辑），但会走 `parseMcpConfig` 的
 *     既有 validateConfig，含凭证明文的条目会被拒绝。
 *   · 导出/导入只处理配置，不碰事件流、记忆或对话。
 */

import type { McpServerConfig, McpServerPolicy } from './types.js';
import { DEFAULT_POLICY } from './types.js';
import { parseMcpConfig } from './wiring.js';

export const MCP_CONFIG_SCHEMA = 'butler-mcp-config@1';

export interface ExportedMcpServer {
  readonly id: string;
  readonly name: string;
  readonly transport: McpServerConfig['transport'];
  readonly enabled: boolean;
  readonly policy: McpServerPolicy;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  /** 只导出键名；值不离开本机。 */
  readonly envKeys: readonly string[];
}

export interface McpConfigExport {
  readonly schema: typeof MCP_CONFIG_SCHEMA;
  readonly exportedAt: number;
  readonly envOmitted: true;
  readonly servers: readonly ExportedMcpServer[];
}

export function buildMcpConfigExport(
  configs: readonly McpServerConfig[],
  exportedAt: number,
): McpConfigExport {
  return {
    schema: MCP_CONFIG_SCHEMA,
    exportedAt,
    envOmitted: true,
    servers: configs.map((c) => ({
      id: c.id,
      name: c.name,
      transport: c.transport,
      enabled: c.enabled,
      policy: c.policy ?? DEFAULT_POLICY,
      ...(c.command !== undefined ? { command: c.command } : {}),
      ...(c.args !== undefined ? { args: [...c.args] } : {}),
      ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
      ...(c.url !== undefined ? { url: c.url } : {}),
      envKeys: Object.keys(c.env ?? {}).sort(),
    })),
  };
}

export interface ParsedMcpConfigExport {
  readonly configs: readonly McpServerConfig[];
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
}

/**
 * 接受导出文档或直接 `{ servers: [...] }`。
 *
 * 导出文档里的 `envKeys` 不会被当成 env 值；用户如果要恢复 env，
 * 需在导入 JSON 的 server 条目里显式提供 `env` 对象。
 */
export function parseMcpConfigExport(raw: unknown): ParsedMcpConfigExport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec['schema'] !== undefined && rec['schema'] !== MCP_CONFIG_SCHEMA) return null;
  const servers = rec['servers'];
  if (!Array.isArray(servers)) return null;

  const parsed = parseMcpConfig({ servers });
  return { configs: parsed.configs, rejected: parsed.rejected };
}
