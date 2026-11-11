/**
 * 工作区面板 —— Office / PDF 只读预览
 *
 * `GET /api/workspace/preview?sessionId=…&path=…`
 *
 * · .pdf            → 交给浏览器内置查看器（返回一个 raw 地址）
 * · .docx / .xlsx   → 服务端零依赖解析成文本 / 表格
 * · 其它            → 400，界面提示"用系统应用打开"
 */

import { extname } from 'node:path';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { workspaceScopeOf } from '@/app/server/workspaceScope.js';
import { readWorkspaceBytes, readWorkspaceRaw, WorkspaceFileError } from '@/app/server/workspaceFiles.js';
import { OfficePreviewError, previewOffice } from '@/app/server/officePreview.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  const path = req.nextUrl.searchParams.get('path') ?? '';

  try {
    const scope = await workspaceScopeOf(sessionId);
    const ext = extname(path).toLowerCase();

    if (ext === '.pdf') {
      // 只做权限校验；真正的字节由 raw 端点吐给浏览器
      await readWorkspaceRaw(scope.root, scope.protectedPaths, path);
      const query = new URLSearchParams({ path, ...(sessionId !== null ? { sessionId } : {}) });
      return NextResponse.json({ ok: true, kind: 'pdf', url: `/api/workspace/raw?${query.toString()}` });
    }

    const file = await readWorkspaceBytes(scope.root, scope.protectedPaths, path);
    const preview = previewOffice(file.buffer, ext);
    return NextResponse.json({ ok: true, ...preview });
  } catch (err) {
    if (err instanceof WorkspaceFileError) {
      const status =
        err.code === 'not_found'
          ? 404
          : err.code === 'protected' || err.code === 'outside_workspace'
            ? 403
            : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    if (err instanceof OfficePreviewError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === 'too_large' ? 413 : 400 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '预览失败' },
      { status: 500 },
    );
  }
}
