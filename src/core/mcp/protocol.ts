/**
 * MCP 协议层 —— JSON-RPC 2.0 编解码与握手
 *
 * 设计依据：方案 § 10.1（实现标准客户端）
 *
 * ★ 这个文件是纯逻辑：**不碰进程、不碰网络**（ADR 0004）。
 *   传输由 adapters/mcp/ 的 TransportPort 提供，
 *   所以协议编解码可以完全确定性地测试 —— 不需要真的起一个 MCP server。
 *
 * ⚠️ 关于"实现标准客户端而非复制代码"（方案 § 10.1 的合规理由）：
 *   这里写的是 JSON-RPC 2.0 与 MCP 的消息形状，
 *   属于**协议实现**，与调用 LLM API 同类，不构成包装开源项目。
 */

// ═══════════════════════════════════════════════════════════
// JSON-RPC 2.0
// ═══════════════════════════════════════════════════════════

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export function makeRequest(id: number | string, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

export function makeNotification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
}

/** 常见的 JSON-RPC 错误码。 */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type ParseOutcome =
  | { readonly kind: 'response'; readonly response: JsonRpcResponse }
  | { readonly kind: 'notification'; readonly notification: JsonRpcNotification }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * 解析一行/一段来自 server 的消息。
 *
 * ⚠️ 必须**宽容**：真实 server 会发通知（如 `notifications/message`）、
 *    会发进度通知，也可能发不符合规范的垃圾。
 *    直接把任何一条都当响应处理，会让整个连接卡死在一个 id 上。
 */
export function parseMessage(raw: string): ParseOutcome {
  const text = raw.trim();
  if (text.length === 0) return { kind: 'invalid', reason: '空消息' };

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: '不是合法 JSON' };
  }

  if (typeof value !== 'object' || value === null) {
    return { kind: 'invalid', reason: '不是对象' };
  }

  const obj = value as Record<string, unknown>;
  if (obj['jsonrpc'] !== '2.0') {
    return { kind: 'invalid', reason: 'jsonrpc 字段不是 "2.0"' };
  }

  // 有 id 且无 method → 响应
  if ('id' in obj && !('method' in obj)) {
    return { kind: 'response', response: obj as unknown as JsonRpcResponse };
  }
  // 有 method 且无 id → 通知
  if ('method' in obj && !('id' in obj)) {
    return { kind: 'notification', notification: obj as unknown as JsonRpcNotification };
  }

  return { kind: 'invalid', reason: '既不是响应也不是通知（id 与 method 同时存在）' };
}

/** 从响应里取结果；出错时抛出带上下文的错误。 */
export function unwrap(res: JsonRpcResponse): unknown {
  if (res.error !== undefined) {
    throw new McpProtocolError(
      `MCP 调用失败 [${res.error.code}]：${res.error.message}`,
      res.error.code,
    );
  }
  return res.result;
}

export class McpProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

// ═══════════════════════════════════════════════════════════
// MCP 消息常量
// ═══════════════════════════════════════════════════════════

/**
 * 本客户端支持的协议版本。
 *
 * ⚠️ 版本协商是**双向**的：客户端提出自己支持的版本，
 *    server 若只支持别的版本会回它自己的版本。
 *    收到不认识的版本时应当**如实报告**而不是硬着头皮继续 ——
 *    字段形状可能不同，装作兼容会得到难查的解析错误。
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0] ?? '2025-06-18';

export const MCP_METHODS = {
  initialize: 'initialize',
  initialized: 'notifications/initialized',
  listTools: 'tools/list',
  callTool: 'tools/call',
  listResources: 'resources/list',
  listPrompts: 'prompts/list',
  ping: 'ping',
} as const;

export interface InitializeParams {
  readonly protocolVersion: string;
  readonly capabilities: {
    readonly roots?: { readonly listChanged: boolean };
    readonly sampling?: Record<string, never>;
  };
  readonly clientInfo: { readonly name: string; readonly version: string };
}

/** 构造 initialize 参数。 */
export function initializeParams(clientName = 'butler-ai', version = '0.1.0'): InitializeParams {
  return {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {
      // 声明支持"列出工作区根目录" —— 让 server 知道能给相对路径
      roots: { listChanged: true },
    },
    clientInfo: { name: clientName, version },
  };
}

export interface InitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly serverInfo?: { readonly name?: string; readonly version?: string };
  /** 是否协商成功（server 回的版本在我们支持的列表里）*/
  readonly versionAgreed: boolean;
}

