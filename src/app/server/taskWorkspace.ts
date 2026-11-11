/**
 * 用户任务的工作区与路径守卫。
 *
 * 工作区权限下：
 *   · 相对路径以任务工作区为根；
 *   · 读可以跨目录（用户可能要看外部资料）；
 *   · 写 / 移动 / 删除只允许在工作区内。
 *
 * 完全权限不挂路径守卫，由模型判断。
 */

import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';

function defaultWorkspaceRoot(): string {
  const root = resolve(process.env['BUTLER_WORKSPACE'] ?? join(process.cwd(), 'workplace'));
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    // 目录创建失败时交给 assertWorkspaceDirectory 报明确错误。
  }
  return root;
}

const WRITE_PATH_TOOLS: Readonly<Record<string, readonly string[]>> = {
  write_file: ['path'],
  make_dir: ['path'],
  move_path: ['from', 'to'],
  remove_path: ['path'],
  desktop_office_convert: ['source', 'target'],
  /**
   * ⚠️ 下面三条是补漏，每一条都能把文件写到工作区外：
   *   · `apply_patch`    — 按 path 直接改任意文本文件（`.ssh\authorized_keys` 就是一条）
   *   · `file_op`        — mkdir/move/remove 三种动作都带路径
   *   · `desktop_act`    — `action: 'convert_office'` 带 source / target 两个路径，
   *                        而且它是 `normal` 档，工作区权限下**允许执行**
   *
   * 旧表只列了五个工具，于是「工作区权限」在文档里写着"只能在工作区内写"，
   * 实际这三条可以写到任意位置。
   */
  apply_patch: ['path'],
  file_op: ['path', 'from', 'to'],
  desktop_act: ['source', 'target'],
};

/**
 * 某个工具在**这一次调用**里会被当作路径写入的字段。
 *
 * ★ 为什么是函数而不是查表：
 *   `desktop_act` 只有 `convert_office` 动文件，`set_value`/`invoke` 不动 ——
 *   一律按路径检查会把"往输入框里打字"误判成写文件。
 */
function writePathFields(toolName: string, args: unknown): readonly string[] | undefined {
  const fields = WRITE_PATH_TOOLS[toolName];
  if (fields === undefined) return undefined;
  if (toolName === 'desktop_act') {
    const action = (args as { action?: unknown } | null)?.action;
    return action === 'convert_office' ? fields : undefined;
  }
  if (toolName === 'file_op') {
    // 三种动作的字段组合不同：只看这次真正用到的，避免把缺省字段当路径。
    const action = (args as { action?: unknown } | null)?.action;
    if (action === 'move') return ['from', 'to'];
    if (action === 'mkdir' || action === 'remove') return ['path'];
    return undefined;
  }
  return fields;
}

export function resolveTaskWorkspace(raw: string | null): string {
  const root = raw !== null && raw.trim().length > 0 ? raw.trim() : defaultWorkspaceRoot();
  return resolve(root);
}

export async function assertWorkspaceDirectory(raw: string | null): Promise<string> {
  const root = resolveTaskWorkspace(raw);
  let info;
  try {
    info = await stat(root);
  } catch {
    throw new Error(`工作区不存在：${root}`);
  }
  if (!info.isDirectory()) throw new Error(`工作区不是目录：${root}`);
  return root;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function workspacePathGuard(root: string): (toolName: string, args: unknown) => string | null {
  return (toolName, args) => {
    const fields = writePathFields(toolName, args);
    if (fields === undefined || typeof args !== 'object' || args === null) return null;
    const record = args as Record<string, unknown>;
    for (const field of fields) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      const target = resolve(root, value);
      if (!inside(root, target)) {
        return `工作区权限拒绝：${value} 不在任务工作区 ${root} 内`;
      }
    }
    return null;
  };
}
