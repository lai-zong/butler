/**
 * MCP HTTP+SSE 传输（旧版 2024-11-05）
 *
 * 规范：https://modelcontextprotocol.io/specification/2024-11-05/basic/transports
 *
 * ★ 与 streamable-http 的区别：
 *   - 先 GET 一个 SSE 流；
 *   - server 发 `endpoint` 事件，告诉客户端 POST 地址；
 *   - 所有 server 消息从 SSE 流回来，POST 只负责发送。
 *
 * ★ 只做规范要求的最小闭环：endpoint、message、通知、关闭、超时。
 *   不做自动重连 —— 断线后必须让上层看到失败并决定是否重连，不能假装还活着。
 */

import type { McpTransportFactory, McpTransportPort } from '../../core/mcp/client.js';
import { parseMessage, type JsonRpcResponse } from '../../core/mcp/protocol.js';
import type { McpServerConfig } from '../../core/mcp/types.js';

const ENDPOINT_TIMEOUT_MS = 10_000;
const NOTIFY_TIMEOUT_MS = 30_000;

function idOf(msg: unknown): number | string | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const id = (msg as { id?: unknown }).id;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

export class SseTransport implements McpTransportPort {
  private endpoint: string | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private abort: AbortController | null = null;
  private closed = false;
  private readonly pending = new Map<
    number | string,
    {
      readonly resolve: (r: JsonRpcResponse) => void;
      readonly reject: (e: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly url: string) {}

  async start(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    const res = await fetch(this.url, {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (!res.ok) {
      throw new Error(`MCP SSE 连接失败：HTTP ${res.status}`);
    }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!type.includes('text/event-stream') || res.body === null) {
      throw new Error(`MCP SSE 响应类型不对：${type || '(空)'}`);
    }
    this.reader = res.body.getReader();

    const endpointReady = new Promise<void>((resolve, reject) => {
      this.endpointResolve = resolve;
      this.endpointReject = reject;
      const timer = setTimeout(() => {
        reject(new Error('MCP SSE 等待 endpoint 事件超时'));
      }, ENDPOINT_TIMEOUT_MS);
      this.endpointTimer = timer;
    });

    void this.readLoop();
    await endpointReady;
  }

  private endpointResolve: (() => void) | null = null;
  private endpointReject: ((e: Error) => void) | null = null;
  private endpointTimer: ReturnType<typeof setTimeout> | null = null;

  private settleEndpoint(err?: Error): void {
    if (this.endpointTimer !== null) {
      clearTimeout(this.endpointTimer);
      this.endpointTimer = null;
    }
    if (err !== undefined) {
      this.endpointReject?.(err);
    } else {
      this.endpointResolve?.();
    }
    this.endpointResolve = null;
    this.endpointReject = null;
  }

  private async readLoop(): Promise<void> {
    if (this.reader === null) return;
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let dataLines: string[] = [];

    const dispatch = (): void => {
      const data = dataLines.join('\n');
      const name = eventName;
      eventName = '';
      dataLines = [];
      if (data.length === 0) return;

      if (name === 'endpoint') {
        try {
          this.endpoint = new URL(data, this.url).toString();
          this.settleEndpoint();
        } catch {
          this.settleEndpoint(new Error(`MCP SSE endpoint 不是合法 URL：${data}`));
        }
        return;
      }

      const parsed = parseMessage(data);
      if (parsed.kind === 'response') {
        const p = this.pending.get(parsed.response.id ?? '');
        if (p !== undefined) {
          clearTimeout(p.timer);
          this.pending.delete(parsed.response.id ?? '');
          p.resolve(parsed.response);
        }
      }
      // 通知、server 请求都忽略：当前 TransportPort 没有反向询问通道
    };

    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line.length === 0) {
            dispatch();
          } else if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          idx = buffer.indexOf('\n');
        }
      }
      dispatch();
    } catch (err) {
      if (!this.closed) {
        this.settleEndpoint(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.closed = true;
      this.settleEndpoint(new Error('MCP SSE 连接已断开'));
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP SSE 连接已断开'));
      }
      this.pending.clear();
    }
  }

  private async post(msg: unknown, timeoutMs: number): Promise<void> {
    if (this.endpoint === null) throw new Error('MCP SSE endpoint 尚未就绪');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`MCP SSE POST 失败 ${res.status}：${text.slice(0, 2000)}`);
      }
      void res.body?.cancel().catch(() => undefined);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`MCP SSE POST 超时（${timeoutMs}ms）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(msg: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    if (this.closed) throw new Error('传输已关闭');
    const id = idOf(msg);
    if (id === null) throw new Error('请求缺少 id');

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP SSE 请求超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.post(msg, timeoutMs).catch((err: unknown) => {
        const p = this.pending.get(id);
        if (p !== undefined) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async notify(msg: unknown): Promise<void> {
    if (this.closed) throw new Error('传输已关闭');
    await this.post(msg, NOTIFY_TIMEOUT_MS);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    void this.reader?.cancel().catch(() => undefined);
    this.settleEndpoint(new Error('传输已关闭'));
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('传输已关闭'));
    }
    this.pending.clear();
  }
}

export function sseTransportFactory(): McpTransportFactory {
  return {
    transport: 'sse',
    async open(config: McpServerConfig): Promise<McpTransportPort> {
      if (config.url === undefined || config.url.trim().length === 0) {
        throw new Error('SSE 传输缺少 URL');
      }
      const tr = new SseTransport(config.url);
      await tr.start();
      return tr;
    },
  };
}
