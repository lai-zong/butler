/**
 * 浏览器面板 —— 画面帧（SSE）
 *
 * `GET /api/browser/stream`
 *
 * ★ 为什么用 SSE 而不是 WebSocket：
 *   Next.js 的 Route Handler 不提供 WebSocket；本地回环下 SSE 足够，
 *   而且天然是单向的——输入走另一个 POST 端点。
 *
 * 帧格式：`data: {"data":"<base64 jpeg>","width":1280,"height":800,"at":...}`
 */

import { BrowserError, subscribeFrames } from '@/app/server/browserSession.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // 客户端已断开
        }
      };

      try {
        unsubscribe = subscribeFrames((frame) => {
          send(`data: ${JSON.stringify(frame)}\n\n`);
        });
      } catch (err) {
        const code = err instanceof BrowserError ? err.code : 'cdp_error';
        send(`event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : '浏览器未启动', code })}\n\n`);
        controller.close();
        return;
      }

      // 心跳：避免中间层把空闲连接断掉
      heartbeat = setInterval(() => send(': ping\n\n'), 15_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat !== null) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
  });
}
