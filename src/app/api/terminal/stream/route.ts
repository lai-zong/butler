/**
 * 终端输出流（SSE）。GET /api/terminal/stream?id=…&sessionId=…
 *
 * ★ 先回放 200KB 以内的历史输出，再持续推送；notice 用来维持连接心跳。
 */

import type { NextRequest } from 'next/server';

import { subscribeTerminal, TerminalError } from '@/app/server/terminalSessions.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const id = req.nextUrl.searchParams.get('id') ?? '';
  const sessionId = req.nextUrl.searchParams.get('sessionId') ?? '';
  if (id === '' || sessionId === '') {
    return Response.json({ error: '缺少 id 或 sessionId' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        unsubscribe = subscribeTerminal(id, sessionId, (event) => {
          try {
            send(event);
          } catch {
            // 客户端已断开；由 cancel 清理
          }
        });
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof TerminalError ? err.message : '终端连接失败',
        });
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
