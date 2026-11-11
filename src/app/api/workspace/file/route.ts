/**
 * 工作区面板 —— 文本文件读取与保存
 *
 * `GET /api/workspace/file?sessionId=…&path=…`  读文本
 * `PUT /api/workspace/file`                     保存（带冲突检测）
 *
 * ★ 保存必须带 `baseSha`（打开文件时拿到的指纹）：文件被 AI 或别的程序改过时
 *   直接拒绝，而不是静默覆盖。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { workspaceScopeOf } from '@/app/server/workspaceScope.js';
import {
  readWorkspaceText,
  writeWorkspaceText,
  WorkspaceFileError,
} from '@/app/server/workspaceFiles.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function statusOf(code: WorkspaceFileError['code']): number {
  if (code === 'not_found') return 404;
  if (code === 'protected' || code === 'outside_workspace') return 403;
  if (code === 'conflict') return 409;
  if (code === 'too_large') return 413;
  return 400;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  const path = req.nextUrl.searchParams.get('path') ?? '';
  try {
    const scope = await workspaceScopeOf(sessionId);
    const file = await readWorkspaceText(scope.root, scope.protectedPaths, path);
    return NextResponse.json({ ok: true, ...file });
  } catch (err) {
    if (err instanceof WorkspaceFileError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: statusOf(err.code) });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '读取文件失败' },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  let body: { sessionId?: unknown; path?: unknown; content?: unknown; baseSha?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const path = typeof body.path === 'string' ? body.path : '';
  const content = typeof body.content === 'string' ? body.content : null;
  if (path.trim().length === 0) return NextResponse.json({ error: '缺少 path' }, { status: 400 });
  if (content === null) return NextResponse.json({ error: '缺少 content' }, { status: 400 });

  try {
    const rt = await getRuntime();
    const scope = await workspaceScopeOf(typeof body.sessionId === 'string' ? body.sessionId : null);
    const saved = await writeWorkspaceText({
      root: scope.root,
      protectedPaths: scope.protectedPaths,
      path,
      content,
      ...(typeof body.baseSha === 'string' ? { baseSha: body.baseSha } : {}),
      log: rt.bootstrapped.log,
      clock: rt.clock,
    });
    // 保存是状态变更，尽快落盘（与其它写接口同一口径）
    await rt.bootstrapped.log.flushPersistence().catch(() => undefined);
    return NextResponse.json({ ok: true, ...saved });
  } catch (err) {
    if (err instanceof WorkspaceFileError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: statusOf(err.code) });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '保存失败' },
      { status: 500 },
    );
  }
}
