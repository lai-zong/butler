import { NextResponse, type NextRequest } from 'next/server';

import {
  securityQuestionOf,
  setLocalSecurityQuestion,
} from '@/app/server/localAuth.js';
import { authErrorResponse, methodNotAllowed, readJsonBody, requireSession } from '../_shared.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 已登录后补设/替换找回问题；必须同时提供当前密码。 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession(req);
    const body = await readJsonBody(req);
    if (body === null) {
      return NextResponse.json({ error: 'invalid_body', message: '请求格式不正确' }, { status: 400 });
    }
    const auth = await setLocalSecurityQuestion(
      body['currentPassword'],
      body['questionId'],
      body['answer'],
    );
    return NextResponse.json({ ok: true, securityQuestion: securityQuestionOf(auth) });
  } catch (err) {
    return authErrorResponse(err);
  }
}

export function GET(): NextResponse {
  return methodNotAllowed();
}
