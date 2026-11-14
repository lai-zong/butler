/**
 * 外部文件变更推送（SSE）。GET /api/files/watch?handle=…&sessionId=…
 *
 * ★ 用 fs.watch + 150ms 合并：保存一次通常触发多个事件，逐条推会让界面抖。
 * ★ 事件不带文件内容，界面收到 changed 后自己重新拉 preview。
 */

import type { NextRequest } from 'next/server';

import { subscribeExternalFile } from '@/app/server/externalFiles.js';
import { sessionIdOf } from '@/app/server/externalFileHttp.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const sessionId = sessionIdOf(req);
  const handle = req.nextUrl.searchParams.get('handle') ?? '';
  if (sessionId === null || handle === '') {
    return Response.json({ error: '缺少 handle 或 sessionId' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      send({ type: 'ready' });
      try {
        unsubscribe = subscribeExternalFile(handle, sessionId, (event) => {
          try {
            send(event);
          } catch {
            // 客户端已断开：取消订阅由 cancel 负责
          }
        });
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : '监听失败' });
        controller.close();
      }
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

