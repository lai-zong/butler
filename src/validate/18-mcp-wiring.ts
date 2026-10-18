/**
 * 验证 18：MCP 接线（B10）
 *
 * ★ 本验证要证明四件事 —— 都是"外部 MCP server 的工具**真的可用**"的前提：
 *
 *   ① **传输被登记**、server 被 add、`connect` 成功
 *   ② **工具真的进了工具框架**（`toToolSpecs` → `registerAll`），
 *      且名字带 `mcp__` 前缀（能反解出 server）
 *   ③ **工具真的能调用**（真进程、真 JSON-RPC，不是假对象）
 *   ④ **失败隔离**：连不上的 server 不拖垮别的、也不拖垮启动
 *
 * ⚠️ 改造前的事实（审计证据）：
 *   `registerTransport` / `addServer` / `connect` / `toToolSpecs` / `callTool`
 *   的**生产调用各 0 处** —— 客户端 19.9 KB 写完就没人调用过。
 *   所以本验证用**真进程**（`scripts/fake-mcp-server.mjs`），而不是 mock：
 *   mock 无法证明"跨进程 JSON-RPC 真的通"。
 */

import { EventLog } from '../core/events/log.js';
import { SystemClock } from '../adapters/clock/system.js';
import { McpClient } from '../core/mcp/client.js';
import { stdioTransportFactory } from '../adapters/mcp/stdio.js';
import { parseMcpConfig, wireMcpServers } from '../core/mcp/wiring.js';
import type { ToolSpec } from '../core/tools/types.js';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  }
}

function hr(t: string): void {
  console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);
}

async function main(): Promise<void> {
  hr('① 配置解析（用户手写配置，报错要指向条目）');
  {
    const ok = parseMcpConfig({
      servers: [{ id: 'a', name: 'A', transport: 'stdio', command: 'node' }],
    });
    check('合法配置被接受', ok.configs.length === 1 && ok.rejected.length === 0);

    const bad = parseMcpConfig({
      servers: [{ transport: 'stdio', command: 'node' }, { id: 'b', transport: 'sse' }],
    });
    check('缺 id 被拒', bad.rejected.some((r) => r.reason.includes('id')));
    check('sse 缺 url 被拒', bad.rejected.some((r) => r.reason.includes('url')));

    const leak = parseMcpConfig({
      servers: [
        { id: 'c', transport: 'stdio', command: 'node', env: { TOKEN: 'sk-abcdef1234567890' } },
      ],
    });
    check('凭证明文被拒（走既有 validateConfig）', leak.rejected.length === 1, leak.rejected[0]?.reason);
  }

  hr('② 真进程接线：连接 → 工具注册');
  const log = new EventLog('__event_log_18__');
  const clock = new SystemClock();
  const mcp = new McpClient(log, clock);
  const registered: ToolSpec[] = [];
  const tools = {
    registerAll: (specs: readonly ToolSpec[]) => {
      registered.push(...specs);
    },
  };

  const wired = await wireMcpServers({
    mcp,
    tools,
    configs: [
      {
        id: 'fake',
        name: '本地假 server',
        transport: 'stdio',
        command: process.execPath,
        args: ['scripts/fake-mcp-server.mjs'],
        enabled: true,
      } as never,
    ],
    transports: [stdioTransportFactory()],
  });

  check('连接成功', wired.connected.includes('fake'), JSON.stringify(wired.failed));
  check('注册了工具', wired.toolsRegistered > 0, `${wired.toolsRegistered} 个`);
  check(
    '工具名带 mcp__ 前缀（能反解 server）',
    (registered[0]?.name ?? '').startsWith('mcp__'),
    registered[0]?.name,
  );
  // ★ 客户端 connect() 内部落的；接线层**不重复落**（实测抓到过两条）
  check('mcp.toolsDiscovered 恰好一条（没有重复）', log.byType('mcp.toolsDiscovered').length === 1);

  hr('③ 工具真的能调用（跨进程 JSON-RPC）');
  {
    const r = await mcp.callTool({ serverId: 'fake', toolName: 'echo', toolArgs: { msg: '你好' } });
    check('调用返回 ok', r.ok, r.reason ?? '');
    check('参数真的送达对端', r.text.includes('echo:你好'), r.text);
  }

  hr('④ 失败隔离');
  {
    const log2 = new EventLog('__event_log_18b__');
    const mcp2 = new McpClient(log2, clock);
    const reg2: ToolSpec[] = [];

    // 两个 server：一个正常、一个命令不存在
    const r2 = await wireMcpServers({
      mcp: mcp2,
      tools: { registerAll: (s) => reg2.push(...s) },
      configs: [
        {
          id: 'good',
          name: '正常',
          transport: 'stdio',
          command: process.execPath,
          args: ['scripts/fake-mcp-server.mjs'],
          enabled: true,
        } as never,
        {
          id: 'broken',
          name: '坏的',
          transport: 'stdio',
          command: 'this-command-does-not-exist-12345',
          enabled: true,
        } as never,
      ],
      transports: [stdioTransportFactory()],
    });

    check('正常的那台仍然连上', r2.connected.includes('good'));
    check('坏的那台被记为失败', r2.failed.some((f) => f.id === 'broken'));
    check('失败原因非空（能给人看）', (r2.failed.find((f) => f.id === 'broken')?.reason ?? '').length > 0);
    check('没有整体抛异常', true);
    await mcp2.disconnect('good').catch(() => undefined);
  }

  await mcp.disconnect('fake').catch(() => undefined);

  hr('结果');
  console.log(`  通过 ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.log(`  ✗ 失败 ${failed} 项`);
    console.log('\n▶ 验证 18 未通过\n');
    process.exit(1);
  }
  console.log('\n▶ 验证 18 通过：MCP 接线成立（真进程 / 工具可调用 / 失败隔离）\n');
}

await main();


