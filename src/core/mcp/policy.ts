/**
 * MCP 服务器策略 —— 把界面提交的不可信 JSON 收敛成 `McpServerPolicy`。
 *
 * 设计依据：方案 § 10.3（权限分级）、`core/mcp/types.ts` 的策略矩阵。
 *
 * ★ 为什么单独一层：
 *   Route Handler 收到的 `body.policy` 是外部输入；如果直接 `as McpServerPolicy`，
 *   一个拼错的 level 或一个字符串型数组就能让策略静默变宽/变窄。
 *   这里做**运行时校验 + 安全默认值**，并且支持"只改部分字段"：
 *   - level 必须给；
 *   - disabledTools / allowMemoryWrite / allowDangerousTools 不给则沿用旧值
 *     （避免界面只提交 level 时把危险开关悄悄重置成 false 或 true）。
 */

import type { McpPolicyLevel, McpServerPolicy } from './types.js';

const LEVELS: readonly McpPolicyLevel[] = ['manual', 'readOnly', 'normal'];

export type McpPolicyParseResult =
  | { readonly ok: true; readonly policy: McpServerPolicy }
  | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLevel(value: unknown): value is McpPolicyLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

/**
 * 解析一份策略。
 *
 * @param raw     界面提交的策略片段
 * @param current 当前策略；用于"未提供的字段沿用旧值"
 */
export function parseMcpPolicy(
  raw: unknown,
  current?: McpServerPolicy,
): McpPolicyParseResult {
  if (!isRecord(raw)) {
    return { ok: false, error: 'policy 必须是对象' };
  }

  const level = raw['level'];
  if (!isLevel(level)) {
    return { ok: false, error: 'policy.level 只能是 manual / readOnly / normal' };
  }

  let disabledTools: readonly string[];
  const disabledRaw = raw['disabledTools'];
  if (disabledRaw === undefined) {
    disabledTools = current?.disabledTools ?? [];
  } else {
    if (!Array.isArray(disabledRaw) || !disabledRaw.every((v) => typeof v === 'string')) {
      return { ok: false, error: 'policy.disabledTools 必须是字符串数组' };
    }
    const cleaned = disabledRaw.map((v) => v.trim()).filter((v) => v.length > 0);
    if (cleaned.length > 200) {
      return { ok: false, error: 'policy.disabledTools 最多 200 项' };
    }
    disabledTools = [...new Set(cleaned)];
  }

  const memoryRaw = raw['allowMemoryWrite'];
  if (memoryRaw !== undefined && typeof memoryRaw !== 'boolean') {
    return { ok: false, error: 'policy.allowMemoryWrite 必须是布尔值' };
  }
  const allowMemoryWrite = memoryRaw ?? current?.allowMemoryWrite ?? false;

  const dangerousRaw = raw['allowDangerousTools'];
  if (dangerousRaw !== undefined && typeof dangerousRaw !== 'boolean') {
    return { ok: false, error: 'policy.allowDangerousTools 必须是布尔值' };
  }
  const allowDangerousTools = dangerousRaw ?? current?.allowDangerousTools ?? false;

  return {
    ok: true,
    policy: {
      level,
      disabledTools,
      allowMemoryWrite,
      allowDangerousTools,
    },
  };
}
