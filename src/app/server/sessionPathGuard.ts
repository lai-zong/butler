/**
 * 会话工具作用域的路径守卫
 *
 * ★ 它挡在两个地方：
 *   ① 文件工具的 path/from/to/source/target 参数；
 *   ② 任何试图出现的 `run_command`（当前 Web 会话根本不提供该工具，
 *      这里再兜一层，避免有人从全局工具列表复制进来）。
 *
 * ★ 语义（修订后）：
 *   · `read-only`：只读；写/移动/删除/执行一律拒绝。
 *   · `workspace`：读/写/建目录限制在本对话工作区内；工作区外直接失败。
 *     highRisk（move_path）由 tier 策略拒绝，不在工作区档开放。
 *   · `full`：允许工作区外文件读写；受保护路径始终拒绝；
 *     dangerous（remove_path 等）仍由 tier 策略拒绝。
 *
 * ★★ 真实路径检查：
 *   所有路径参数都同时检查**字面 resolve** 与**realpath（含父目录 realpath）**。
 *   Windows junction / 符号链接可以让 `workspace\link\secret` 字面上在工作区内，
 *   真实路径却在工作区外；只查字面值会被绕过。
 *
 * ⚠️ 这不是 OS 沙箱：
 *   · 检查与执行之间存在 TOCTOU 窗口；
 *   · 命令执行工具已被移除，因此不做“命令内部路径”承诺。
 */

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { SessionPermission } from '@/core/chat/settings.js';
import {
  isPathInside,
  resolveRealPathForGuard,
} from './sessionWorkspace.js';

const READ_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read_file: ['path'],
  list_dir: ['path'],
  stat_path: ['path'],
  grep: ['path'],
  glob: ['path'],
};

const WRITE_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  write_file: ['path'],
  file_op: ['path', 'from', 'to'],
  apply_patch: ['path'],
  desktop_office_convert: ['source', 'target'],
  desktop_act: ['source', 'target'],
};

const WRITE_TOOLS = new Set(Object.keys(WRITE_PATH_FIELDS));

export interface SessionPathGuardOptions {
  readonly workspace: string;
  readonly permission: SessionPermission;
  readonly protectedPaths: readonly string[];
  /**
   * 允许执行命令的沙箱根（可选）。
   *
   * ★ 存在的理由：审查 Agent 需要在**临时副本**里跑测试/构建。
   *   没有这个字段时 `run_command` 一律被拒 —— 而审查提示词又明确教模型
   *   用它跑测试，等于每次审查都先撞一次墙，白烧一轮 token，
   *   "在临时副本里跑测试"这个承诺实际不成立。
   *
   * ⚠️ 给了它也不等于放开命令执行：
   *   · cwd 必须落在该根之下（字面与真实路径都比）；
   *   · 可执行文件名必须在白名单里；
   *   · 主对话的工具作用域**不会**传这个字段。
   */
  readonly commandRoot?: string;
}

/** 审查沙箱里允许的可执行文件（只覆盖"跑测试 / 构建 / 看状态"）。 */
const SANDBOX_COMMANDS: ReadonlySet<string> = new Set([
  'node',
  'npm',
  'npm.cmd',
  'npx',
  'npx.cmd',
  'pnpm',
  'pnpm.cmd',
  'yarn',
  'yarn.cmd',
  'tsc',
  'vitest',
  'git',
  'git.exe',
  'python',
  'python.exe',
]);

export type SessionPathGuard = (
  toolName: string,
  args: unknown,
) => Promise<string | null>;

interface ProtectedEntry {
  readonly literal: string;
  readonly real: string | null;
}

function readonlyReason(toolName: string): string {
  if (toolName === 'remove_path') return '删除文件或目录';
  if (toolName === 'move_path') return '移动/重命名';
  if (toolName === 'make_dir') return '创建目录';
  return '修改文件';
}

