/**
 * MCP 工具桥接 —— 把外部工具挂进本系统的 ToolFramework
 *
 * 设计依据：方案 § 10.2（通用 MCP 客户端）、§ 10.3（权限分级）
 *
 * ★ 本模块的核心主张：**MCP 工具走同一个安全闸门，没有旁路。**
 *
 *   `ToolFramework.execute()` 是全系统唯一的执行路径
 *   （它在设计时就是"单一执行路径，无绕过"）。
 *   MCP 工具只是一种被注册进来的 `ToolSpec`，
 *   所以：
 *     · 它同样经过分级判定（action.classified）
 *     · 它同样受 PermissionPolicy 约束
 *     · 它同样落 tool.call / tool.result 审计事件
 *     · 它同样经过输入侧注入防护（结果被 wrapUntrusted 包裹）
 *
 *   ⚠️ 如果 MCP 工具走独立路径，那它就是**第四条绕过通道** ——
 *      前三条（输入侧/记忆侧/动作侧）白做了。
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { ActionTier, ToolSpec, ToolResult, ToolContext } from '../tools/types.js';
import {
  type McpConnectionState,
  type McpServerConfig,
  type McpPolicyLevel,
  type McpServerPolicy,
  type McpToolDescriptor,
  type McpTransport,
  autoAllowed,
  inferTier,
  qualifyToolName,
  validateConfig,
} from './types.js';
import {
  MCP_METHODS,
  type InitializeResult,
  type JsonRpcNotification,
  type JsonRpcResponse,
  McpProtocolError,
  initializeParams,
  makeNotification,
  makeRequest,
  parseInitializeResult,
  parseToolCallResult,
  parseToolsList,
  sanitizeToolName,
  unwrap,
} from './protocol.js';

// ═══════════════════════════════════════════════════════════
// 传输端口（由 adapters 实现）
// ═══════════════════════════════════════════════════════════

/**
 * 传输端口。
 *
 * ⚠️ 核心层**只认识这个方法** —— 不 spawn 进程、不发 HTTP（ADR 0004）。
 *    所以 MCP 的协议逻辑可以完全确定性地测试。
 */
export interface McpTransportPort {
  /** 发一条请求并等它的响应 */
  request(msg: unknown, timeoutMs: number): Promise<JsonRpcResponse>;
  /** 发一条通知（不等响应）*/
  notify(msg: unknown): Promise<void>;
  /** 关闭传输 */
  close(): Promise<void>;
}

export interface McpTransportFactory {
  readonly transport: McpTransport;
  /** 建立连接。失败应抛出可读错误。 */
  open(config: McpServerConfig): Promise<McpTransportPort>;
}

// ═══════════════════════════════════════════════════════════
// 连接运行时状态
// ═══════════════════════════════════════════════════════════

export interface McpServerRuntime {
  /** ⚠️ 可变：启停与策略改动会就地更新 */
  config: McpServerConfig;
  state: McpConnectionState;
  /** 握手结果 */
  handshake?: InitializeResult;
  /** 发现到的工具 */
  tools: McpToolDescriptor[];
  /** 失败原因 */
  lastError?: string;
  /** 收到但未处理的通知（供界面展示，如 server 日志）*/
  notices: { readonly method: string; readonly at: number }[];
  port?: McpTransportPort;
}

/** 请求超时（毫秒）。远程 server 可能慢，给足时间。 */
export const REQUEST_TIMEOUT_MS = 30_000;
/** 连接（initialize）超时。 */
export const CONNECT_TIMEOUT_MS = 20_000;

// ═══════════════════════════════════════════════════════════
// 客户端
// ═══════════════════════════════════════════════════════════

export class McpClient {
  private readonly servers = new Map<string, McpServerRuntime>();
  private readonly factories = new Map<McpTransport, McpTransportFactory>();
  private seq = 0;

  constructor(
    private readonly log: EventLog,
    private readonly clock: ClockPort,
  ) {}

