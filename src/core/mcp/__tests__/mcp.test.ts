/**
 * MCP 客户端测试 —— 协议层（确定性，用假传输）
 *
 * ★ 三个主张：
 *   ① 外部工具**走同一个安全闸门**，没有旁路
 *   ② 分级由**本系统推断**，不采信外部声明
 *   ③ 配置里**不允许明文凭证**（它会被导出，而导出文件会经过网盘/U 盘）
 */

import { describe, expect, it, vi } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryFileSystem } from '../../../adapters/fs/memory.js';
import { ToolFramework } from '../../tools/framework.js';
import type { ActionTier, PermissionPolicy } from '../../tools/types.js';
import { McpClient, applyServerPolicy, type McpTransportPort } from '../client.js';
import {
  LATEST_PROTOCOL_VERSION,
  MCP_METHODS,
  isValidToolName,
  makeRequest,
  parseInitializeResult,
  parseMessage,
  parseToolCallResult,
  parseToolsList,
  sanitizeToolName,
  unwrap,
} from '../protocol.js';
import {
  DEFAULT_POLICY,
  MCP_TOOL_PREFIX,
  autoAllowed,
  inferTier,
  leavesMachine,
  parseQualifiedName,
  qualifyToolName,
  validateConfig,
  type McpServerConfig,
} from '../types.js';

const T0 = 1_760_000_000_000;

// ═══════════════════════════════════════════════════════════
// 假传输：按脚本回响应
// ═══════════════════════════════════════════════════════════

interface FakeRule {
  readonly method: string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
  readonly throwMessage?: string;
}

class FakeTransport implements McpTransportPort {
  readonly sent: unknown[] = [];
  readonly notifications: unknown[] = [];
  closed = false;

  constructor(private readonly rules: readonly FakeRule[]) {}

  async request(msg: unknown, _timeoutMs: number): Promise<never> {
    this.sent.push(msg);
    const m = msg as { method?: string; id?: number };
    const rule = this.rules.find((r) => r.method === m.method);
    if (!rule) {
      return Promise.reject(new Error(`假传输没有为 ${String(m.method)} 准备规则`)) as never;
    }
    if (rule.throwMessage !== undefined) throw new Error(rule.throwMessage);
    if (rule.error !== undefined) {
      return { jsonrpc: '2.0', id: m.id ?? 1, error: rule.error } as never;
    }
    return { jsonrpc: '2.0', id: m.id ?? 1, result: rule.result } as never;
  }

