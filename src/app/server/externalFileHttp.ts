/**
 * 外部文件路由的公共小工具：错误映射、会话参数、受保护根。
 *
 * ★ 受保护根与工作区那套保持一致（.butler-data / .env.local / config），
 *   外部文件面板只是"用户指定的文件"，不应该变成读取系统内部数据的后门。
 */

import { join, resolve } from 'node:path';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { ExternalFileError } from './externalFiles.js';
import { OfficePreviewError } from './officePreview.js';

export function sessionIdOf(req: NextRequest): string | null {
  const value = req.nextUrl.searchParams.get('sessionId');
  return value === null || value.trim() === '' ? null : value;
}

export function externalProtectedPaths(dataDir: string): readonly string[] {
  const appRoot = process.cwd();
  return [
    resolve(dataDir),
    join(appRoot, '.butler-data'),
    join(appRoot, '.env.local'),
    join(appRoot, 'config'),
  ];
}

export function externalErrorResponse(err: unknown): NextResponse {
  if (err instanceof ExternalFileError) {
    const status =
      err.code === 'not_found'
        ? 404
        : err.code === 'forbidden' || err.code === 'bad_handle'
          ? 403
          : err.code === 'too_large'
            ? 413
            : err.code === 'conflict'
              ? 409
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
    { error: err instanceof Error ? err.message : '外部文件操作失败' },
    { status: 500 },
  );
}
