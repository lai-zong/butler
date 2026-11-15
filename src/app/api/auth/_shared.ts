import { NextResponse, type NextRequest } from 'next/server';

import {
  LOCAL_AUTH_COOKIE,
  LocalAuthError,
  loadLocalAuth,
  verifySessionToken,
  type LocalAuthFile,
} from '@/app/server/localAuth.js';

export async function readJsonBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const value = (await req.json()) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function authErrorResponse(err: unknown): NextResponse {
  if (err instanceof LocalAuthError) {
    return NextResponse.json(
      { error: err.code, message: err.message },
      { status: err.status },
    );
  }
  return NextResponse.json(
    { error: 'auth_internal_error', message: err instanceof Error ? err.message : '认证失败' },
    { status: 500 },
  );
}

export function methodNotAllowed(): NextResponse {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

/**
 * 路由内部的第二道校验。
 *
 * middleware 已经挡了一次；这里再验一次，避免“middleware 配置漏了路径”
 * 直接变成认证绕过。
 */
export async function requireSession(req: NextRequest): Promise<LocalAuthFile> {
  const auth = await loadLocalAuth();
  if (auth === null) {
    throw new LocalAuthError('not_configured', '还没有设置本地登录', 409);
  }
  const token = req.cookies.get(LOCAL_AUTH_COOKIE)?.value;
  if (token === undefined || !verifySessionToken(token, auth)) {
    throw new LocalAuthError('invalid_session', '请先登录', 401);
  }
  return auth;
}