  /** 注册一种传输的实现。 */
  registerTransport(f: McpTransportFactory): void {
    this.factories.set(f.transport, f);
  }

  hasTransport(t: McpTransport): boolean {
    return this.factories.has(t);
  }

  // ── 服务器管理（方案 § 10.2：添加 / 移除 / 启停 / 查看工具列表）──

  /**
   * 添加一个服务器。
   *
   * ⚠️ **不做连接** —— 添加与连接是两件事：
   *    用户可能先把配置填好再看要不要启用；
   *    也可能一次配好几个再逐个连。
   */
  addServer(config: McpServerConfig): { readonly ok: boolean; readonly problems: readonly string[] } {
    const problems = validateConfig(config);
    if (problems.length > 0) {
      this.log.append({
        type: 'mcp.serverFailed',
        actor: 'user',
        payload: {
          serverId: config.id,
          phase: 'validate',
          problems: problems.map((p) => `${p.field}: ${p.message}`),
        },
        createdAt: this.clock.now(),
      });
      return { ok: false, problems: problems.map((p) => `${p.field}: ${p.message}`) };
    }

    this.servers.set(config.id, {
      config,
      state: config.enabled ? 'disconnected' : 'disabled',
      tools: [],
      notices: [],
    });

    this.log.append({
      type: 'mcp.serverAdded',
      actor: 'user',
      payload: {
        serverId: config.id,
        name: config.name,
        transport: config.transport,
        enabled: config.enabled,
        // 明确记录策略，便于事后审计"当时允许它做什么"
        policyLevel: config.policy.level,
        leavesMachine: config.transport !== 'stdio',
      },
      createdAt: this.clock.now(),
    });

    return { ok: true, problems: [] };
  }

  removeServer(id: string): boolean {
    const rt = this.servers.get(id);
    if (!rt) return false;
    // 断开但仍保留工具定义，让"这个工具曾存在"可追溯
    void rt.port?.close().catch(() => undefined);
    this.servers.delete(id);

    this.log.append({
      type: 'mcp.serverRemoved',
      actor: 'user',
      payload: { serverId: id, name: rt.config.name, toolCount: rt.tools.length },
      createdAt: this.clock.now(),
    });
    return true;
  }

  listServers(): readonly McpServerRuntime[] {
    return [...this.servers.values()];
  }

  getServer(id: string): McpServerRuntime | undefined {
    return this.servers.get(id);
  }

  /** 改动某个服务器的策略。 */
  setPolicy(id: string, policy: McpServerPolicy): boolean {
    const rt = this.servers.get(id);
    if (!rt) return false;
    const before = rt.config.policy;
    rt.config = { ...rt.config, policy };

    this.log.append({
      type: 'mcp.policyChanged',
      actor: 'user',
      payload: {
        serverId: id,
        from: before.level,
        to: policy.level,
        disabledTools: policy.disabledTools,
        allowMemoryWrite: policy.allowMemoryWrite,
        allowDangerousTools: policy.allowDangerousTools,
      },
      createdAt: this.clock.now(),
    });
    return true;
  }

  // ── 连接 ──

