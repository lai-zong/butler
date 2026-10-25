import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { McpClient } from '../client.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { DEFAULT_POLICY } from '../types.js';
import { sseTransportFactory } from '../../../adapters/mcp/sse.js';

let server: ReturnType<typeof createServer> | null = null;
let stream: ServerResponse | null = null;

async function start(): Promise<string> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
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
        const msg = JSON.parse(raw) as { id?: number; method?: string; params?: unknown };
        res.writeHead(202);
        res.end();
        if (msg.id === undefined || stream === null) return;
        const result =
          msg.method === 'initialize'
            ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'local-sse', version: '1' } }
            : msg.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'echo',
                      description: '回显',
                      inputSchema: { type: 'object' },
                    },
                  ],
                }
              : msg.method === 'tools/call'
                ? { content: [{ type: 'text', text: 'from-sse' }], isError: false }
                : null;
        if (result !== null) {
          stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
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

describe('McpClient + HTTP+SSE 集成', () => {
  it('连接、发现工具、调用工具', async () => {
    const url = await start();
    const log = new EventLog('s_mcp_sse');
    const clock = new FixedClock(1_760_000_000_000);
    const client = new McpClient(log, clock);
    client.registerTransport(sseTransportFactory());

    const added = client.addServer({
      id: 'local-sse',
      name: '本地 SSE',
      transport: 'sse',
      url,
      enabled: true,
      policy: DEFAULT_POLICY,
    });
    expect(added.ok).toBe(true);
    expect((await client.connect('local-sse')).ok).toBe(true);
    expect(client.getServer('local-sse')?.tools.map((t) => t.name)).toEqual(['echo']);

    const called = await client.callTool({
      serverId: 'local-sse',
      toolName: 'echo',
      toolArgs: {},
    });
    expect(called.ok).toBe(true);
    expect(called.text).toBe('from-sse');
  });
});
