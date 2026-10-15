/**
 * 适配器 · Node 命令执行
 *
 * ⚠️ 这是整个系统里**风险最高**的一段代码：它真的会执行命令。
 *
 * 安全边界（层层收窄）：
 *   ① 不经过 shell —— 用 spawn 直接起进程，杜绝 `;` `&&` `|` 注入
 *   ② 强制超时 —— 到期 kill，避免挂死
 *   ③ 强制工作目录 —— 不允许"在任意位置执行"
 *   ④ 输出上限 —— 超出截断，防止撑爆上下文
 *   ⑤ 环境变量白名单 —— 默认不继承全部环境（避免密钥被命令读走）
 *
 * 但**最重要的边界不在这里**，而在 ToolFramework 的闸门：
 * 命令执行属于 highRisk 级，每次都要用户确认。
 * 这个适配器只负责"怎么执行"，不负责"允不允许"。
 */

import { spawn } from 'node:child_process';

import {
  DEFAULT_MAX_OUTPUT_BYTES,
  ExecError,
  type ExecPort,
  type ExecRequest,
  type ExecResult,
} from '../../core/ports/exec.js';

export interface NodeExecOptions {
  /**
   * 传给子进程的环境变量白名单。
   *
   * ⚠️ 默认**极窄**：只给 PATH 与系统必需项。
   *    理由：如果把 process.env 整体传下去，子进程能读到 DEEPSEEK_API_KEY
   *    之类的密钥 —— 那等于把"凭证可用不可见"这条约束自己拆了。
   *    需要额外变量的命令应当显式通过 `env` 传入，并在工具层留痕。
   */
  readonly envWhitelist?: readonly string[];
  /** 允许的工作目录根（可选）。给定时，cwd 必须落在其下。 */
  readonly cwdRoot?: string;
}

const DEFAULT_ENV_WHITELIST: readonly string[] = [
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'HOME',
  'USERPROFILE',
];

export class NodeExec implements ExecPort {
  readonly supported = true;
  private readonly whitelist: readonly string[];
  private readonly cwdRoot: string | undefined;

  constructor(opts: NodeExecOptions = {}) {
    this.whitelist = opts.envWhitelist ?? DEFAULT_ENV_WHITELIST;
    this.cwdRoot = opts.cwdRoot;
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    if (!req.command || req.command.trim().length === 0) {
      throw new ExecError('命令不能为空', 'INVALID_REQUEST');
    }
    if (req.timeoutMs <= 0) {
      throw new ExecError('必须给出正数超时（毫秒）', 'INVALID_REQUEST');
    }
    if (!req.cwd || req.cwd.trim().length === 0) {
      throw new ExecError('必须给出工作目录', 'INVALID_REQUEST');
    }
    if (this.cwdRoot !== undefined && !req.cwd.startsWith(this.cwdRoot)) {
      throw new ExecError(`工作目录必须在 ${this.cwdRoot} 之下`, 'INVALID_REQUEST');
    }

    const maxBytes = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const started = Date.now();

    return await new Promise<ExecResult>((resolveP, rejectP) => {
      let child;
      try {
        child = spawn(req.command, [...req.args], {
          cwd: req.cwd,
          // ⚠️ shell: false 是关键 —— 参数不会被 shell 解释，
          //    因此用户输入的 `; rm -rf /` 只是一个普通参数字符串。
          shell: false,
          windowsHide: true,
          /**
           * ⚠️ 断言成 `ProcessEnv` 是**刻意的**。
           *
           *   我们传的是**环境变量白名单**（只保留 PATH / SystemRoot 等），
           *   而 `ProcessEnv` 类型声明了 NODE_ENV 等必填键 —— 于是类型对不上。
           *
           *   断言表达的是「这里传的就是完整环境，且它比类型要求的更严」。
           *   这不是绕过类型检查，而是把「有意收紧」这件事写进代码。
           */
          env: this.buildEnv(req.env) as unknown as NodeJS.ProcessEnv,
        });
      } catch (err) {
        rejectP(
          new ExecError(
            `无法启动进程：${err instanceof Error ? err.message : String(err)}`,
            'SPAWN_FAILED',
          ),
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, req.timeoutMs);

      const collect = (chunk: Buffer, into: 'out' | 'err'): void => {
        const text = chunk.toString('utf8');
        if (into === 'out') {
          if (stdout.length + text.length > maxBytes) {
            stdout += text.slice(0, Math.max(0, maxBytes - stdout.length));
            truncated = true;
          } else {
            stdout += text;
          }
        } else if (stderr.length + text.length > maxBytes) {
          stderr += text.slice(0, Math.max(0, maxBytes - stderr.length));
          truncated = true;
        } else {
          stderr += text;
        }
      };

      child.stdout?.on('data', (c: Buffer) => collect(c, 'out'));
      child.stderr?.on('data', (c: Buffer) => collect(c, 'err'));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectP(new ExecError(`进程错误：${err.message}`, 'SPAWN_FAILED'));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveP({
          // 被信号杀死时 code 为 null，用 -1 表示
          exitCode: typeof code === 'number' ? code : -1,
          stdout,
          stderr,
          timedOut,
          truncated,
          durationMs: Date.now() - started,
        });
      });

      if (req.stdin !== undefined && child.stdin) {
        child.stdin.write(req.stdin);
        child.stdin.end();
      }
    });
  }

  /** 构造子进程环境：只带白名单 + 调用方显式传入的增量。 */
  private buildEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of this.whitelist) {
      const v = process.env[k];
      if (v !== undefined) out[k] = v;
    }
    if (extra) {
      for (const [k, v] of Object.entries(extra)) out[k] = v;
    }
    return out;
  }
}
