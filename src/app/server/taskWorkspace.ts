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

import { pathFieldsOf } from '@/core/tools/pathFields.js';
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
    if (typeof args !== 'object' || args === null) return null;
    // 共享映射：只看这次真正会写的路径（desktop_act 的点击不算写文件）
    const fields = pathFieldsOf(toolName, args).writes;
    if (fields.length === 0) return null;
    for (const value of fields) {
      const target = resolve(root, value);
      if (!inside(root, target)) {
        return `工作区权限拒绝：${value} 不在任务工作区 ${root} 内`;
      }
    }
    return null;
  };
}
