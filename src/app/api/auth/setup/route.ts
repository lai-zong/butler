import { NextResponse, type NextRequest } from 'next/server';

import {
  LocalAuthError,
  issueSessionToken,
  setupLocalAuth,
  validatePassword,
  validateSecurityAnswer,
} from '@/app/server/localAuth.js';
import { requestSourceKey, setSessionCookie } from '@/app/server/localAuthHttp.js';
import { authErrorResponse, methodNotAllowed, readJsonBody } from '../_shared.js';
import { checkRateLimit, clearFailures, recordFailure } from '@/app/server/localAuthRateLimit.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 首次设置；只允许在认证文件不存在时调用。 */
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
  const invalid = validatePassword(body['password']);
  if (invalid !== null) {
    return NextResponse.json({ error: 'invalid_password', message: invalid }, { status: 400 });
  }
  const answerProblem = validateSecurityAnswer(body['answer']);
  if (answerProblem !== null) {
    return NextResponse.json({ error: 'invalid_answer', message: answerProblem }, { status: 400 });
  }

  try {
    const auth = await setupLocalAuth({
      password: body['password'],
      questionId: body['questionId'],
      answer: body['answer'],
    });
    clearFailures(key);
    const res = NextResponse.json({
      ok: true,
      configured: true,
      authenticated: true,
    });
    setSessionCookie(res, issueSessionToken(auth));
    return res;
  } catch (err) {
    if (err instanceof LocalAuthError && err.code === 'invalid_password') {
      recordFailure(key);
    }
    return authErrorResponse(err);
  }
}

export function GET(): NextResponse {
  return methodNotAllowed();
}
