/**
 * 工作区面板 —— 列目录
 *
 * `GET /api/workspace?sessionId=…&path=…`
 *
 * ★ 作用域与会话工具完全一致：同一工作区、同一套受保护路径。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { workspaceScopeOf } from '@/app/server/workspaceScope.js';
import { listWorkspace, WorkspaceFileError } from '@/app/server/workspaceFiles.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  const path = req.nextUrl.searchParams.get('path') ?? '.';

  try {
    const scope = await workspaceScopeOf(sessionId);
    const result = await listWorkspace(scope.root, scope.protectedPaths, path);
    return NextResponse.json({
      ok: true,
      root: result.root,
      path: result.path,
      entries: result.entries,
    });
  } catch (err) {
    if (err instanceof WorkspaceFileError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: statusOf(err.code) });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '读取工作区失败' },
      { status: 500 },
    );
  }
}

function statusOf(code: WorkspaceFileError['code']): number {
  if (code === 'not_found') return 404;
  if (code === 'protected') return 403;
  if (code === 'outside_workspace') return 403;
  return 400;
}
