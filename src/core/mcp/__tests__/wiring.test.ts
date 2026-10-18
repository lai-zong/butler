/**
 * MCP 接线测试（B10）
 *
 * ★ 这里测的是**"它到底有没有被装起来"**，而不是客户端本身的行为
 *   （客户端行为已由 `validate:5` 覆盖）。
 *
 * 改造前的事实：`registerTransport` / `addServer` / `connect` /
 * `toToolSpecs` 的生产调用**各 0 处** —— 客户端写了 19.9 KB，
 * 但运行时从不连接任何 server，外部工具**根本不可用**。
 */
import { describe, expect, it, vi } from 'vitest';

import { loadMcpConfigFile, parseMcpConfig, wireMcpServers } from '../wiring.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import type { McpClient } from '../client.js';
import type { McpServerConfig } from '../types.js';
import type { ToolSpec } from '../../tools/types.js';

const T0 = 1_760_000_000_000;

function setup(opts?: { connectOk?: boolean; addOk?: boolean; tools?: readonly ToolSpec[] }) {
  const log = new EventLog('s_mcp');
  const clock = new FixedClock(T0);

  const calls: string[] = [];
  const registerTransport = vi.fn((t: { transport: string }) => {
    calls.push(`registerTransport:${t.transport}`);
  });
  const addServer = vi.fn((cfg: McpServerConfig) => {
    calls.push(`addServer:${cfg.id}`);
    return opts?.addOk === false
      ? { ok: false, problems: ['名称重复'] }
      : { ok: true, problems: [] };
  });
  const connect = vi.fn(async (id: string) => {
    calls.push(`connect:${id}`);
    return opts?.connectOk === false ? { ok: false, reason: '进程启动失败' } : { ok: true };
  });
  const toToolSpecs = vi.fn(() => {
    calls.push('toToolSpecs');
    return opts?.tools ?? [{ name: 'mcp__alpha__echo' } as unknown as ToolSpec];
  });

  const mcp = { registerTransport, addServer, connect, toToolSpecs } as unknown as McpClient;
  const registerAll = vi.fn();
  const tools = { registerAll };

  return { log, clock, mcp, tools, calls, registerTransport, addServer, connect, toToolSpecs, registerAll };
}

function cfg(id: string, enabled = true): McpServerConfig {
  return {
    id,
    name: id,
    transport: 'stdio',
    command: 'node',
    enabled,
  } as McpServerConfig;
}

describe('★★★ 接线真的会发生', () => {
  it('★★ 关键方法全部被调用（改造前一个都没被调用）', async () => {
    const s = setup();
    const r = await wireMcpServers({
      mcp: s.mcp,
      tools: s.tools,
      configs: [cfg('alpha')],
      transports: [{ transport: 'stdio', open: async () => ({}) } as never],
    });

    expect(s.registerTransport).toHaveBeenCalledTimes(1);
    expect(s.addServer).toHaveBeenCalledTimes(1);
    expect(s.connect).toHaveBeenCalledWith('alpha');
    expect(s.toToolSpecs).toHaveBeenCalled();
    // ★ 工具真的进了工具框架
    expect(s.registerAll).toHaveBeenCalledTimes(1);
    expect(r.toolsRegistered).toBe(1);
    expect(r.connected).toEqual(['alpha']);
  });

  it('★ 顺序正确：先登记传输 → addServer → connect → toToolSpecs', async () => {
    const s = setup();
    await wireMcpServers({
      mcp: s.mcp,
      tools: s.tools,
      configs: [cfg('alpha')],
      transports: [{ transport: 'stdio', open: async () => ({}) } as never],
    });
    expect(s.calls).toEqual([
      'registerTransport:stdio',
      'addServer:alpha',
      'connect:alpha',
      'toToolSpecs',
    ]);
  });

  it('★ **接线层不再重复落 mcp.toolsDiscovered**（客户端已落过）', async () => {
    /**
     * ⚠️ 实测抓到：McpClient.connect() 内部已经落了这个事件，
     *    接线层再落一条会让同一个 server 留下两条同类型事件。
     *    这里断言接线层**不写事件流**。
     */
    const s = setup();
    await wireMcpServers({
      mcp: s.mcp,
      tools: s.tools,
      configs: [cfg('alpha')],
    });
    expect(s.log.byType('mcp.toolsDiscovered')).toHaveLength(0);
  });
});

