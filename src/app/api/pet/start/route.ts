/**
 * 从设置页重新打开桌宠。
 *
 * 只启动固定的 `scripts/desktop_pet.py`，不接受任意命令/路径。
 * 单实例由 Python 的锁保证；这里只负责把“用户点了一下”变成真实进程。
 */

import { NextResponse } from 'next/server';

import { launchPet } from '@/app/server/petRuntime.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

export async function POST(): Promise<NextResponse> {
  try {
    const result = await launchPet();
    return NextResponse.json({
      ok: true,
      alreadyRunning: result.alreadyRunning,
      status: result.status,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
