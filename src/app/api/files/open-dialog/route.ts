/**
 * 打开工作区外的文件（原生选择框）。
 *
 * POST /api/files/open-dialog  { sessionId }
 *
 * ★ 返回 handle，不返回可用于读写的裸路径接口；后续所有操作都带 handle。
 * ★ 测试/自动化：设置 BUTLER_EXTERNAL_FILE_TEST_PATH 时跳过原生对话框，
 *   直接登记该文件——只用于本机验收，不改变正常路径的行为。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { pickExternalFile, registerExternalFile } from '@/app/server/externalFiles.js';
import { externalErrorResponse } from '@/app/server/externalFileHttp.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (sessionId === '') {
      return NextResponse.json({ error: '缺少 sessionId' }, { status: 400 });
    }
    const testPath = process.env.BUTLER_EXTERNAL_FILE_TEST_PATH;
    const file =
      testPath !== undefined && testPath !== ''
        ? await registerExternalFile(testPath, sessionId)
        : await pickExternalFile(sessionId);
    return NextResponse.json({ ok: true, file });
  } catch (err) {
    return externalErrorResponse(err);
  }
}
