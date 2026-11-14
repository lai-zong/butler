/**
 * 会话级工具作用域
 *
 * ★★ 这段代码解决的真实问题：
 *   `runtime.tools` 是**所有会话共享**的一个 `ToolFramework`：
 *   · `NodeFileSystem.root` 固定为 WORKSPACE_ROOT；
 *   · `WebPermissionPolicy.mode` 是可变的全局字段；
 *   · 并发两个会话一个设工作区、一个设完全，会互相覆盖。
 *
 *   所以聊天不能再直接用 `rt.tools`。每一轮根据 `TurnSettings` 快照
 *   构造一份**独立的** ToolFramework：
 *   · 独立的 NodeFileSystem（root = 本会话工作区）；
 *   · 独立的不可变 SessionPermissionPolicy；
 *   · 独立的异步 pathGuard（realpath/父目录 realpath + 工作区/受保护路径）；
 *   · 文件工具用本会话的 fs；
 *   · **不提供 run_command**：Web 会话没有 OS 沙箱，无法保证命令内部
 *     不读取工作区外/受保护路径，宁可不注册该工具；
 *   · 从全局 tools 复制 MCP/桌面等非文件工具（只复制 ToolSpec，不共享可变策略）。
 *
 * ★ 共享的可变状态一个都不带进来：
 *   - 不读 `rt.permissionPolicy`；
 *   - 不读 `rt.tools` 的 pathGuard / policy；
 *   - `baseTools` 只用来复制工具定义。
 */

import { join } from 'node:path';

import type { SessionPermission } from '@/core/chat/settings.js';
import { limitsConfig } from '@/core/config/env.js';
import type { EventLog } from '@/core/events/log.js';
import type { ClockPort } from '@/core/ports/clock.js';
import { ToolFramework } from '@/core/tools/framework.js';
import { documentSearchTool } from '@/core/tools/builtin/documents.js';
import { fileTools } from '@/core/tools/builtin/file.js';
import { browserTools } from './browserTools.js';
import { planTaskTool, type TaskPlanState } from '@/core/tools/builtin/plan.js';
import { NodeFileSystem } from '@/adapters/fs/node.js';
import { SessionPermissionPolicy } from './sessionPermission.js';
import { sessionPathGuard } from './sessionPathGuard.js';
import {
  assertSessionWorkspace,
  protectedSessionPaths,
} from './sessionWorkspace.js';

export type ChatDocumentSearch = Parameters<typeof documentSearchTool>[0];

export interface CreateChatToolScopeInput {
  readonly log: EventLog;
  readonly clock: ClockPort;
  /** 本会话的权限档位（已由 TurnSettings 快照解析成具体值）。 */
  readonly permission: SessionPermission;
  /** 本会话的工作区；会再次校验存在性/目录/受保护路径。 */
  readonly workspace: string;
  /** 系统数据目录（`.butler-data`）。 */
  readonly dataDir: string;
  /** 应用根目录（用于保护 `.env.local`、默认 `.butler-data` 与 `config/`）。 */
  readonly appRoot: string;
  /**
   * 全局工具框架：只复制其中的**非文件工具**（MCP / 桌面 / 知识库等）。
   * 不复制它的 policy、pathGuard 或 fs。
   */
  readonly baseTools?: ToolFramework | undefined;
  /** 知识库检索；没有接入时如实不注册 `document_search`。 */
  readonly documentSearch?: ChatDocumentSearch | undefined;
  /** 关闭时按档位直接执行 normal/highRisk；dangerous 仍禁用。默认 true。 */
  readonly confirmActions?: boolean | undefined;
  /**
   * 本轮的任务计划状态。
   *
   * 提供时注册 plan_task，并给有副作用的工具加“必须先有计划”的门禁。
   * 不提供时保持旧行为（定时任务 / 验证脚本）。
   */
  readonly taskPlan?: TaskPlanState | undefined;
  /**
   * 允许在哪个沙箱根里执行命令（可选）。
   *
   * ★ 只有审查作用域会传它：审查需要"在临时副本里跑测试"。
   *   主对话一律不传 —— Web 会话没有 OS 沙箱，宁可不提供该工具。
   *   权限、白名单与 cwd 校验都在 `sessionPathGuard` 里，这里只是透传。
   */
  readonly commandRoot?: string | undefined;
  /**
   * 本会话显式授权的工作区外文件路径（来自外部文件面板）。
   *
   * ★ 只传给 pathGuard，不改变 fs root：文件工具仍以工作区为基准，
   *   但绝对路径命中授权项时允许读写。受保护路径优先级更高。
   */
  readonly allowedPaths?: readonly string[] | undefined;
}

