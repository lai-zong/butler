/**
 * 工作区面板的作用域解析
 *
 * ★ 面板与 AI 工具共用同一个"会话工作区 + 受保护路径"：
 *   否则会出现"AI 只能改工作区里的文件，用户手点却能改到外面"的口径不一致。
 */

import { assertSessionWorkspace, protectedSessionPaths } from './sessionWorkspace.js';
import { scopeDefaultsOf } from './sessionScope.js';
import type { SessionPermission } from '@/core/chat/settings.js';
import { getRuntime } from '@/app/runtime';

export interface WorkspaceScope {
  readonly root: string;
  readonly permission: SessionPermission;
  readonly protectedPaths: readonly string[];
}

export async function workspaceScopeOf(sessionId: string | null): Promise<WorkspaceScope> {
  const rt = await getRuntime();
  const session =
    sessionId !== null && sessionId.trim().length > 0
      ? rt.bootstrapped.chat.getSession(sessionId.trim())
      : undefined;

  const defaults = scopeDefaultsOf(rt);
  const rawRoot = session?.workspace ?? defaults.workspace;
  const root = await assertSessionWorkspace(rawRoot, {
    dataDir: rt.dataDir,
    appRoot: rt.appRoot,
  });

  return {
    root,
    permission: session?.permission ?? defaults.permission,
    protectedPaths: protectedSessionPaths(root, { dataDir: rt.dataDir, appRoot: rt.appRoot }),
  };
}
