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
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  DEFAULT_MAX_OUTPUT_BYTES,
  ExecError,
  type ExecPort,
  type ExecRequest,
  type ExecResult,
} from '../../core/ports/exec.js';

/**
 * `target` 是否真的在 `root` 之内（含 root 本身）。
 *
 * ⚠️ 旧实现是 `!req.cwd.startsWith(this.cwdRoot)`，两个洞：
 *   ① 前缀比较不看目录边界：`…\butler-ai-evil` 与 `…\butler-ai` 前缀相同 → 放行；
 *   ② 不做 `resolve`：`…\butler-ai\..\..\Windows\System32` 照样通过。
 * 实测：兄弟目录与 `..` 回溯都能在"工作区"之外执行命令。
 */
function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** realpath 失败（路径不存在等）时退回原值 —— 判定仍由 resolve 后的路径完成。 */
async function safeReal(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

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

/**
 * 子进程环境白名单 —— **只给系统必需项**。
 *
 * ⚠️ 任何 spawn 子进程的地方都应复用这份，而不是 `{ ...process.env }`：
 *    后者会把 `DEEPSEEK_API_KEY` 等密钥一起交给子进程（以及被 exploit 的解析器）。
 */
export const DEFAULT_ENV_WHITELIST: readonly string[] = [
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
    if (this.cwdRoot !== undefined) {
      const root = resolve(this.cwdRoot);
      const target = resolve(req.cwd);
      if (!inside(root, target)) {
        throw new ExecError(`工作目录必须在 ${this.cwdRoot} 之下`, 'INVALID_REQUEST');
      }
      // ★ 再按真实路径判一次：工作区里放一个指向外部的符号链接/junction 时，
      //   字面路径在内、真实路径在外 —— 只比字面等于没判。
      const realRoot = await safeReal(root);
      const realTarget = await safeReal(target);
      if (!inside(realRoot, realTarget)) {
        throw new ExecError(
          `工作目录的真实路径 ${realTarget} 不在 ${realRoot} 之下（符号链接逃逸）`,
          'INVALID_REQUEST',
        );
      }
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

      /**
       * ★ 输出按 **Buffer** 累积，最后一次性解码。
       *
       *   旧实现 `chunk.toString('utf8')` 逐块解码：一个 3 字节的汉字
       *   被 chunk 边界切开时，两半都会解成 U+FFFD（实测 12 万字符里出现 6 个）。
       *   而且上限比较用的是 `stdout.length`（字符数）对 `maxBytes`（字节数），
       *   中文会被少截一半。改成按字节累积、结束再解码，两个问题一起消失。
       */
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, req.timeoutMs);

      const collect = (chunk: Buffer, into: 'out' | 'err'): void => {
        const used = into === 'out' ? outBytes : errBytes;
        const remaining = maxBytes - used;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        if (slice.length < chunk.length) truncated = true;
        if (into === 'out') {
          outChunks.push(slice);
          outBytes += slice.length;
        } else {
          errChunks.push(slice);
          errBytes += slice.length;
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
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          timedOut,
          truncated,
          durationMs: Date.now() - started,
        });
      });

      /**
       * ★ stdin 必须**无条件**关闭。
       *
       *   旧写法只在传了 `stdin` 时才 end：任何读 stdin 直到 EOF 的命令
       *   （`node -e` 里监听 end、`cat`、`sort` …）会一直等下去，
       *   直到 timeoutMs 被杀。实测：不传 stdin 时该命令 timedOut=true。
       */
      if (child.stdin) {
        if (req.stdin !== undefined) child.stdin.write(req.stdin);
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
