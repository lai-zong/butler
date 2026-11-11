/**
 * 审查临时副本。
 *
 * 只复制工作区里可审查的内容；node_modules 用链接指回原目录，
 * 避免每次审查都复制几百 MB。命令的 cwd 被 NodeExec 限制在这个临时根下。
 */

import { access, cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NodeExec } from '@/adapters/exec/node.js';
import { execTool } from '@/core/tools/builtin/exec.js';
import type { ToolSpec } from '@/core/tools/types.js';

const SKIP_NAMES = new Set(['.git', '.next', '.butler-data', '.cache', 'node_modules']);

export interface ReviewSandbox {
  readonly root: string;
  readonly runCommand: ToolSpec;
  cleanup(): Promise<void>;
}

export async function createReviewSandbox(workspace: string): Promise<ReviewSandbox> {
  const root = await mkdtemp(join(tmpdir(), 'butler-review-'));
  try {
    await cp(workspace, root, {
      recursive: true,
      force: true,
      filter: (source) => {
        const name = source.split(/[\\/]/).pop() ?? '';
        return !SKIP_NAMES.has(name);
      },
    });
  } catch (err) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // 测试和构建通常需要依赖；链接原 node_modules，不复制。
  const sourceModules = join(workspace, 'node_modules');
  try {
    await access(sourceModules, constants.F_OK);
    await symlink(
      sourceModules,
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch {
    // 没有依赖目录时，命令仍可执行只读/无依赖命令
  }

  const base = execTool(new NodeExec({ cwdRoot: root }), root);
  const runCommand: ToolSpec = {
    ...base,
    tier: 'readOnly',
    description:
      '在本次审查的临时副本里执行命令并返回输出，不会写入用户工作区。' +
      '参数以数组传入，不经过 shell；适合 npm test、npm run build、git status 等验证。' +
      '临时副本会在审查结束后删除。',
  };

  return {
    root,
    runCommand,
    async cleanup() {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