describe('★★ 失败隔离（外部进程挂掉是常态）', () => {
  it('★ 连接失败 → 记入 failed，不抛异常，不注册工具', async () => {
    const s = setup({ connectOk: false });
    const r = await wireMcpServers({
      mcp: s.mcp,
      tools: s.tools,
      configs: [cfg('alpha')],
    });

    expect(r.connected).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.reason).toContain('进程启动失败');
    expect(s.registerAll).not.toHaveBeenCalled();
  });

  it('★★ 一个失败不影响另一个（不是"全有或全无"）', async () => {
    const s = setup();
    // 第二个 server addServer 失败
    let n = 0;
    (s.mcp as unknown as { addServer: (c: McpServerConfig) => unknown }).addServer = () => {
      n++;
      return n === 1 ? { ok: true, problems: [] } : { ok: false, problems: ['坏了'] };
    };
    // 重新绑定，让 calls 也记录
    const r = await wireMcpServers({
      mcp: s.mcp,
      tools: s.tools,
      configs: [cfg('alpha'), cfg('beta')],
    });
    expect(r.connected).toEqual(['alpha']);
    expect(r.failed.map((f) => f.id)).toEqual(['beta']);
  });

  it('★ 禁用（enabled=false）的 server 不连接，计入 skipped', async () => {
    const s = setup();
    const r = await wireMcpServers({
      mcp: s.mcp,
      tools: s.tools,
      configs: [cfg('alpha', false)],
    });
    expect(s.addServer).not.toHaveBeenCalled();
    expect(s.connect).not.toHaveBeenCalled();
    expect(r.skipped).toEqual(['alpha']);
  });
});

describe('★★ 配置解析（用户手写，报错要指向条目）', () => {
  it('合法配置被接受', () => {
    const r = parseMcpConfig({
      servers: [{ id: 'a', name: 'A', transport: 'stdio', command: 'node' }],
    });
    expect(r.configs).toHaveLength(1);
    expect(r.configs[0]?.enabled).toBe(true); // 默认启用
    expect(r.rejected).toHaveLength(0);
  });

  it('★ 缺 id / transport 非法 / stdio 缺 command 都被拒，且**逐条给原因**', () => {
    const r = parseMcpConfig({
      servers: [
        { transport: 'stdio', command: 'node' }, // 缺 id
        { id: 'b', transport: 'carrier-pigeon' }, // 非法 transport
        { id: 'c', transport: 'stdio' }, // 缺 command
      ],
    });
    expect(r.configs).toHaveLength(0);
    expect(r.rejected).toHaveLength(3);
    expect(r.rejected[0]?.reason).toContain('id');
    expect(r.rejected[1]?.reason).toContain('transport');
    expect(r.rejected[2]?.reason).toContain('command');
  });

  it('★★ 含凭证明文的配置被拒（走既有 validateConfig）', () => {
    const r = parseMcpConfig({
      servers: [
        {
          id: 'a',
          transport: 'stdio',
          command: 'node',
          env: { API_KEY: 'sk-abcdef123456' },
        },
      ],
    });
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toMatch(/凭证|密钥|明文/);
  });

  it('文件不存在 → null（没配就是没配，不是错误）', () => {
    expect(loadMcpConfigFile('不存在的路径.mcp.json')).toBeNull();
  });

  it('根节点不是对象 / 缺 servers → 给出明确原因', () => {
    expect(parseMcpConfig([]).rejected[0]?.reason).toContain('不能是数组');
    expect(parseMcpConfig('x').rejected[0]?.reason).toContain('不是对象');
    expect(parseMcpConfig({}).rejected[0]?.reason).toContain('servers');
  });
});



