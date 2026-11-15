import { NextResponse, type NextRequest } from 'next/server';

import {
  LOCAL_AUTH_COOKIE,
  LocalAuthError,
  loadLocalAuth,
  securityQuestionOf,
  verifySessionToken,
} from '@/app/server/localAuth.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 公开端点：登录页/设置页据此判断是首次设置还是登录。 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await loadLocalAuth();
    if (auth === null) {
      return NextResponse.json({
        ok: true,
        configured: false,
        authenticated: false,
        setupRequired: true,
        securityQuestion: null,
      });
    }
    const token = req.cookies.get(LOCAL_AUTH_COOKIE)?.value;
    return NextResponse.json({
      ok: true,
      configured: true,
      authenticated: token !== undefined && verifySessionToken(token, auth),
      setupRequired: false,
      securityQuestion: securityQuestionOf(auth),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof LocalAuthError ? err.code : 'auth_unavailable',
        message: err instanceof Error ? err.message : '本地认证不可用',
      },
      { status: 503 },
    );
  }
}
