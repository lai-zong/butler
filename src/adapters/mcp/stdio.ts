/**
 * MCP stdio 传输实现
 *
 * 设计依据：方案 § 10.2（支持 stdio / SSE / streamable-http）
 *
 * ★ 协议：MCP 的 stdio 传输用**换行分隔的 JSON-RPC**（NDJSON）——
 *   一行一条消息，不用 Content-Length 头。
 *   这与 LSP 不同，别混。
 *
 * ⚠️ stderr 单独处理：MCP server 常把日志写到 stderr。
 *    把它当错误会让正常的 server 看起来一直在报错；
 *    完全丢弃又会在排查时什么线索都没有。
 *    所以**收集但不当失败**，并在连接失败时一并返回。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { JsonRpcResponse } from '../../core/mcp/protocol.js';
import { parseMessage } from '../../core/mcp/protocol.js';
import type { McpTransportFactory, McpTransportPort } from '../../core/mcp/client.js';
import type { McpServerConfig } from '../../core/mcp/types.js';

/** stderr 保留的最大行数（防止长期运行的 server 把内存吃满）。 */
export const MAX_STDERR_LINES = 200;

/** 子进程环境白名单。
 *
 * ⚠️ 不继承整个 process.env —— 那会把 API 密钥之类的敏感变量
 *    传给一个第三方进程（方案 § 11 凭证"可用不可见"）。
 */
export const DEFAULT_MCP_ENV_WHITELIST: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
];

export interface StdioTransportOptions {
  /** 环境变量白名单，默认见上 */
  readonly envWhitelist?: readonly string[];
  /**
   * 是否允许把配置里的 env 合并进子进程环境。
   *
   * ⚠️ 配置里的 env 已由 `validateConfig` 校验过（拒绝疑似凭证），
   *    所以这里是安全的；但保留开关以便测试与更严的部署。
   */
  readonly allowConfigEnv?: boolean;
}

class StdioTransport implements McpTransportPort {
  private buffer = '';
  private readonly pending = new Map<number | string, {
    readonly resolve: (r: JsonRpcResponse) => void;
    readonly reject: (e: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly stderrLines: string[] = [];
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotice: (method: string) => void,
    private readonly onExit: (code: number | null, signal: string | null) => void,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const l = line.trim();
        if (l.length === 0) continue;
        this.stderrLines.push(l);
        if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines.shift();
      }
    });

    child.on('exit', (code, signal) => {
      this.closed = true;
      // ⚠️ 进程退出时**必须**拒绝所有挂起的请求 ——
      //    否则调用方会一直等到超时，而真正的原因（进程崩了）要等 30 秒才知道。
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server 进程已退出（code=${String(code)} signal=${String(signal)}）`));
      }
      this.pending.clear();
      this.onExit(code, signal);
    });

    child.on('error', (err) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  /** 累积缓冲并按行切分 —— 一次 data 事件可能含半行或多行。 */
  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) this.handleLine(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    const parsed = parseMessage(line);
    if (parsed.kind === 'response') {
      const id = parsed.response.id;
      if (id === null) return;
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve(parsed.response);
      }
      return;
    }
    if (parsed.kind === 'notification') {
      this.onNotice(parsed.notification.method);
      return;
    }
    // 解析失败的行不致命 —— server 可能往 stdout 打了非协议内容
    this.stderrLines.push(`[非协议 stdout] ${line.slice(0, 200)}`);
  }

  async request(msg: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    if (this.closed) throw new Error('传输已关闭');
    const id = (msg as { id?: number | string }).id;
    if (id === undefined) throw new Error('请求缺少 id');

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${timeoutMs}ms）`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(msg)}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async notify(msg: unknown): Promise<void> {
    if (this.closed) throw new Error('传输已关闭');
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 先关 stdin：多数 server 见此会自行退出
    this.child.stdin.end();
    // 给它一点时间，然后强杀 —— 不能留下孤儿进程
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 2000);
      this.child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** 供错误信息用。 */
  stderrTail(): string {
    return this.stderrLines.slice(-20).join('\n');
  }
}

/** 创建 stdio 传输工厂。 */
export function stdioTransportFactory(opts: StdioTransportOptions = {}): McpTransportFactory {
  const whitelist = opts.envWhitelist ?? DEFAULT_MCP_ENV_WHITELIST;

  return {
    transport: 'stdio',
    async open(config: McpServerConfig): Promise<McpTransportPort> {
      if (!config.command) throw new Error('stdio 传输缺少启动命令');

      // 从 process.env 里只挑白名单内的变量
      const env: Record<string, string> = {};
      for (const k of whitelist) {
        const v = process.env[k];
        if (v !== undefined) env[k] = v;
      }
      if (opts.allowConfigEnv !== false) {
        Object.assign(env, config.env ?? {});
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(config.command, [...(config.args ?? [])], {
          // ⚠️ shell: false —— 与命令执行工具同一条纪律：
          //    不经 shell 解释，避免注入与转义问题
          shell: false,
          // 同 exec 适配器：传的是白名单，比 ProcessEnv 要求的更严
          env: env as unknown as NodeJS.ProcessEnv,
          ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        throw new Error(
          `无法启动 MCP server「${config.name}」：${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 进程启动失败是异步的（ENOENT 等）—— 等一小会儿确认没有立刻挂掉
      const early = await earlyExit(child, 400);
      if (early !== null) {
        throw new Error(
          `MCP server「${config.name}」启动后立即退出（${early}）。` +
            `请检查命令与参数是否正确：${config.command} ${(config.args ?? []).join(' ')}`,
        );
      }

      return new StdioTransport(
        child,
        () => undefined,
        () => undefined,
      );
    },
  };
}

/** 等一小段时间；若进程已退出则返回原因，否则返回 null。 */
async function earlyExit(
  child: ChildProcessWithoutNullStreams,
  ms: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(signal !== null ? `被信号 ${signal} 终止` : `退出码 ${String(code)}`);
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(err.message);
    });
  });
}
