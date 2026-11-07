/**
 * 会话工具作用域的“应用默认值”解析
 *
 * ★ 为什么单独一个模块：
 *   会话的 `workspace` / `permission` 允许为 `null`，意思是“跟随应用”。
 *   但工具作用域必须是**具体值** —— 否则没法建 `NodeFileSystem` 的 root，
 *   也没法构造不可变的权限策略。
 *
 *   这里只做一件事：把“应用当前默认”翻译成具体的工作区与权限档位。
 *   它**不修改**全局设置：全局 mode 仍然由 permissionStore / 设置页管理。
 *
 * ⚠️ `permissionPolicy.mode === undefined` 的兼容口径：
 *   这是旧版本“未配置模式”的状态。**未配置默认权限时按只读处理**：
 *   不允许“跟随应用”在没有明确授权的情况下自动获得写/执行能力。
 *   界面会显示「跟随应用（当前：只读）」；用户要放开时在会话设置或
 *   全局设置里显式选择工作区/完全。
 *
 * ⚠️ 这是安全默认，不是旧 WebPermissionPolicy 的完整复刻：
 *   旧策略在 mode 未配置时 normal/highRisk 会走 ask；但会话工具作用域
 *   不再提供 `run_command`（Web 会话没有 OS 沙箱），且桌宠等客户端没有
 *   确认通道，因此把“未配置”收敛为只读，避免默认拿到写权限。
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { SessionPermission } from '@/core/chat/settings.js';
import type { PermissionMode } from '@/core/tools/types.js';

/** 一次会话工具作用域需要应用给出的两个默认值。 */
export interface ScopeDefaults {
  readonly workspace: string;
  readonly permission: SessionPermission;
}

/**
 * 运行时里与本模块相关的最小形状。
 *
 * ⚠️ 用可选字段而不是直接依赖 `ButlerRuntime`：
 *   路由测试会 mock 一个只含 `bootstrapped` 的运行时；
 *   这里必须能在“拿不到默认值”时安全回退，而不是在测试里抛 TypeError。
 */
export interface RuntimeScopeSource {
  readonly workspaceRoot?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly permissionPolicy?: { readonly mode?: PermissionMode | undefined } | undefined;
}

/** 程序安装根目录（不是用户工作区）。 */
export function appInstallRoot(): string {
  return resolve(process.cwd());
}

/** 应用默认工作区（与 runtime.ts 的 WORKSPACE_ROOT 同源）。 */
export function appWorkspaceRoot(): string {
  const configured = process.env['BUTLER_WORKSPACE']?.trim();
  const root = resolve(
    configured !== undefined && configured.length > 0
      ? configured
      : join(appInstallRoot(), 'workplace'),
  );
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    // 让文件工具给出明确错误；不在纯投影函数里崩掉。
  }
  return root;
}

/** 应用数据目录（与 runtime.ts 的 DATA_DIR 同源；测试可指向临时目录）。 */
export function appDataDir(): string {
  const configured = process.env['BUTLER_DATA_DIR']?.trim();
  return resolve(
    configured !== undefined && configured.length > 0
      ? configured
      : join(appInstallRoot(), '.butler-data'),
  );
}

/** 全局 C5 模式 → 会话权限档位。未配置时按只读（安全默认）。 */
export function sessionPermissionFromMode(mode: PermissionMode | undefined): SessionPermission {
  if (mode === 'full') return 'full';
  if (mode === 'workspace') return 'workspace';
  // 'view' 与未配置（undefined）都按只读处理。
  return 'read-only';
}

/** 应用当前默认作用域。 */
export function scopeDefaultsOf(rt?: RuntimeScopeSource | null): ScopeDefaults {
  const workspace =
    typeof rt?.workspaceRoot === 'string' && rt.workspaceRoot.trim().length > 0
      ? resolve(rt.workspaceRoot)
      : appWorkspaceRoot();
  const mode = rt?.permissionPolicy?.mode;
  return { workspace, permission: sessionPermissionFromMode(mode) };
}

/** 应用数据目录：优先用运行时实际使用的值，测试/独立脚本回退到 env。 */
export function dataDirOf(rt?: RuntimeScopeSource | null): string {
  return typeof rt?.dataDir === 'string' && rt.dataDir.trim().length > 0
    ? resolve(rt.dataDir)
    : appDataDir();
}

/** 没有运行时上下文时的默认作用域（纯投影函数用）。 */
export function defaultScopeDefaults(): ScopeDefaults {
  return { workspace: appWorkspaceRoot(), permission: sessionPermissionFromMode(undefined) };
}
