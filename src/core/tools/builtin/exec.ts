/**
 * 内置工具 · 命令执行
 *
 * 设计依据：方案 § 6.1（基础层）、§ 11（动作侧防护）
 *
 * ⚠️ 分级为 **highRisk**：命令能做的事无法穷举，
 *    所以策略是"每次都用只读预览告诉用户要跑什么，再确认"。
 *
 * 安全设计：
 *   · **不接受 shell 字符串** —— 参数是数组，`;` `&&` `|` 只是普通字符
 *   · 强制超时（默认 15s，上限 5min）
 *   · 工作目录必填
 *   · 输出截断
 *   · 命令与参数进审计（便于事后追查"它到底跑了什么"）
 */

import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  ExecError,
  type ExecPort,
} from '../../ports/exec.js';
import type { ToolContext, ToolSpec } from '../types.js';

/** 超时上限：5 分钟。再长就该做成后台任务，而不是占着会话。 */
const MAX_TIMEOUT_MS = 5 * 60 * 1000;

/** 常见只读命令（用于预览里提示"这条是只读的"）。 */
const LIKELY_READONLY: readonly string[] = [
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'find', 'grep', 'rg',
  'git', 'node', 'npm', 'pnpm', 'python', 'python3', 'where', 'which', 'echo', 'pwd', 'date',
  'whoami', 'hostname', 'tsc', 'vitest', 'eslint', 'prettier',
];

export function execTool(exec: ExecPort, defaultCwd: string): ToolSpec {
  return {
    name: 'run_command',
    description:
      '执行一个命令并返回输出。参数以数组形式传入，**不经过 shell**，' +
      '所以管道与重定向（| > &&）不可用 —— 需要那些请改用专门工具或写成脚本再执行。' +
      '每次执行都需要用户确认。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '可执行文件名，如 "git"、"node"、"ls"' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '参数数组，如 ["status", "--short"]。不要传 shell 语法。',
        },
        cwd: { type: 'string', description: `工作目录。省略时用 ${defaultCwd}` },
        timeoutMs: { type: 'number', description: '超时（毫秒），默认 15000，上限 300000' },
      },
      required: ['command'],
    },
    tier: 'highRisk',
    summarize: (args) => {
      const a = args as { command?: unknown; args?: unknown };
      const cmd = String(a?.command ?? '?');
      const rest = Array.isArray(a?.args) ? a.args.map(String) : [];
      return `执行命令：${[cmd, ...rest].join(' ')}`;
    },
    async preview(args) {
      const a = args as { command?: string; args?: unknown; cwd?: string; timeoutMs?: number };
      const cmd = String(a?.command ?? '?');
      const rest = Array.isArray(a?.args) ? a.args.map(String) : [];
      const full = [cmd, ...rest].join(' ');
      const cwd = a?.cwd ?? defaultCwd;
      const timeout = Math.min(a?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      const lines = [`将执行：${full}`, `工作目录：${cwd}`, `超时：${timeout} ms`];

      // 提示这条命令大概会做什么 —— 用户看到 `rm -rf` 和看到 `git status`
      // 的判断是完全不同的，所以要把风险差异体现出来
      const risky = detectRisk(cmd, rest);
      if (risky.length > 0) {
        lines.push(`⚠️ 风险提示：${risky.join('；')}`);
      } else if (LIKELY_READONLY.includes(cmd)) {
        lines.push('（看起来是只读命令）');
      }
      return lines.join('\n');
    },
    async execute(args: unknown, ctx: ToolContext) {
      const a = args as {
        command?: string;
        args?: unknown;
        cwd?: string;
        timeoutMs?: number;
      };

      if (typeof a?.command !== 'string' || a.command.trim().length === 0) {
        return { ok: false, output: '参数错误：command 必须是非空字符串', isError: true, durationMs: 0 };
      }
      if (a.args !== undefined && !Array.isArray(a.args)) {
        return { ok: false, output: '参数错误：args 必须是字符串数组', isError: true, durationMs: 0 };
      }
      if (!exec.supported) {
        return {
          ok: false,
          output: '当前环境不支持执行命令（浏览器环境无子进程）。这是如实降级，不是错误。',
          isError: true,
          durationMs: 0,
        };
      }

      const argv = Array.isArray(a.args) ? a.args.map(String) : [];
      const cwd = typeof a.cwd === 'string' && a.cwd.length > 0 ? a.cwd : defaultCwd;
      const timeoutMs = Math.min(
        typeof a.timeoutMs === 'number' && a.timeoutMs > 0 ? a.timeoutMs : DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );

      const started = ctx.clock.now();
      try {
        const r = await exec.run({
          command: a.command,
          args: argv,
          cwd,
          timeoutMs,
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        });

        if (r.timedOut) {
          return {
            ok: false,
            output:
              `命令超时（${timeoutMs} ms）已被终止：${[a.command, ...argv].join(' ')}\n` +
              `部分输出：\n${r.stdout.slice(0, 2000)}`,
            isError: true,
            durationMs: ctx.clock.now() - started,
          };
        }

        const parts: string[] = [];
        parts.push(`退出码：${r.exitCode}`);
        if (r.stdout.length > 0) parts.push(`标准输出：\n${r.stdout}`);
        if (r.stderr.length > 0) parts.push(`标准错误：\n${r.stderr}`);
        if (r.truncated) parts.push('（输出超过上限已截断）');
        if (r.stdout.length === 0 && r.stderr.length === 0) parts.push('（无输出）');

        return {
          ok: r.exitCode === 0,
          output: parts.join('\n\n'),
          data: {
            exitCode: r.exitCode,
            command: a.command,
            args: argv,
            cwd,
            truncated: r.truncated,
          },
          isError: r.exitCode !== 0,
          durationMs: ctx.clock.now() - started,
        };
      } catch (err) {
        const message =
          err instanceof ExecError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          ok: false,
          output: `无法执行：${message}`,
          isError: true,
          durationMs: ctx.clock.now() - started,
        };
      }
    },
  };
}

/**
 * 粗判命令的风险点，供预览提示。
 *
 * ⚠️ 这**不是**安全闸门 —— 闸门是分级 + 用户确认。
 *    这里只是把"用户可能没注意到的危险"说出来，帮人做判断。
 *    真正的拦截不依赖这个函数，否则它就是可以被绕过的单点。
 */
export function detectRisk(command: string, args: readonly string[]): readonly string[] {
  const risks: string[] = [];
  const joined = [command, ...args].join(' ');
  const cmd = command.toLowerCase();

  if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'del') {
    risks.push('删除文件');
    if (args.some((x) => x.includes('r') && x.startsWith('-')) || joined.includes('-rf')) {
      risks.push('递归强制删除，不可恢复');
    }
  }
  if (cmd === 'git' && args[0] === 'push' && joined.includes('--force')) {
    risks.push('强制推送会重写远端历史');
  }
  if (cmd === 'git' && (args[0] === 'reset' || args[0] === 'clean')) {
    risks.push('会丢弃未提交的改动');
  }
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') {
    if (args[0] === 'publish') risks.push('发布到公共仓库');
    if (args[0] === 'install' || args[0] === 'add') risks.push('会执行依赖的安装脚本');
  }
  if (cmd === 'curl' || cmd === 'wget') risks.push('会发起网络请求');
  if (cmd === 'chmod' || cmd === 'chown' || cmd === 'icacls') risks.push('修改权限');
  if (cmd === 'shutdown' || cmd === 'reboot') risks.push('影响系统运行');
  if (cmd.includes('format') || cmd.includes('mkfs')) risks.push('格式化磁盘');

  return risks;
}
