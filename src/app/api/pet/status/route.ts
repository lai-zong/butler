/**
 * 桌宠进程状态：设置页据此决定“启动”还是“正在运行”。
 *
 * 只看 PID 文件 + 进程存活；不把设置页内存里的“刚点击”当成真相。
 */

import { NextResponse } from 'next/server';

import { petRuntimeStatus } from '@/app/server/petRuntime.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const status = await petRuntimeStatus();
    return NextResponse.json({ ok: true, ...status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
