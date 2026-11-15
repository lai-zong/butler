import { NextResponse, type NextRequest } from 'next/server';

import {
  LOCAL_AUTH_COOKIE,
  loadLocalAuth,
  revokeLocalSessions,
  verifySessionToken,
} from '@/app/server/localAuth.js';
import { clearSessionCookie } from '@/app/server/localAuthHttp.js';
import { methodNotAllowed } from '../_shared.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  try {
    const auth = await loadLocalAuth();
    const token = req.cookies.get(LOCAL_AUTH_COOKIE)?.value;
    // 只有携带有效会话时才轮换密钥，避免未登录请求把别人强制登出。
    if (auth !== null && token !== undefined && verifySessionToken(token, auth)) {
      await revokeLocalSessions();
    }
  } catch {
    // 认证文件损坏时仍然清 cookie；下一次请求会被 middleware 拦到登录/修复页。
  }
  clearSessionCookie(res);
  return res;
}

export function GET(): NextResponse {
  return methodNotAllowed();
}
