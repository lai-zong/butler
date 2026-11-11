/**
 * 工作区面板 —— 图片等二进制预览
 *
 * `GET /api/workspace/raw?sessionId=…&path=…`
 *
 * ⚠️ 只放行图片扩展名：这个端点回的是原始字节，不能变成任意文件读取器。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { workspaceScopeOf } from '@/app/server/workspaceScope.js';
import { readWorkspaceRaw, WorkspaceFileError } from '@/app/server/workspaceFiles.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function statusOf(code: WorkspaceFileError['code']): number {
  if (code === 'not_found') return 404;
  if (code === 'protected' || code === 'outside_workspace') return 403;
  if (code === 'too_large') return 413;
  return 400;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  const path = req.nextUrl.searchParams.get('path') ?? '';

  try {
    const scope = await workspaceScopeOf(sessionId);
    const file = await readWorkspaceRaw(scope.root, scope.protectedPaths, path);
    return new NextResponse(new Uint8Array(file.buffer), {
      status: 200,
      headers: {
        'Content-Type': file.mime,
        'Content-Length': String(file.size),
        // 文件内容会变；不做长缓存，只允许浏览器内存缓存
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof WorkspaceFileError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: statusOf(err.code) });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '读取失败' },
      { status: 500 },
    );
  }
}
