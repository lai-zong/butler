import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { McpClient } from '../client.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { DEFAULT_POLICY } from '../types.js';
import { httpTransportFactory } from '../../../adapters/mcp/http.js';

let server: ReturnType<typeof createServer> | null = null;

async function start(): Promise<string> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      raw += c;
    });
    req.on('end', () => {
      const msg = raw.length > 0 ? (JSON.parse(raw) as { id?: number; method?: string; params?: unknown }) : null;
      if (msg === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      const id = msg.id ?? null;
      const reply = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      };
      switch (msg.method) {
        case 'initialize':
          reply({
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'local-http', version: '1' },
          });
          return;
        case 'tools/list':
          reply({
            tools: [
              {
                name: 'echo',
                description: '回显输入',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              },
            ],
          });
          return;
        case 'tools/call': {
          const params = (msg.params ?? {}) as { arguments?: { text?: unknown } };
          reply({
            content: [{ type: 'text', text: `echo:${String(params.arguments?.text ?? '')}` }],
            isError: false,
          });
          return;
        }
        default:
          res.writeHead(202);
          res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}/mcp`;
}

afterEach(async () => {
  if (server !== null) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

describe('McpClient + streamable-http 集成', () => {
  it('连接、发现工具、调用工具并落审计', async () => {
    const url = await start();
    const log = new EventLog('s_mcp_http');
    const clock = new FixedClock(1_760_000_000_000);
    const client = new McpClient(log, clock);
    client.registerTransport(httpTransportFactory());

    const added = client.addServer({
      id: 'local-http',
      name: '本地 HTTP',
      transport: 'http',
      url,
      enabled: true,
      policy: DEFAULT_POLICY,
    });
    expect(added.ok).toBe(true);
    const connected = await client.connect('local-http');
    expect(connected.ok).toBe(true);
    expect(client.getServer('local-http')?.state).toBe('connected');
    expect(client.getServer('local-http')?.tools.map((t) => t.name)).toEqual(['echo']);

    const called = await client.callTool({
      serverId: 'local-http',
      toolName: 'echo',
      toolArgs: { text: '你好' },
    });
    expect(called.ok).toBe(true);
    expect(called.text).toBe('echo:你好');
    expect(log.byType('mcp.serverConnected')).toHaveLength(1);
  });
});
