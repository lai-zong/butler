/**
 * 运行状态端点 —— 只读，用于确认服务端运行时真的在跑
 *
 * ★ 用途：
 *   · 确认**单例**生效（多次请求不重复初始化）
 *   · 确认事件文件路径与已落盘条数（持久化是否真的接上）
 *   · 确认模型是否已配置
 *
 * ⚠️ 刻意不返回任何记忆内容 —— 这是一个诊断端点，
 *    确认状态不需要暴露用户数据。
 */

import { NextResponse } from 'next/server';

import { getRuntime, DATA_DIR, eventsFile, DEFAULT_USER_ID } from '@/app/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();

  return NextResponse.json({
    ok: true,
    sessionId: rt.sessionId,
    userId: DEFAULT_USER_ID,
    startedAt: rt.startedAt,
    dataDir: DATA_DIR,
    eventsFile: eventsFile(),
    /** 内存中的事件数 */
    eventsInMemory: rt.bootstrapped.log.length,
    /** 待落盘的事件数（应当很快归零） */
    pendingPersistence: rt.bootstrapped.log.pendingPersistence(),
    /** 本次启动是否从磁盘恢复 */
    resumed: rt.bootstrapped.resumed,
    historicalEvents: rt.bootstrapped.historicalEvents,
    restored: rt.bootstrapped.restored,
    issues: rt.bootstrapped.issues.length,
    model: rt.model !== null ? rt.model.describe() : null,
  });
}