function valueOf(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 构造路径守卫（异步：需要 realpath 解析 junction/symlink）。
 *
 * 返回 null 放行；返回字符串表示拒绝，字符串会作为工具错误原样给模型看。
 */
export async function sessionPathGuard(
  options: SessionPathGuardOptions,
): Promise<SessionPathGuard> {
  const workspace = resolve(options.workspace);
  const realWorkspace = await realpath(workspace).catch(() => workspace);

  const protectedEntries: ProtectedEntry[] = [];
  for (const raw of options.protectedPaths) {
    const literal = resolve(raw);
    const real = await realpath(literal).catch(() => null);
    protectedEntries.push({ literal, real });
  }

  const deniedByProtected = (
    literal: string,
    real: string,
    shown: string,
  ): string | null => {
    for (const entry of protectedEntries) {
      const hitLiteral =
        isPathInside(entry.literal, literal) || isPathInside(entry.literal, real);
      const hitReal =
        entry.real !== null &&
        (isPathInside(entry.real, literal) || isPathInside(entry.real, real));
      if (hitLiteral || hitReal) {
        return (
          `受保护路径拒绝访问：${shown}` +
          '（.butler-data / .env.local / config 属于系统内部数据、密钥或全局规则，任何权限档位都不开放）'
        );
      }
    }
    return null;
  };

  const deniedByWorkspace = (
    literal: string,
    real: string,
    shown: string,
  ): string | null => {
    if (options.permission === 'full') return null;
    if (!isPathInside(workspace, literal) || !isPathInside(realWorkspace, real)) {
      return (
        `工作区权限拒绝：${shown} 不在本对话工作区 ${workspace} 内` +
        (real !== literal ? `（真实路径：${real}）` : '')
      );
    }
    return null;
  };

  return async (toolName, args) => {
    /**
     * 命令执行：**只有**在给了 `commandRoot`（审查沙箱）时才可能放行，
     * 而且必须同时满足"cwd 在沙箱内"与"可执行文件在白名单内"。
     *
     * ⚠️ 主对话永远走上面这条拒绝分支 —— Web 会话没有 OS 沙箱，
     *    与其假装"工作区内执行"，不如明确不提供。
     */
    if (toolName === 'run_command') {
      const sandboxRoot = options.commandRoot;
      if (sandboxRoot === undefined) {
        return '本对话不提供命令执行工具（Web 会话没有 OS 沙箱；workspace/full 都不开放 run_command）。';
      }
      const record: Record<string, unknown> =
        typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};

      const rawCommand = typeof record['command'] === 'string' ? record['command'].trim() : '';
      const executable = rawCommand.split(/[\\/]/).pop() ?? '';
      if (!SANDBOX_COMMANDS.has(executable.toLowerCase())) {
        return `审查沙箱不允许执行「${rawCommand || '（空命令）'}」；只允许跑测试/构建/查看状态类命令（node / npm / npx / pnpm / yarn / tsc / vitest / git / python）。`;
      }

      const rawCwd = typeof record['cwd'] === 'string' ? record['cwd'].trim() : '';
      const literalCwd = resolve(sandboxRoot, rawCwd.length > 0 ? rawCwd : '.');
      if (!isPathInside(sandboxRoot, literalCwd)) {
        return `审查沙箱只允许在临时副本 ${sandboxRoot} 内执行命令（收到 ${literalCwd}）。`;
      }
      // 真实路径再判一次：副本里的符号链接不能把人带出去
      const realRoot = await resolveRealPathForGuard(sandboxRoot);
      const realCwd = await resolveRealPathForGuard(literalCwd);
      if (!isPathInside(realRoot, realCwd)) {
        return `审查沙箱只允许在临时副本内执行命令（真实路径 ${realCwd} 越界）。`;
      }
      return null;
    }

    if (
      options.permission === 'read-only' &&
      (WRITE_TOOLS.has(toolName) || toolName === 'run_command')
    ) {
      return `只读权限拒绝：当前对话不允许${readonlyReason(toolName)}。`;
    }

    if (typeof args !== 'object' || args === null) return null;
    const record = args as Record<string, unknown>;

    const fields = WRITE_PATH_FIELDS[toolName] ?? READ_PATH_FIELDS[toolName];
    if (fields === undefined) return null;

    for (const field of fields) {
      const value = valueOf(record, field);
      if (value === null) continue;
      const literal = resolve(workspace, value);
      const real = await resolveRealPathForGuard(literal);
      const protectedDeny = deniedByProtected(literal, real, value);
      if (protectedDeny !== null) return protectedDeny;
      const workspaceDeny = deniedByWorkspace(literal, real, value);
      if (workspaceDeny !== null) return workspaceDeny;
    }
    return null;
  };
}