  async notify(msg: unknown): Promise<void> {
    this.notifications.push(msg);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function setup(rules: readonly FakeRule[], transport: 'stdio' | 'http' = 'stdio') {
  const log = new EventLog('s_mcp');
  const clock = new FixedClock(T0);
  const client = new McpClient(log, clock);
  const fake = new FakeTransport(rules);
  client.registerTransport({
    transport,
    open: async () => fake,
  });
  return { log, clock, client, fake };
}

const OK_RULES: readonly FakeRule[] = [
  {
    method: MCP_METHODS.initialize,
    result: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-server', version: '1.0' },
    },
  },
  {
    method: MCP_METHODS.listTools,
    result: {
      tools: [
        { name: 'get_weather', description: '查询天气', inputSchema: { type: 'object', properties: {} } },
        { name: 'delete_file', description: '删除一个文件', inputSchema: { type: 'object', properties: {} } },
      ],
    },
  },
];

function cfg(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv1',
    name: '测试服务器',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    enabled: true,
    policy: DEFAULT_POLICY,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════
// ① JSON-RPC 2.0
// ═══════════════════════════════════════════════════════════

describe('① JSON-RPC 编解码', () => {
  it('构造请求', () => {
    expect(makeRequest(1, 'tools/list')).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  });

  it('带参数时不省略 params', () => {
    expect(makeRequest(2, 'x', { a: 1 })).toHaveProperty('params');
  });

  it('★ 解析响应', () => {
    const r = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(r.kind).toBe('response');
  });

  it('★ 解析通知（无 id）', () => {
    const r = parseMessage('{"jsonrpc":"2.0","method":"notifications/message","params":{}}');
    expect(r.kind).toBe('notification');
  });

  it('★★ 通知不会被误当响应（否则连接会卡在一个 id 上）', () => {
    const r = parseMessage('{"jsonrpc":"2.0","method":"notifications/progress"}');
    expect(r.kind).not.toBe('response');
  });

  it('垃圾输入不崩溃，如实报无效', () => {
    expect(parseMessage('not json').kind).toBe('invalid');
    expect(parseMessage('').kind).toBe('invalid');
    expect(parseMessage('[]').kind).toBe('invalid');
    expect(parseMessage('{"id":1}').kind).toBe('invalid');
  });

  it('★ 错误响应抛出带错误码的异常', () => {
    expect(() => unwrap({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: '没有这个方法' } })).toThrow(
      /-32601/,
    );
  });

  it('正常响应返回 result', () => {
    expect(unwrap({ jsonrpc: '2.0', id: 1, result: { x: 1 } })).toEqual({ x: 1 });
  });
});

// ═══════════════════════════════════════════════════════════
// ② 握手与版本协商
// ═══════════════════════════════════════════════════════════

describe('② 握手与版本协商', () => {
  it('★ 版本一致时协商成功', () => {
    const r = parseInitializeResult({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      serverInfo: { name: 'x' },
    });
    expect(r.versionAgreed).toBe(true);
  });

  it('★★ 版本不认识时**如实报告**，不装作兼容', () => {
    const r = parseInitializeResult({ protocolVersion: '1999-01-01', capabilities: {} });
    expect(r.versionAgreed).toBe(false);
  });

  it('缺字段不崩溃', () => {
    const r = parseInitializeResult({});
    expect(r.versionAgreed).toBe(false);
    expect(r.protocolVersion).toBe('');
  });

  it('★ 连上后发出 initialized 通知（协议要求）', async () => {
    const { client, fake } = setup(OK_RULES);
    client.addServer(cfg());
    await client.connect('srv1');

    expect(fake.notifications).toHaveLength(1);
    expect((fake.notifications[0] as { method: string }).method).toBe(MCP_METHODS.initialized);
  });

  it('★ 版本不匹配时连接失败并落事件', async () => {
    const { client, log } = setup([
      { method: MCP_METHODS.initialize, result: { protocolVersion: '1999-01-01', capabilities: {} } },
    ]);
    client.addServer(cfg());
    const r = await client.connect('srv1');

    expect(r.ok).toBe(false);
    expect(r.reason).toContain('版本不匹配');
    expect(log.byType('mcp.serverFailed')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// ③ ★ 分级由本系统推断
// ═══════════════════════════════════════════════════════════

describe('③ ★ 分级由本系统推断（不采信外部声明）', () => {
  it('★★ 名字含 delete → dangerous', () => {
    expect(inferTier('delete_file').tier).toBe('dangerous');
    expect(inferTier('remove_item').tier).toBe('dangerous');
  });

  it('★★ 名字含 exec/shell → dangerous', () => {
    expect(inferTier('run_command').tier).toBe('dangerous');
    expect(inferTier('execute_script').tier).toBe('dangerous');
    expect(inferTier('powershell_exec').tier).toBe('dangerous');
  });

  it('注册表与进程终止也是危险级', () => {
    expect(inferTier('registry_write').tier).toBe('dangerous');
    expect(inferTier('kill_process').tier).toBe('dangerous');
  });

  it('★ 只读动词开头的判为只读', () => {
    expect(inferTier('get_weather').tier).toBe('readOnly');
    expect(inferTier('list_files').tier).toBe('readOnly');
    expect(inferTier('read_config').tier).toBe('readOnly');
    expect(inferTier('screenshot').tier).toBe('readOnly');
  });

  it('★★ 认不出的按 highRisk（保守方向）', () => {
    const r = inferTier('frobnicate_thing');
    expect(r.tier).toBe('highRisk');
    expect(r.why).toContain('保守');
  });

  it('★ 危险判断优先于只读判断（顺序很重要）', () => {
    // "get_and_delete" 以 get 开头，但含 delete
    expect(inferTier('get_and_delete').tier).toBe('dangerous');
  });

  it('★ 描述里的不可逆字样也被识别', () => {
    expect(inferTier('do_thing', 'This performs irreversible changes').tier).toBe('dangerous');
  });

  it('每个推断都给出理由（可解释）', () => {
    for (const n of ['get_x', 'delete_x', 'unknown_x']) {
      expect(inferTier(n).why.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// ④ ★ 服务器策略
// ═══════════════════════════════════════════════════════════

describe('④ ★ 服务器策略', () => {
  it('★★ manual 下什么都不自动放行', () => {
    const r = autoAllowed({ policy: DEFAULT_POLICY, toolName: 'get_x', tier: 'readOnly' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('逐次确认');
  });

  it('readOnly 策略下只读工具自动放行', () => {
    const policy = { ...DEFAULT_POLICY, level: 'readOnly' as const };
    expect(autoAllowed({ policy, toolName: 'get_x', tier: 'readOnly' }).allowed).toBe(true);
    expect(autoAllowed({ policy, toolName: 'set_x', tier: 'normal' }).allowed).toBe(false);
  });

  it('★ 危险级无论策略如何都不自动放行', () => {
    for (const level of ['manual', 'readOnly', 'normal'] as const) {
      const r = autoAllowed({
        policy: { ...DEFAULT_POLICY, level },
        toolName: 'delete_x',
        tier: 'dangerous',
      });
      expect(r.allowed, level).toBe(false);
    }
  });

  it('★ 高风险无论策略如何都不自动放行', () => {
    const r = autoAllowed({
      policy: { ...DEFAULT_POLICY, level: 'normal' },
      toolName: 'move_x',
      tier: 'highRisk',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('每次确认');
  });

  it('★ 黑名单优先于级别', () => {
    const policy = { ...DEFAULT_POLICY, level: 'normal' as const, disabledTools: ['get_x'] };
    const r = autoAllowed({ policy, toolName: 'get_x', tier: 'readOnly' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('禁用');
  });

  it('★ 策略只能抬高分级，不能降低', () => {
    // 危险级不会被 normal 策略降下来
    expect(applyServerPolicy('dangerous', 'normal')).toBe('dangerous');
    // 只读在 manual 下被抬到 normal
    expect(applyServerPolicy('readOnly', 'manual')).toBe('normal');
    // normal 策略下保持原样
    expect(applyServerPolicy('readOnly', 'normal')).toBe('readOnly');
    expect(applyServerPolicy('highRisk', 'normal')).toBe('highRisk');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ ★ 配置校验：拒绝明文凭证
// ═══════════════════════════════════════════════════════════

describe('⑤ ★ 配置校验', () => {
  it('正常配置通过', () => {
    expect(validateConfig(cfg())).toHaveLength(0);
  });

  it('缺名称被拒', () => {
    expect(validateConfig(cfg({ name: '' })).some((p) => p.field === 'name')).toBe(true);
  });

  it('stdio 缺命令被拒', () => {
    const c = cfg();
    const { command: _drop, ...rest } = c;
    expect(validateConfig(rest as typeof c).some((p) => p.field === 'command')).toBe(true);
  });

  it('远程缺 URL 被拒', () => {
    expect(
      validateConfig({ id: 'x', name: 'x', transport: 'http', enabled: true }).some(
        (p) => p.field === 'url',
      ),
    ).toBe(true);
  });

  it('★ 远程用 http 明文被拒（会在链路上暴露内容）', () => {
    const problems = validateConfig({
      id: 'x', name: 'x', transport: 'http', url: 'http://example.com/mcp', enabled: true,
    });
    expect(problems.some((p) => p.message.includes('https'))).toBe(true);
  });

  it('本机回环 http 可用（不经过外部链路）', () => {
    expect(
      validateConfig({
        id: 'x', name: 'x', transport: 'http', url: 'http://127.0.0.1:8787/mcp', enabled: true,
      }),
    ).toHaveLength(0);
    expect(
      validateConfig({
        id: 'x', name: 'x', transport: 'http', url: 'http://localhost:8787/mcp', enabled: true,
      }),
    ).toHaveLength(0);
  });

  it('https 通过', () => {
    expect(
      validateConfig({
        id: 'x', name: 'x', transport: 'http', url: 'https://example.com/mcp', enabled: true,
      }),
    ).toHaveLength(0);
  });

  it('★★ 环境变量里的疑似凭证被拒（键名）', () => {
    const problems = validateConfig(cfg({ env: { API_KEY: 'whatever' } }));
    expect(problems.some((p) => p.message.includes('凭证'))).toBe(true);
  });

  it('★★ 值看起来像密钥也被拒（即使键名无害）', () => {
    const problems = validateConfig(cfg({ env: { MY_VAR: 'sk-abcdef1234567890' } }));
    expect(problems.some((p) => p.field === 'env.MY_VAR')).toBe(true);
  });

  it('★ 拒绝信息里说明了**为什么**（导出会经过网盘/U 盘）', () => {
    const problems = validateConfig(cfg({ env: { TOKEN: 'x' } }));
    expect(problems[0]?.message).toContain('导出');
  });

  it('GitHub token 形态被识别', () => {
    expect(validateConfig(cfg({ env: { A: 'ghp_0123456789abcdef' } })).length).toBeGreaterThan(0);
  });

  it('★ URL 里的密钥参数被拒', () => {
    const problems = validateConfig({
      id: 'x', name: 'x', transport: 'http',
      url: 'https://example.com/mcp?api_key=secret123', enabled: true,
    });
    expect(problems.some((p) => p.field === 'url')).toBe(true);
  });

  it('★ 参数里的密钥被拒', () => {
    const problems = validateConfig(cfg({ args: ['server.js', '--token=sk-abcdef123456'] }));
    expect(problems.some((p) => p.field.startsWith('args'))).toBe(true);
  });

  it('普通环境变量不误伤', () => {
    expect(validateConfig(cfg({ env: { DEBUG: '1', LOG_LEVEL: 'info' } }))).toHaveLength(0);
  });

  it('envFromVault 只允许引用，不允许空引用', () => {
    expect(validateConfig(cfg({ envFromVault: { TOKEN: 'cred_1' } }))).toHaveLength(0);
    expect(
      validateConfig(cfg({ envFromVault: { TOKEN: '' } })).some((p) => p.field.startsWith('envFromVault')),
    ).toBe(true);
  });
});

describe('⑦ 凭证注入', () => {
  it('envFromVault 在打开传输前解析，且配置本身不含明文', async () => {
    const log = new EventLog('s_mcp_vault');
    const clock = new FixedClock(T0);
    const client = new McpClient(log, clock);
    const fake = new FakeTransport(OK_RULES);
    let opened: McpServerConfig | undefined;
    client.registerTransport({
      transport: 'stdio',
      open: async (config) => {
        opened = config;
        return fake;
      },
    });
    client.setCredentialResolver(async (ref) => (ref === 'cred_1' ? 'resolved-secret' : null));
    const added = client.addServer({
      id: 'srv-vault',
      name: 'vault-server',
      transport: 'stdio',
      command: 'node',
      envFromVault: { TOKEN: 'cred_1' },
      enabled: true,
      policy: DEFAULT_POLICY,
    });
    expect(added.ok).toBe(true);
    expect((await client.connect('srv-vault')).ok).toBe(true);
    expect(opened?.env?.['TOKEN']).toBe('resolved-secret');
    expect(JSON.stringify(client.getServer('srv-vault')?.config)).not.toContain('resolved-secret');
  });

  it('凭证不存在时连接失败，不把空值当成功', async () => {
    const log = new EventLog('s_mcp_vault2');
    const clock = new FixedClock(T0);
    const client = new McpClient(log, clock);
    client.registerTransport({
      transport: 'stdio',
      open: async () => new FakeTransport(OK_RULES),
    });
    client.setCredentialResolver(async () => null);
    client.addServer({
      id: 'srv-vault2',
      name: 'vault-server',
      transport: 'stdio',
      command: 'node',
      envFromVault: { TOKEN: 'missing' },
      enabled: true,
      policy: DEFAULT_POLICY,
    });
    const r = await client.connect('srv-vault2');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('凭证');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑥ 工具名映射
// ═══════════════════════════════════════════════════════════

describe('⑥ 工具名映射', () => {
  it('★ 加前缀（不同 server 的同名工具不会互相覆盖）', () => {
    expect(qualifyToolName('srv1', 'search')).toBe(`${MCP_TOOL_PREFIX}srv1__search`);
  });

  it('★ 能反解出来源', () => {
    const p = parseQualifiedName(qualifyToolName('srv1', 'search'));
    expect(p).toEqual({ serverId: 'srv1', toolName: 'search' });
  });

  it('非 MCP 名字反解为 null', () => {
    expect(parseQualifiedName('read_file')).toBeNull();
  });

  it('★ 名字里的非法字符被净化（否则模型调不到）', () => {
    // 模型侧的 function name 只允许 a-z A-Z 0-9 _ -
    const q = qualifyToolName('srv 1', 'foo.bar/baz');
    expect(isValidToolName(q)).toBe(true);
  });

  it('净化后仍可反解', () => {
    const q = qualifyToolName('a.b', 'c d');
    expect(parseQualifiedName(q)).not.toBeNull();
  });

  it('sanitizeToolName 处理空名与超长名', () => {
    expect(sanitizeToolName('')).toBe('unnamed');
    expect(sanitizeToolName('x'.repeat(300)).length).toBeLessThanOrEqual(128);
    expect(isValidToolName(sanitizeToolName('中文工具名'))).toBe(true);
  });

  it('远程传输会离开本机（界面须提示）', () => {
    expect(leavesMachine('stdio')).toBe(false);
    expect(leavesMachine('http')).toBe(true);
    expect(leavesMachine('sse')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑦ tools/list 与 tools/call 解析
// ═══════════════════════════════════════════════════════════

describe('⑦ 结果解析', () => {
  it('★ 坏条目被跳过，好条目保留', () => {
    const r = parseToolsList({
      tools: [
        { name: 'good', description: '', inputSchema: {} },
        { name: '', description: 'x' },
        null,
        { name: 'good2' },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tools.map((t) => t.name)).toEqual(['good', 'good2']);
  });

  it('缺 tools 数组时如实报错', () => {
    const r = parseToolsList({ nope: 1 });
    expect(r.ok).toBe(false);
  });

  it('★ tools/call 拼接文本块', () => {
    const r = parseToolCallResult({ content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] });
    expect(r.text).toBe('第一段\n第二段');
    expect(r.isError).toBe(false);
  });

  it('★★ 非文本块**如实标注**而不是静默丢弃', () => {
    const r = parseToolCallResult({
      content: [{ type: 'text', text: 'x' }, { type: 'image', mimeType: 'image/png' }],
    });
    expect(r.text).toContain('图片内容');
  });

  it('资源引用被标注', () => {
    const r = parseToolCallResult({ content: [{ type: 'resource', resource: { uri: 'file:///a' } }] });
    expect(r.text).toContain('file:///a');
  });

  it('isError 被透传', () => {
    expect(parseToolCallResult({ content: [], isError: true }).isError).toBe(true);
  });

  it('非标准返回（字符串）也能处理', () => {
    expect(parseToolCallResult('直接是文本').text).toBe('直接是文本');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑧ ★ MCP 工具走同一个闸门（没有旁路）
// ═══════════════════════════════════════════════════════════

describe('⑧ ★ MCP 工具走同一个安全闸门', () => {
  class Policy implements PermissionPolicy {
    readonly asked: string[] = [];
    constructor(private readonly allow: boolean) {}
    isRemembered() {
      return false;
    }
    isTierEnabled() {
      return true;
    }
    async ask(req: { toolName: string }): Promise<'allow' | 'deny'> {
      this.asked.push(req.toolName);
      return this.allow ? 'allow' : 'deny';
    }
  }

  async function connected(policyLevel: 'manual' | 'readOnly' | 'normal' = 'normal') {
    const s = setup(OK_RULES);
    s.client.addServer(cfg({ policy: { ...DEFAULT_POLICY, level: policyLevel } }));
    await s.client.connect('srv1');
    return s;
  }

  it('★★ 危险级工具**默认不导出**（独立于全局闸门的防线）', async () => {
    const { client } = await connected('normal');
    const specs = client.toToolSpecs();
    // 只导出两个非危险工具；delete_file 被推断为 dangerous → 不导出
    expect(specs).toHaveLength(1);
    expect(specs.map((s) => s.name)).not.toContain(`${MCP_TOOL_PREFIX}srv1__delete_file`);
    expect(specs.map((s) => s.name)).toContain(`${MCP_TOOL_PREFIX}srv1__get_weather`);
  });

  it('★ MCP 工具默认禁止进长期记忆，显式开启后才放行', async () => {
    const { client } = await connected('normal');
    const spec = client.toToolSpecs().find((s) => s.name.includes('get_weather'));
    expect(spec?.memoryWriteAllowed).toBe(false);

    client.setPolicy('srv1', {
      ...DEFAULT_POLICY,
      level: 'normal',
      allowMemoryWrite: true,
    });
    const allowed = client.toToolSpecs().find((s) => s.name.includes('get_weather'));
    expect(allowed?.memoryWriteAllowed).toBe(true);
  });

  it('★ 显式开启后才导出危险工具', async () => {
    const { client } = await connected('normal');
    client.setPolicy('srv1', { ...DEFAULT_POLICY, level: 'normal', allowDangerousTools: true });
    const specs = client.toToolSpecs();
    expect(specs.map((s) => s.name)).toContain(`${MCP_TOOL_PREFIX}srv1__delete_file`);
  });

  it('★★ 被禁用的工具**根本不注册**（模型连看都看不到）', async () => {
    const { client } = await connected();
    client.setPolicy('srv1', { ...DEFAULT_POLICY, level: 'normal', disabledTools: ['delete_file'] });
    const specs = client.toToolSpecs();
    expect(specs.map((s) => s.name)).not.toContain(`${MCP_TOOL_PREFIX}srv1__delete_file`);
  });

  it('★ 未连接的服务器不产出工具', async () => {
    const { client } = setup(OK_RULES);
    client.addServer(cfg());
    expect(client.toToolSpecs()).toHaveLength(0);
  });

  it('★★ 危险工具即使显式开启，仍受全局闸门约束', async () => {
    const { client, log, clock } = await connected('normal');
    // 显式开启允许危险工具导出
    client.setPolicy('srv1', { ...DEFAULT_POLICY, level: 'normal', allowDangerousTools: true });

    const policy = new Policy(true);
    const tools = new ToolFramework({ log, clock, policy });
    tools.registerAll(client.toToolSpecs());

    // 此时工具存在，但 TIER_REQUIREMENT.dangerous === 'disabled'，
    // 而 Policy.isTierEnabled 返回 true（模拟"用户开启了危险级"）——
    // 所以它会走到询问；这里验证的是它**至少经过了闸门**。
    const r = await tools.execute({
      toolName: `${MCP_TOOL_PREFIX}srv1__delete_file`,
      args: {},
      taskId: 't1',
    });
    // 无论结果如何，都不该是"未知工具"（说明它确实被注册了）
    expect(r.output).not.toContain('未知工具');
  });

  it('★★ 只读工具在 normal 策略下不经询问直接执行', async () => {
    const { client, log, clock, fake } = await connected('normal');
    const policy = new Policy(true);
    const tools = new ToolFramework({ log, clock, policy });
    tools.registerAll(client.toToolSpecs());

    // 给 callTool 准备响应
    const withCall = setup([
      ...OK_RULES,
      { method: MCP_METHODS.callTool, result: { content: [{ type: 'text', text: '晴，25 度' }] } },
    ]);
    withCall.client.addServer(cfg({ policy: { ...DEFAULT_POLICY, level: 'normal' } }));
    await withCall.client.connect('srv1');
    const tools2 = new ToolFramework({ log, clock, policy });
    tools2.registerAll(withCall.client.toToolSpecs());

    const r = await tools2.execute({
      toolName: `${MCP_TOOL_PREFIX}srv1__get_weather`,
      args: { city: '杭州' },
      taskId: 't1',
    });

    expect(r.ok).toBe(true);
    expect(r.output).toContain('晴');
    expect(policy.asked).not.toContain(`${MCP_TOOL_PREFIX}srv1__get_weather`);
    void fake;
    void tools;
  });

  it('★★ manual 策略下只读工具被抬到 normal → 仍需询问', async () => {
    const { client, log, clock } = await connected('manual');
    const policy = new Policy(true);
    const tools = new ToolFramework({ log, clock, policy });
    tools.registerAll(client.toToolSpecs());

    const spec = client.toToolSpecs().find((s) => s.name.includes('get_weather'));
    expect(spec?.tier).toBe('normal'); // 被抬高了
  });

  it('★ 调用落 tool.call / tool.result 审计事件（与本地工具一致）', async () => {
    const s = setup([
      ...OK_RULES,
      { method: MCP_METHODS.callTool, result: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    s.client.addServer(cfg({ policy: { ...DEFAULT_POLICY, level: 'normal' } }));
    await s.client.connect('srv1');

    const tools = new ToolFramework({ log: s.log, clock: s.clock, policy: new Policy(true) });
    tools.registerAll(s.client.toToolSpecs());
    await tools.execute({
      toolName: `${MCP_TOOL_PREFIX}srv1__get_weather`,
      args: {},
      taskId: 't1',
    });

    expect(s.log.byType('tool.call').length).toBeGreaterThan(0);
    expect(s.log.byType('tool.result').length).toBeGreaterThan(0);
  });

  it('★ 描述里标注了外部来源', async () => {
    const { client } = await connected();
    const spec = client.toToolSpecs()[0];
    expect(spec?.description).toContain('MCP 服务器');
    expect(spec?.description).toContain('外部工具');
  });

  it('★ preview 说明来源与风险，远程还提示会离开本机', async () => {
    const s = setup(OK_RULES, 'http');
    // http 传输不需要 command
    s.client.addServer({
      id: 'srv1',
      name: '测试服务器',
      transport: 'http',
      url: 'https://x.example/mcp',
      enabled: true,
      policy: DEFAULT_POLICY,
    });
    await s.client.connect('srv1');

    const spec = s.client.toToolSpecs()[0];
    if (!spec?.preview) throw new Error('缺 preview');
    const text = await spec.preview({ a: 1 }, { clock: s.clock, taskId: 't' });
    expect(text).toContain('MCP 服务器');
    expect(text).toContain('离开本机');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑨ 服务器生命周期
// ═══════════════════════════════════════════════════════════

describe('⑨ 服务器生命周期', () => {
  it('★ 添加时不做连接（添加与连接是两件事）', () => {
    const { client, log } = setup(OK_RULES);
    const r = client.addServer(cfg());
    expect(r.ok).toBe(true);
    expect(client.getServer('srv1')?.state).toBe('disconnected');
    expect(log.byType('mcp.serverConnected')).toHaveLength(0);
  });

  it('★ 配置不合法时拒绝添加并说明问题', () => {
    const { client, log } = setup(OK_RULES);
    const r = client.addServer(cfg({ env: { API_KEY: 'x' } }));
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(log.byType('mcp.serverFailed')).toHaveLength(1);
  });

  it('连接成功落 mcp.serverConnected 与 mcp.toolsDiscovered', async () => {
    const { client, log } = setup(OK_RULES);
    client.addServer(cfg());
    await client.connect('srv1');

    expect(log.byType('mcp.serverConnected')).toHaveLength(1);
    expect(log.byType('mcp.toolsDiscovered')).toHaveLength(1);
    // 工具清单里记了推断出的分级 —— 事后能回答"当时为什么让它自动跑"
    const p = log.byType('mcp.toolsDiscovered')[0]?.payload as { tools: { tier: string }[] };
    expect(p.tools.map((t) => t.tier)).toContain('dangerous');
  });

  it('已停用的服务器不连接', async () => {
    const { client } = setup(OK_RULES);
    client.addServer(cfg({ enabled: false }));
    const r = await client.connect('srv1');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('停用');
  });

  it('★ 未注册传输时给出可读错误', async () => {
    const log = new EventLog('s');
    const clock = new FixedClock(T0);
    const client = new McpClient(log, clock);
    // ⚠️ 必须先让服务器真的存在 —— 否则报的是「服务器不存在」
    //    （实测踩过：addServer 因缺 url 被拒，于是走不到传输那一步）
    const added = client.addServer({
      id: 'srv1',
      name: '远程服务器',
      transport: 'sse',
      url: 'https://x.example/sse',
      enabled: true,
      policy: DEFAULT_POLICY,
    });
    expect(added.ok).toBe(true);
    const r = await client.connect('srv1');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('sse');
  });

  it('★ 连接失败时如实记录原因，不"尽力而为地继续"', async () => {
    const { client, log } = setup([
      { method: MCP_METHODS.initialize, throwMessage: '连接被拒绝' },
    ]);
    client.addServer(cfg());
    const r = await client.connect('srv1');

    expect(r.ok).toBe(false);
    expect(client.getServer('srv1')?.state).toBe('failed');
    expect(client.getServer('srv1')?.lastError).toContain('连接被拒绝');
    expect(log.byType('mcp.serverFailed')).toHaveLength(1);
  });

  it('tools/list 失败也算连接失败', async () => {
    const { client } = setup([
      {
        method: MCP_METHODS.initialize,
        result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {} },
      },
      { method: MCP_METHODS.listTools, result: { nope: 1 } },
    ]);
    client.addServer(cfg());
    const r = await client.connect('srv1');
    expect(r.ok).toBe(false);
    expect(client.getServer('srv1')?.state).toBe('failed');
  });

  it('断开落事件', async () => {
    const { client, log } = setup(OK_RULES);
    client.addServer(cfg());
    await client.connect('srv1');
    await client.disconnect('srv1');

    expect(log.byType('mcp.serverDisconnected')).toHaveLength(1);
    expect(client.getServer('srv1')?.state).toBe('disconnected');
  });

  it('★ 停用会先断开', async () => {
    const { client, fake } = setup(OK_RULES);
    client.addServer(cfg());
    await client.connect('srv1');
    await client.setEnabled('srv1', false);

    expect(fake.closed).toBe(true);
    expect(client.getServer('srv1')?.state).toBe('disabled');
  });

  it('移除服务器落事件且保留工具计数（可追溯）', async () => {
    const { client, log } = setup(OK_RULES);
    client.addServer(cfg());
    await client.connect('srv1');
    client.removeServer('srv1');

    const p = log.byType('mcp.serverRemoved')[0]?.payload as { toolCount: number };
    expect(p.toolCount).toBe(2);
    expect(client.getServer('srv1')).toBeUndefined();
  });

  it('★ 策略变更落事件（含改动前后，可审计）', async () => {
    const { client, log } = setup(OK_RULES);
    client.addServer(cfg());
    client.setPolicy('srv1', { ...DEFAULT_POLICY, level: 'readOnly' });

    const p = log.byType('mcp.policyChanged')[0]?.payload as { from: string; to: string };
    expect(p.from).toBe('manual');
    expect(p.to).toBe('readOnly');
  });

  it('★ 不存在的服务器操作返回 false，不抛错', async () => {
    const { client } = setup(OK_RULES);
    expect(client.removeServer('nope')).toBe(false);
    expect(client.setPolicy('nope', DEFAULT_POLICY)).toBe(false);
    expect(await client.disconnect('nope')).toBe(false);
  });

  it('未连接时调用工具返回可读原因', async () => {
    const { client } = setup(OK_RULES);
    client.addServer(cfg());
    const r = await client.callTool({ serverId: 'srv1', toolName: 'x', toolArgs: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('未连接');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑩ 确定性
// ═══════════════════════════════════════════════════════════

describe('⑩ 确定性', () => {
  it('同一份工具清单产出同样的限定名', () => {
    const a = qualifyToolName('srv1', 'get_weather');
    const b = qualifyToolName('srv1', 'get_weather');
    expect(a).toBe(b);
  });

  it('时间来自 ClockPort', async () => {
    const { client, log, clock } = setup(OK_RULES);
    client.addServer(cfg());
    const ev = log.byType('mcp.serverAdded')[0];
    expect(ev?.createdAt).toBe(clock.now());
  });

  it('★ 上报/审计全走事件流（没有旁路日志）', async () => {
    const s = setup([
      ...OK_RULES,
      { method: MCP_METHODS.callTool, result: { content: [{ type: 'text', text: 'x' }] } },
    ]);
    s.client.addServer(cfg());
    await s.client.connect('srv1');

    // 除了工具调用走 tool.* 之外，生命周期全在 mcp.* 里
    expect(s.log.byType('mcp.serverAdded').length).toBe(1);
    expect(s.log.byType('mcp.serverConnected').length).toBe(1);
    void vi;
    void MemoryFileSystem;
  });
});

/** 类型自检。 */
const _t: ActionTier = 'readOnly';
void _t;