  /**
   * 连接一个服务器并发现它的工具。
   *
   * 流程：open 传输 → initialize → notifications/initialized → tools/list
   *
   * ⚠️ 每一步失败都**如实记录并停下**，不"尽力而为地继续"——
   *    半连接的 server 会让后续调用失败得莫名其妙。
   */
  async connect(id: string): Promise<{ readonly ok: boolean; readonly reason?: string }> {
    const rt = this.servers.get(id);
    if (!rt) return { ok: false, reason: '服务器不存在' };
    if (!rt.config.enabled) return { ok: false, reason: '服务器已停用' };

    const factory = this.factories.get(rt.config.transport);
    if (!factory) {
      const reason = `未注册 ${rt.config.transport} 传输实现`;
      rt.state = 'failed';
      rt.lastError = reason;
      return { ok: false, reason };
    }

    rt.state = 'connecting';
    try {
      rt.port = await factory.open(rt.config);

      // ① initialize
      const initRes = await rt.port.request(
        makeRequest(++this.seq, MCP_METHODS.initialize, initializeParams()),
        CONNECT_TIMEOUT_MS,
      );
      const handshake = parseInitializeResult(unwrap(initRes));

      // ★ 版本不匹配时**如实报告**，不装作兼容
      if (!handshake.versionAgreed) {
        const reason =
          `协议版本不匹配：server 用 ${handshake.protocolVersion || '（未声明）'}，` +
          `本客户端支持 ${['2025-06-18', '2025-03-26', '2024-11-05'].join(' / ')}。` +
          '字段形状可能不同，已停止以免产生难查的解析错误。';
        rt.state = 'failed';
        rt.lastError = reason;
        this.log.append({
          type: 'mcp.serverFailed',
          actor: 'system',
          payload: { serverId: id, phase: 'initialize', reason, serverVersion: handshake.protocolVersion },
          createdAt: this.clock.now(),
        });
        return { ok: false, reason };
      }

      rt.handshake = handshake;

      // ② 通知 server 握手完成（协议要求，无响应）
      await rt.port.notify(makeNotification(MCP_METHODS.initialized));

      // ③ 发现工具
      const listRes = await rt.port.request(
        makeRequest(++this.seq, MCP_METHODS.listTools),
        REQUEST_TIMEOUT_MS,
      );
      const listed = parseToolsList(unwrap(listRes));
      if (!listed.ok) {
        rt.state = 'failed';
        rt.lastError = listed.reason;
        this.log.append({
          type: 'mcp.serverFailed',
          actor: 'system',
          payload: { serverId: id, phase: 'tools/list', reason: listed.reason },
          createdAt: this.clock.now(),
        });
        return { ok: false, reason: listed.reason };
      }

      // ★ 分级由**本系统推断**，不采信外部声明（见 types.ts inferTier）
      rt.tools = listed.tools.map((t) => {
        const inferred = inferTier(t.name, t.description);
        const safe = sanitizeToolName(t.name);
        return {
          serverId: id,
          name: t.name,
          qualifiedName: qualifyToolName(id, safe),
          description: t.description,
          inputSchema: t.inputSchema,
          tier: inferred.tier,
        };
      });

      rt.state = 'connected';
      delete rt.lastError;

      this.log.append({
        type: 'mcp.serverConnected',
        actor: 'system',
        payload: {
          serverId: id,
          name: rt.config.name,
          transport: rt.config.transport,
          protocolVersion: handshake.protocolVersion,
          serverInfo: handshake.serverInfo ?? null,
          toolCount: rt.tools.length,
        },
        createdAt: this.clock.now(),
      });

      // 工具清单单独落事件 —— 外部工具挂载是可审计的关键动作
      this.log.append({
        type: 'mcp.toolsDiscovered',
        actor: 'system',
        payload: {
          serverId: id,
          count: rt.tools.length,
          tools: rt.tools.map((t) => ({
            name: t.name,
            qualifiedName: t.qualifiedName,
            // ★ 把推断出的分级一并记下 —— 事后能回答"当时为什么让它自动跑"
            tier: t.tier,
            disabled: rt.config.policy.disabledTools.includes(t.name),
          })),
        },
        createdAt: this.clock.now(),
      });

      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      rt.state = 'failed';
      rt.lastError = reason;
      this.log.append({
        type: 'mcp.serverFailed',
        actor: 'system',
        payload: { serverId: id, phase: 'connect', reason },
        createdAt: this.clock.now(),
      });
      return { ok: false, reason };
    }
  }

