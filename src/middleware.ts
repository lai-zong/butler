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
    '/((?!_next/static|_next/image|favicon.ico|icon.png|brand/|pet/|api/auth/).*)',
  ],
};

function isApi(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

function withNext(pathname: string, search: string): string {
  return search.length > 0 ? `${pathname}${search}` : pathname;
}

/**
 * 与客户端 safeNextPath 保持同一套约束。
 *
 * 特别注意反斜杠：`/\evil.example` 在部分 URL 解析器里会被当成
 * 协议相对地址，服务端绝不能把它拼进 Location。
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

function safePageNext(raw: string | null): string {
  if (raw === null) return '/';
  const value = raw.trim();
  if (value.length === 0 || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (hasControlCharacter(value) || value.includes('\\')) return '/';
  let parsed: URL;
  try {
    parsed = new URL(value, 'http://butler.local');
  } catch {
    return '/';
  }
  if (parsed.origin !== 'http://butler.local') return '/';
  if (parsed.pathname === '/login' || parsed.pathname === '/setup') return '/';
  if (parsed.pathname.startsWith('/api/')) return '/';
  // 与客户端一致：应用视图在 hash 中，path-style next 必须归一为 #/...
  if (parsed.pathname !== '/') {
    return `/#${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return `/${parsed.search}${parsed.hash}`;
}

function redirectWithPath(req: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, req.nextUrl.origin));
}

function redirectToLogin(req: NextRequest, nextPath: string, error?: string): NextResponse {
  const url = new URL('/login', req.nextUrl.origin);
  url.searchParams.set('next', nextPath);
  if (error !== undefined) url.searchParams.set('error', error);
  return NextResponse.redirect(url);
}

function redirectToSetup(req: NextRequest, nextPath: string): NextResponse {
  const url = new URL('/setup', req.nextUrl.origin);
  url.searchParams.set('next', nextPath);
  return NextResponse.redirect(url);
}

function hostName(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 1 ? host.slice(1, end) : host;
  }
  return host.split(':')[0] ?? host;
}

function isLoopbackHost(req: NextRequest): boolean {
  const host = req.headers.get('host')?.trim() || req.nextUrl.host;
  const hostname = hostName(host);
  return hostname === '127.0.0.1' || hostname === '::1';
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;
  const nextPath = withNext(pathname, search);

  // 页面入口统一 canonical host。API 不跳转，避免客户端把 307 当成业务响应。
  // 127.0.0.1 与 localhost 的 host-only cookie 不共享；如果只跳根页面，
  // 用户从 127 打开 /login 或首次 /setup 仍会生成另一个 host 的会话。
  if (!isApi(pathname) && isLoopbackHost(req)) {
    return redirectWithPath(req, nextPath);
  }

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
    if (pathname === '/login' || pathname === '/setup') {
      return NextResponse.next();
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
    if (pathname === '/setup') return NextResponse.next();
    return redirectToSetup(req, nextPath);
  }

  const token = req.cookies.get(LOCAL_AUTH_COOKIE)?.value;
  if (token !== undefined && verifySessionToken(token, auth)) {
    // 已登录访问登录/设置页：直接回应用，绝不再渲染表单。
    if (pathname === '/login' || pathname === '/setup') {
      return redirectWithPath(req, safePageNext(req.nextUrl.searchParams.get('next')));
    }
    return NextResponse.next();
  }

  // 未登录允许打开登录/设置页；根页面仍会被下面的逻辑送到登录页。
  if (pathname === '/login') {
    return NextResponse.next();
  }
  if (pathname === '/setup') {
    return auth === null ? NextResponse.next() : redirectToLogin(req, nextPath);
  }

  if (isApi(pathname)) {
    return NextResponse.json(
      { error: 'unauthorized', message: '请先登录' },
      { status: 401 },
    );
  }
  return redirectToLogin(req, nextPath);
}
