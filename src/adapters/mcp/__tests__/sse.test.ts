import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { SseTransport, sseTransportFactory } from '../sse.js';
import { DEFAULT_POLICY, type McpServerConfig } from '../../../core/mcp/types.js';

let server: ReturnType<typeof createServer> | null = null;
let stream: ServerResponse | null = null;

async function start(): Promise<string> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('event: endpoint\ndata: /messages\n\n');
      stream = res;
      req.on('close', () => {
        stream = null;
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/messages') {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => {
        raw += c;
      });
      req.on('end', () => {
        const msg = JSON.parse(raw) as { id?: number; method?: string; result?: unknown };
        res.writeHead(202);
        res.end();
        if (msg.id !== undefined && msg.method !== undefined && stream !== null) {
          stream.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { ok: true, method: msg.method },
            })}\n\n`,
          );
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}/sse`;
}

afterEach(async () => {
  stream?.end();
  stream = null;
  if (server !== null) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

describe('MCP HTTP+SSE 传输', () => {
  it('读取 endpoint、POST 请求、从 SSE 收 response', async () => {
    const url = await start();
    const tr = new SseTransport(url);
    await tr.start();
    const r = await tr.request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 2_000);
    expect(r.result).toEqual({ ok: true, method: 'initialize' });
    await tr.close();
  });

  it('通知走 POST 202，不需要 response', async () => {
    const url = await start();
    const tr = new SseTransport(url);
    await tr.start();
    await expect(
      tr.notify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).resolves.toBeUndefined();
    await tr.close();
  });

  it('工厂要求 url', async () => {
    const f = sseTransportFactory();
    await expect(
      f.open({
        id: 'x',
        name: 'x',
        transport: 'sse',
        enabled: true,
        policy: DEFAULT_POLICY,
      } as McpServerConfig),
    ).rejects.toThrow('缺少 URL');
  });
});