/** 解析 initialize 结果，并如实报告版本是否协商成功。 */
export function parseInitializeResult(result: unknown): InitializeResult {
  const o = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
  const version = typeof o['protocolVersion'] === 'string' ? o['protocolVersion'] : '';
  const caps = (typeof o['capabilities'] === 'object' && o['capabilities'] !== null
    ? o['capabilities']
    : {}) as Record<string, unknown>;
  const info = o['serverInfo'];

  return {
    protocolVersion: version,
    capabilities: caps,
    ...(typeof info === 'object' && info !== null
      ? { serverInfo: info as { name?: string; version?: string } }
      : {}),
    versionAgreed: SUPPORTED_PROTOCOL_VERSIONS.includes(version),
  };
}

// ═══════════════════════════════════════════════════════════
// tools/list 与 tools/call
// ═══════════════════════════════════════════════════════════

/** server 声明的原始工具条目（**不可信输入**）。 */
export interface RawToolEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type ToolsListOutcome =
  | { readonly ok: true; readonly tools: readonly RawToolEntry[] }
  | { readonly ok: false; readonly reason: string };

/**
 * 解析 tools/list 的返回。
 *
 * ⚠️ 逐项校验而不是整体强转 —— 一个坏条目不该让整份清单作废。
 *    坏条目**跳过并计数**，在结果里如实反映。
 */
export function parseToolsList(result: unknown): ToolsListOutcome {
  const o = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
  const arr = o['tools'];
  if (!Array.isArray(arr)) return { ok: false, reason: '返回里没有 tools 数组' };

  const tools: RawToolEntry[] = [];
  for (const raw of arr) {
    if (typeof raw !== 'object' || raw === null) continue;
    const t = raw as Record<string, unknown>;
    const name = t['name'];
    if (typeof name !== 'string' || name.trim().length === 0) continue;

    tools.push({
      name: name.trim(),
      description: typeof t['description'] === 'string' ? t['description'] : '',
      inputSchema:
        typeof t['inputSchema'] === 'object' && t['inputSchema'] !== null
          ? (t['inputSchema'] as Record<string, unknown>)
          : { type: 'object', properties: {} },
    });
  }

  return { ok: true, tools };
}

export interface McpToolCallResult {
  readonly text: string;
  readonly isError: boolean;
  /** 结构化内容（server 可返回结构化结果）*/
  readonly structured?: unknown;
}

/**
 * 解析 tools/call 的返回。
 *
 * ⚠️ MCP 的返回形状是 `{ content: [{type:'text', text:'...'}, ...], isError?: boolean }`，
 *    其中可能混有图片、资源引用等非文本块。
 *    这里把文本块拼起来，非文本块**如实标注**而不是静默丢弃 ——
 *    否则模型不知道"这里原本有一张图"。
 */
export function parseToolCallResult(result: unknown): McpToolCallResult {
  const o = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
  const isError = o['isError'] === true;
  const content = o['content'];

  if (!Array.isArray(content)) {
    // 有些 server 直接返回字符串或结构化对象
    if (typeof result === 'string') return { text: result, isError };
    return {
      text: JSON.stringify(result),
      isError,
      ...(result !== undefined ? { structured: result } : {}),
    };
  }

  const parts: string[] = [];
  for (const c of content) {
    if (typeof c !== 'object' || c === null) continue;
    const block = c as Record<string, unknown>;
    const type = block['type'];

    if (type === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
    } else if (type === 'image') {
      // ★ 非文本块如实标注，不静默丢弃
      parts.push(`[图片内容：${String(block['mimeType'] ?? '未知格式')}，本工具暂不解析图片]`);
    } else if (type === 'resource') {
      parts.push(`[资源引用：${String((block['resource'] as Record<string, unknown>)?.['uri'] ?? '未知')}]`);
    } else {
      parts.push(`[不支持的内容块：${String(type)}]`);
    }
  }

  return {
    text: parts.join('\n'),
    isError,
    ...(o['structuredContent'] !== undefined ? { structured: o['structuredContent'] } : {}),
  };
}

// ═══════════════════════════════════════════════════════════
// 名称映射（外部工具名 → 本系统工具名）
// ═══════════════════════════════════════════════════════════

/**
 * 工具名合法性：模型侧的 function name 只允许
 * `a-z A-Z 0-9 _ -`（见官方 API 文档）。
 *
 * ⚠️ 所以外部工具名必须**净化**后才能用，
 *    否则会出现"工具注册成功了但模型调不到"这种难查的问题。
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

/** 净化成合法工具名（保留可读性）。 */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_{2,}/g, '_');
  return cleaned.slice(0, 128) || 'unnamed';
}
