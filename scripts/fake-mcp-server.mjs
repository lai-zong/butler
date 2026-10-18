/**
 * 一个最小 MCP server（stdio / JSONL），用于端到端验证。
 *
 * ⚠️ 只实现三件事：initialize、tools/list、tools/call。
 *    它**不是**生产代码，只是为了证明"接线之后工具真的能用"。
 */
const TOOLS = [
  {
    name: 'echo',
    description: '原样返回 msg 参数',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line === '') continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  const id = msg.id;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name !== 'echo') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具 ${String(name)}` } });
      return;
    }
    const msgArg = msg.params?.arguments?.msg ?? '';
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `echo:${String(msgArg)}` }] },
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现的方法' } });
  }
}
