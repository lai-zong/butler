import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getCredentialVault } from '@/app/server/credentials.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    const vault = await getCredentialVault();
    const removed = await vault.remove(id);
    if (!removed) return NextResponse.json({ error: '找不到这条凭证' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '凭证删除失败' },
      { status: 503 },
    );
  }
}
