/**
 * 一个最小的 MCP 服务器（stdio）—— 仅用于端到端验证
 *
 * 用途：证明本项目的 MCP 客户端能跟**真实的** stdio server 说上话。
 *
 * ⚠️ 这不是产品代码，是验证用的对端。
 *    写它是为了不依赖外部 npm 包（离线也能跑），
 *    而不是要发布一个 MCP server —— 本项目的定位是**客户端**（方案 § 10.1）。
 *
 * 实现的消息集（MCP 的 stdio 传输用换行分隔的 JSON-RPC）：
 *   initialize → 回协议版本与能力
 *   notifications/initialized → 无响应
 *   tools/list → 回三个工具，其中一个是危险的
 *   tools/call → 回文本结果
 *   ping → 回空
 */

import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'get_weather',
    description: '查询指定城市的天气',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
  },
  {
    name: 'list_notes',
    description: '列出所有笔记',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_note',
    description: '删除一条笔记',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
];

/** 记一下收到的调用，便于断言。 */
const callLog = [];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  // 通知（无 id）不需要响应
  if (id === undefined) {
    if (method === 'notifications/initialized') {
      // 顺便往 stderr 打一行日志 —— 验证客户端不会把 stderr 当错误
      process.stderr.write('[minimal-mcp] 握手完成\n');
    }
    return;
  }

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'minimal-mcp-verify', version: '0.0.1' },
      });
      return;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = String(params?.['name'] ?? '');
      const args = params?.['arguments'] ?? {};
      callLog.push({ name, args });

      if (name === 'get_weather') {
        const city = String(args?.['city'] ?? '未知');
        reply(id, {
          content: [{ type: 'text', text: `${city}：晴，25°C，湿度 40%` }],
        });
        return;
      }
      if (name === 'list_notes') {
        reply(id, {
          content: [
            { type: 'text', text: '共 2 条笔记' },
            // 故意返回一个非文本块 —— 验证客户端会如实标注而不是静默丢弃
            { type: 'image', mimeType: 'image/png' },
          ],
        });
        return;
      }
      if (name === 'delete_note') {
        reply(id, {
          isError: true,
          content: [{ type: 'text', text: '拒绝：本验证服务器不真的删除任何东西' }],
        });
        return;
      }
      replyError(id, -32602, `未知工具：${name}`);
      return;
    }

    case 'ping':
      reply(id, {});
      return;

    default:
      replyError(id, -32601, `未实现的方法：${String(method)}`);
  }
});
