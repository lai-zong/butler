import { NextResponse, type NextRequest } from 'next/server';

import {
  LocalAuthError,
  SESSION_TTL_MS,
  issueSessionToken,
  verifyLocalPassword,
} from '@/app/server/localAuth.js';
import { requestSourceKey, setSessionCookie } from '@/app/server/localAuthHttp.js';
import { authErrorResponse, methodNotAllowed, readJsonBody } from '../_shared.js';
import { checkRateLimit, clearFailures, recordFailure } from '@/app/server/localAuthRateLimit.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const key = requestSourceKey(req);
  const limit = checkRateLimit(key);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: `尝试过多，请 ${limit.retryAfterSeconds} 秒后再试` },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const body = await readJsonBody(req);
  if (body === null) {
    return NextResponse.json({ error: 'invalid_body', message: '请求格式不正确' }, { status: 400 });
  }

  try {
    const auth = await verifyLocalPassword(body['password']);
    clearFailures(key);
    const res = NextResponse.json({
      ok: true,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    setSessionCookie(res, issueSessionToken(auth));
    return res;
  } catch (err) {
    if (
      err instanceof LocalAuthError &&
      (err.code === 'invalid_password' || err.code === 'not_configured')
    ) {
      recordFailure(key);
    }
    return authErrorResponse(err);
  }
}

export function GET(): NextResponse {
  return methodNotAllowed();
}