export interface ChatToolScope {
  readonly tools: ToolFramework;
  /** 校验后的真实工作区（realpath）。 */
  readonly workspace: string;
  readonly permission: SessionPermission;
  readonly policy: SessionPermissionPolicy;
  readonly protectedPaths: readonly string[];
}

/** 本作用域自带的文件/执行工具名；不从全局框架复制。 */
const OWNED_TOOL_NAMES: readonly string[] = [
  'read_file',
  'list_dir',
  'write_file',
  'make_dir',
  'move_path',
  'remove_path',
  'stat_path',
  'run_command',
  'browser_read',
  'browser_tabs',
  'browser_selection',
  'document_search',
  'plan_task',
];

/**
 * 构造一份只属于当前会话/当前轮的工具作用域。
 *
 * @throws SessionWorkspaceError 工作区在落库后被删除/改名时，调用方应转成 400。
 */
export async function createChatToolScope(
  input: CreateChatToolScopeInput,
): Promise<ChatToolScope> {
  const workspace = await assertSessionWorkspace(input.workspace, {
    dataDir: input.dataDir,
    appRoot: input.appRoot,
  });
  const protectedPaths = protectedSessionPaths(workspace, {
    dataDir: input.dataDir,
    appRoot: input.appRoot,
  });

  const policy = new SessionPermissionPolicy(input.permission, input.confirmActions ?? true);
  const fsPort = new NodeFileSystem({
    root: workspace,
    // 会话里删文件同样进回收站（数据目录由调用方传入）
    trashDir: join(input.dataDir, 'trash'),
    // ★ 受保护路径在任何权限档位下都生效，包括 full。
    protectedPaths,
  });
  const pathGuard = await sessionPathGuard({
    workspace,
    permission: input.permission,
    protectedPaths,
    ...(input.commandRoot !== undefined ? { commandRoot: input.commandRoot } : {}),
    ...(input.allowedPaths !== undefined && input.allowedPaths.length > 0
      ? { allowedPaths: input.allowedPaths }
      : {}),
  });
  const tools = new ToolFramework({
    log: input.log,
    clock: input.clock,
    policy,
    fuse: {
      windowMs: limitsConfig.toolFuseWindowMs,
      maxWrites: limitsConfig.toolFuseMaxWrites,
    },
    pathGuard,
    ...(input.taskPlan !== undefined
      ? {
          planGuard: (): string | null =>
            input.taskPlan?.contract === null
              ? '需要先调用 plan_task，说明交付物和约束，之后才能执行有副作用的操作。'
              : null,
        }
      : {}),
  });

  tools.registerAll(fileTools(fsPort));
  // 浏览器只读工具：读当前内嵌页面/标签/选区，不碰文件系统，不需要 pathGuard。
  tools.registerAll(browserTools());
  if (input.taskPlan !== undefined) {
    tools.register(planTaskTool(input.taskPlan));
  }
  /**
   * ★ 不注册 `run_command`。
   *
   * 没有 OS 沙箱时，路径守卫无法阻止 `node -e` / 脚本读取工作区外或
   * `.butler-data`；与其给出“工作区内执行”的虚假承诺，不如不提供该工具。
   * `OWNED_TOOL_NAMES` 仍包含 run_command，确保它不会被从全局工具列表复制进来。
   */
  if (input.documentSearch !== undefined) {
    tools.register(documentSearchTool(input.documentSearch));
  }

  /**
   * 复制非文件工具（MCP、桌面、知识库等）。
   *
   * ⚠️ 不能复制共享的 ToolFramework 本身 —— 那会把它的 policy/pathGuard 一起带进来。
   *    这里只拿 ToolSpec；执行仍然走本作用域的 execute()。
   */
  if (input.baseTools !== undefined) {
    const owned = new Set(OWNED_TOOL_NAMES);
    for (const spec of input.baseTools.list()) {
      if (owned.has(spec.name)) continue;
      if (tools.get(spec.name) !== undefined) continue;
      tools.register(spec);
    }
  }

  return { tools, workspace, permission: input.permission, policy, protectedPaths };
}
