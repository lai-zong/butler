/**
 * MCP Streamable HTTP 传输（最小实现）
 *
 * 规范：https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 *
 * ★ 只实现 Streamable HTTP（POST + JSON 或 SSE 响应）。
 *   旧的 HTTP+SSE（2024-11-05）不在这里假装支持 —— 需要单独的 GET SSE 通道。
 *
 * ★ 三条纪律：
 *   ① 每次请求都是独立 POST；`Mcp-Session-Id` 有就带回；
 *   ② 响应既可能是 application/json，也可能是 text/event-stream；
 *   ③ 超时必须真的 abort，不能让请求无限挂着。
 */

import type { McpTransportFactory, McpTransportPort } from '../../core/mcp/client.js';
import { parseMessage, type JsonRpcResponse } from '../../core/mcp/protocol.js';
import type { McpServerConfig } from '../../core/mcp/types.js';

const ERROR_BODY_LIMIT = 2_000;

function idOf(msg: unknown): number | string | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const id = (msg as { id?: unknown }).id;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

function pickResponse(value: unknown, expectedId: number | string): JsonRpcResponse {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const parsed = parseMessage(JSON.stringify(item));
    if (parsed.kind === 'response' && parsed.response.id === expectedId) {
      return parsed.response;
    }
  }
  throw new Error('MCP HTTP 响应里没有匹配的 JSON-RPC response');
}

export class HttpTransport implements McpTransportPort {
  private sessionId: string | null = null;
  private closed = false;

  constructor(private readonly url: string) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId !== null ? { 'mcp-session-id': this.sessionId } : {}),
    };
  }

  private captureSession(res: Response): void {
    const sid = res.headers.get('mcp-session-id');
    if (sid !== null && sid.length > 0) this.sessionId = sid;
  }

  async request(msg: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    if (this.closed) throw new Error('传输已关闭');
    const expectedId = idOf(msg);
    if (expectedId === null) throw new Error('请求缺少 id');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(msg),
        signal: controller.signal,
      });
      this.captureSession(res);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `MCP HTTP ${res.status}：${text.slice(0, ERROR_BODY_LIMIT) || res.statusText}`,
        );
      }

      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (type.includes('text/event-stream')) {
        return await this.readSse(res, expectedId);
      }
      if (type.includes('application/json')) {
        const body = (await res.json()) as unknown;
        return pickResponse(body, expectedId);
      }
      throw new Error(`MCP HTTP 不支持的响应类型：${type || '(空)'}`);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`MCP HTTP 请求超时（${timeoutMs}ms）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readSse(res: Response, expectedId: number | string): Promise<JsonRpcResponse> {
    if (res.body === null) throw new Error('MCP SSE 响应没有 body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line.length === 0) {
            if (dataLines.length > 0) {
              const parsed = parseMessage(dataLines.join('\n'));
              dataLines = [];
              if (parsed.kind === 'response' && parsed.response.id === expectedId) {
                return parsed.response;
              }
            }
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          idx = buffer.indexOf('\n');
        }
      }
      // 流结束前最后一个事件可能没有空行
      if (dataLines.length > 0) {
        const parsed = parseMessage(dataLines.join('\n'));
        if (parsed.kind === 'response' && parsed.response.id === expectedId) {
          return parsed.response;
        }
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    throw new Error('MCP SSE 流结束前没有收到匹配的 response');
  }

  async notify(msg: unknown): Promise<void> {
    if (this.closed) throw new Error('传输已关闭');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(msg),
        signal: controller.signal,
      });
      this.captureSession(res);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `MCP HTTP 通知失败 ${res.status}：${text.slice(0, ERROR_BODY_LIMIT) || res.statusText}`,
        );
      }
      // 202/204/200 都可能；通知不消费 body
      void res.body?.cancel().catch(() => undefined);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('MCP HTTP 通知超时（30000ms）');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sessionId !== null) {
      try {
        await fetch(this.url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': this.sessionId },
        });
      } catch {
        // 关闭失败不影响本地状态
      }
    }
  }
}

export function httpTransportFactory(): McpTransportFactory {
  return {
    transport: 'http',
    async open(config: McpServerConfig): Promise<McpTransportPort> {
      if (config.url === undefined || config.url.trim().length === 0) {
        throw new Error('streamable-http 传输缺少 URL');
      }
      return new HttpTransport(config.url);
    },
  };
}
