import { NextResponse, type NextRequest } from 'next/server';

import {
  LOCAL_AUTH_COOKIE,
  LocalAuthError,
  loadLocalAuth,
  verifySessionToken,
} from './app/server/localAuth.js';

/**
 * 本地登录门禁。
 *
 * ★ 必须用 Node runtime：
 *   middleware 要读 `.butler-data/local-auth.json` 并验 HMAC；
 *   Edge runtime 没有 fs，无法做到“文件不存在 = 首次设置”。
 *
 * ★ 这里只做第一道门：
 *   - 页面未登录 → /login（或首次启动 → /setup）
 *   - API 未登录 → 401
 *   - auth API、登录/设置页、静态资源放行
 *   路由内部仍会再校验一次，避免 middleware 出错时裸奔。
 */
export const runtime = 'nodejs';

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|pet/|login|setup|api/auth/).*)',
  ],
};

function isApi(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

function withNext(pathname: string, search: string): string {
  return search.length > 0 ? `${pathname}${search}` : pathname;
}

function redirectToLogin(req: NextRequest, nextPath: string, error?: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('next', nextPath);
  if (error !== undefined) url.searchParams.set('error', error);
  return NextResponse.redirect(url);
}

function redirectToSetup(req: NextRequest, nextPath: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = '/setup';
  url.search = '';
  url.searchParams.set('next', nextPath);
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;
  const nextPath = withNext(pathname, search);

  let auth;
  try {
    auth = await loadLocalAuth();
  } catch (err) {
    if (isApi(pathname)) {
      return NextResponse.json(
        {
          error: err instanceof LocalAuthError ? err.code : 'auth_unavailable',
          message: err instanceof Error ? err.message : '本地认证不可用',
        },
        { status: 503 },
      );
    }
    return redirectToLogin(req, nextPath, 'auth_unavailable');
  }

  if (auth === null) {
    if (isApi(pathname)) {
      return NextResponse.json(
        { error: 'setup_required', message: '还没有设置本地登录' },
        { status: 401 },
      );
    }
    return redirectToSetup(req, nextPath);
  }

  const token = req.cookies.get(LOCAL_AUTH_COOKIE)?.value;
  if (token !== undefined && verifySessionToken(token, auth)) {
    return NextResponse.next();
  }

  if (isApi(pathname)) {
    return NextResponse.json(
      { error: 'unauthorized', message: '请先登录' },
      { status: 401 },
    );
  }
  return redirectToLogin(req, nextPath);
}
