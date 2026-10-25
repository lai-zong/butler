import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { HttpTransport, httpTransportFactory } from '../http.js';
import type { McpServerConfig } from '../../../core/mcp/types.js';
import { DEFAULT_POLICY } from '../../../core/mcp/types.js';

let server: ReturnType<typeof createServer> | null = null;

async function start(
  handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void,
): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      raw += c;
    });
    req.on('end', () => {
      handler(req, res, raw.length > 0 ? JSON.parse(raw) : null);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (server !== null) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

describe('MCP Streamable HTTP 传输', () => {
  it('JSON 响应 + session header', async () => {
    const seen: { session: string | null } = { session: null };
    const url = await start((req, res, body) => {
      const msg = body as { id: number; method: string } | null;
      if (msg === null) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (msg.method === 'initialize') {
        res.setHeader('mcp-session-id', 'sess-1');
      } else {
        seen.session = (req.headers['mcp-session-id'] as string | undefined) ?? null;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: msg.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { tools: [] },
        }),
      );
    });
    const tr = new HttpTransport(url);
    const init = await tr.request(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      2_000,
    );
    expect(init.result).toEqual({ protocolVersion: '2025-03-26' });
    const list = await tr.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 2_000);
    expect(list.result).toEqual({ tools: [] });
    expect(seen.session).toBe('sess-1');
    await tr.close();
  });

  it('SSE 响应会跳过通知并等到匹配的 response', async () => {
    const url = await start((_req, res, body) => {
      const msg = body as { id: number };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
      );
      res.write(`data: {"jsonrpc":"2.0","id":${msg.id},"result":{"ok":true}}\n\n`);
      res.end();
    });
    const tr = new HttpTransport(url);
    const r = await tr.request({ jsonrpc: '2.0', id: 3, method: 'tools/call' }, 2_000);
    expect(r.result).toEqual({ ok: true });
    await tr.close();
  });

  it('通知走 202，不发请求 id', async () => {
    let method = '';
    const url = await start((_req, res, body) => {
      method = (body as { method: string }).method;
      res.writeHead(202);
      res.end();
    });
    const tr = new HttpTransport(url);
    await tr.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(method).toBe('notifications/initialized');
    await tr.close();
  });

  it('工厂要求 url', async () => {
    const f = httpTransportFactory();
    await expect(
      f.open({
        id: 'x',
        name: 'x',
        transport: 'http',
        enabled: true,
        policy: DEFAULT_POLICY,
      } as McpServerConfig),
    ).rejects.toThrow('缺少 URL');
  });
});
