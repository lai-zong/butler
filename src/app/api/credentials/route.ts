/**
 * 凭证保险库 API
 *
 * GET  /api/credentials        → 名称/时间，**不返回密文或明文**
 * POST /api/credentials        → {name, secret}，加密保存
 *
 * 删除在 /api/credentials/[id]。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getCredentialVault } from '@/app/server/credentials.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const vault = await getCredentialVault();
    return NextResponse.json(
      { credentials: await vault.list() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '凭证库不可用' },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const rec = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const name = typeof rec['name'] === 'string' ? rec['name'] : '';
  const secret = typeof rec['secret'] === 'string' ? rec['secret'] : '';
  if (name.trim().length === 0 || secret.trim().length === 0) {
    return NextResponse.json({ error: 'name 和 secret 都不能为空' }, { status: 400 });
  }
  try {
    const vault = await getCredentialVault();
    const meta = await vault.put(name, secret);
    return NextResponse.json({ credential: meta }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '凭证保存失败' },
      { status: 400 },
    );
  }
}