  /** 断开连接。 */
  async disconnect(id: string, reason = '用户断开'): Promise<boolean> {
    const rt = this.servers.get(id);
    if (!rt) return false;

    await rt.port?.close().catch(() => undefined);
    delete rt.port;
    rt.state = rt.config.enabled ? 'disconnected' : 'disabled';

    this.log.append({
      type: 'mcp.serverDisconnected',
      actor: 'user',
      payload: { serverId: id, reason },
      createdAt: this.clock.now(),
    });
    return true;
  }

  /** 启停。 */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const rt = this.servers.get(id);
    if (!rt) return false;
    rt.config = { ...rt.config, enabled };
    if (!enabled) {
      await this.disconnect(id, '用户停用');
      rt.state = 'disabled';
    } else {
      rt.state = 'disconnected';
    }
    return true;
  }

  // ── 调用 ──

  /**
   * 调用一个外部工具。
   *
   * ⚠️ **这个方法只做协议调用，不做安全判定** ——
   *    安全判定由 ToolFramework 在做（见 `toToolSpecs`）。
   *    把它做成"能自己判"的会让闸门出现第二条判定路径。
   */
  async callTool(args: {
    readonly serverId: string;
    readonly toolName: string;
    readonly toolArgs: unknown;
  }): Promise<{ readonly ok: boolean; readonly text: string; readonly reason?: string }> {
    const rt = this.servers.get(args.serverId);
    if (!rt) return { ok: false, text: '', reason: '服务器不存在' };
    if (rt.state !== 'connected' || !rt.port) {
      return { ok: false, text: '', reason: `服务器未连接（当前状态：${rt.state}）` };
    }

    try {
      const res = await rt.port.request(
        makeRequest(++this.seq, MCP_METHODS.callTool, {
          name: args.toolName,
          arguments: args.toolArgs ?? {},
        }),
        REQUEST_TIMEOUT_MS,
      );
      const parsed = parseToolCallResult(unwrap(res));
      return { ok: !parsed.isError, text: parsed.text };
    } catch (err) {
      const reason =
        err instanceof McpProtocolError ? err.message : err instanceof Error ? err.message : String(err);
      return { ok: false, text: '', reason };
    }
  }

  // ── 挂进 ToolFramework ──

  /**
   * 把所有已连接服务器的工具转成 `ToolSpec`，交给 ToolFramework 注册。
   *
   * ★ 这是"没有旁路"的实现：
   *   转换出来的就是普通的 ToolSpec，
   *   所以它们自动获得分级判定、权限闸门、审计、注入防护。
   */
  toToolSpecs(): readonly ToolSpec[] {
    const out: ToolSpec[] = [];

    for (const rt of this.servers.values()) {
      if (rt.state !== 'connected') continue;

      for (const tool of rt.tools) {
        // 被用户显式禁用的不注册 —— 连"看见"都不给模型
        if (rt.config.policy.disabledTools.includes(tool.name)) continue;

        // ★★ 危险级工具默认**不注册**，除非用户为该 server 显式开启。
        //
        //   这是一道独立于全局闸门的防线。全局 isTierEnabled('dangerous')
        //   只表示"用户在某处开启过危险级别"，**不等于**
        //   "允许这个第三方 server 执行删除 / 终止进程 / 改注册表"。
        //
        //   ⚠️ 端到端验证抓到的：不设这道防线时，危险工具会一路走到外部
        //      server，只有 server 自己拒绝才拦住 —— **靠对端自律不算安全设计**。
        if (tool.tier === 'dangerous' && !rt.config.policy.allowDangerousTools) continue;

        out.push(this.buildSpec(rt, tool));
      }
    }

    return out;
  }

  private buildSpec(rt: McpServerRuntime, tool: McpToolDescriptor): ToolSpec {
    const serverId = rt.config.id;
    const policy = rt.config.policy;
    const clock = this.clock;
    const self = this;

    // ★★ 关键设计：服务器策略**折进工具的 tier**，而不是在 execute 里另判一次。
    //
    //   理由：`ToolContext` 里没有"用户是否已批准"的信息 ——
    //   因为全局闸门在 `execute` **之前**就已经问过了。
    //   如果在这里再判一次，就出现了**第二条判定路径**，
    //   而两条路径的判断依据不同（一条看 tier，一条看服务器策略），
    //   必然出现"闸门放行了但 execute 又拒绝"这种自相矛盾的状态。
    //
    //   折进 tier 之后：
    //     · 判定仍然只有闸门一处
    //     · 服务器策略的效果 = "把工具的分级抬高到需要确认的程度"
    //     · `manual` 策略下所有工具至少是 normal → 每次都要问
    //     · 危险级工具无论策略如何都保持 dangerous（默认禁用）
    const effectiveTier = applyServerPolicy(tool.tier, policy.level);

    return {
      name: tool.qualifiedName,
      description:
        // ★ 来源标注写进描述：让模型知道这是外部工具，
        //   同时也让 description 里的可疑内容在界面上可见
        `[来自 MCP 服务器「${rt.config.name}」的外部工具] ${tool.description}`,
      parameters: tool.inputSchema,
      // ★ 分级 = 本系统推断（inferTier）再叠加服务器策略
      tier: effectiveTier,

      summarize: (a: unknown) => {
        const s = safeJson(a);
        return `调用外部工具 ${tool.name}${s === '{}' ? '' : `：${truncate(s, 60)}`}`;
      },

      preview: async (a: unknown) => {
        const allowed = autoAllowed({ policy, toolName: tool.name, tier: tool.tier });
        const lines = [
          `MCP 服务器：${rt.config.name}（${rt.config.transport}）`,
          `工具：${tool.name}`,
          `本系统推断的动作级别：${tool.tier}`,
          `服务器策略：${policy.level}`,
          allowed.allowed ? `✓ 该策略下可自动放行（${allowed.reason}）` : `⚠ 需要你确认（${allowed.reason}）`,
          `入参：${truncate(safeJson(a), 200)}`,
        ];
        if (rt.config.transport !== 'stdio') {
          lines.push('⚠ 这是远程服务器 —— 请求内容会离开本机');
        }
        return lines.join('\n');
      },

      execute: async (a: unknown, _ctx: ToolContext): Promise<ToolResult> => {
        const started = clock.now();
        const r = await self.callTool({ serverId, toolName: tool.name, toolArgs: a });

        return {
          ok: r.ok,
          output: r.ok ? r.text : `外部工具调用失败：${r.reason ?? '未知原因'}`,
          ...(r.ok ? {} : { isError: true }),
          durationMs: clock.now() - started,
        };
      },
    };
  }
}

/**
 * 把服务器策略折进工具分级。
 *
 * ★ 语义：策略只能**抬高**分级，不能降低。
 *   一个被推断为 dangerous 的工具，不会因为服务器策略是 `normal` 就变成可自动执行。
 *
 *   | 策略      | 效果
 *   | manual    | 所有工具至少 normal（每次都要确认）
 *   | readOnly  | 只读工具保持 readOnly；其余至少 normal
 *   | normal    | 保持推断结果（但危险级仍不自动放行，由全局闸门把关）
 */
export function applyServerPolicy(tier: ActionTier, level: McpPolicyLevel): ActionTier {
  // 危险级永远不降 —— 与方案 § 10.3 第四级一致
  if (tier === 'dangerous') return 'dangerous';

  const order: readonly ActionTier[] = ['readOnly', 'normal', 'highRisk', 'dangerous'];
  const floor: ActionTier = level === 'manual' ? 'normal' : 'readOnly';
  return order.indexOf(tier) < order.indexOf(floor) ? floor : tier;
}

// ═══════════════════════════════════════════════════════════
// 内部
// ═══════════════════════════════════════════════════════════

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {}) ?? '{}';
  } catch {
    return '(无法序列化)';
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

export type { JsonRpcNotification };
