import { NextResponse, type NextRequest } from 'next/server';

import {
  changeLocalPassword,
  issueSessionToken,
} from '@/app/server/localAuth.js';
import { setSessionCookie } from '@/app/server/localAuthHttp.js';
import { authErrorResponse, methodNotAllowed, readJsonBody, requireSession } from '../_shared.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireSession(req);
    const body = await readJsonBody(req);
    if (body === null) {
      return NextResponse.json({ error: 'invalid_body', message: '请求格式不正确' }, { status: 400 });
    }
    const auth = await changeLocalPassword(body['currentPassword'], body['newPassword']);
    const res = NextResponse.json({ ok: true });
    setSessionCookie(res, issueSessionToken(auth));
    return res;
  } catch (err) {
    return authErrorResponse(err);
  }
}

export function GET(): NextResponse {
  return methodNotAllowed();
}
