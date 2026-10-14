/**
 * 端口 · 命令执行
 *
 * 设计依据：方案 § 6.1（三层能力模型）、ADR 0004
 *
 * 核心层要执行命令，但不能直接 `child_process` —— 那会把核心逻辑绑死在 Node 上，
 * 而且无法测试。用端口抽象出来后：
 *   · Node 侧由 adapters/exec/node.ts 实现
 *   · 测试用 adapters/exec/fake.ts（预设输出，不真跑命令）
 *   · 浏览器侧可以返回"不支持"（诚实降级，而不是假装能做）
 *
 * ⚠️ 这是**风险最高的一个端口**：它能执行任意命令。
 *    所以它的接口刻意做得"不自由"：
 *    · 必须传超时
 *    · 必须传工作目录
 *    · 返回值区分退出码与超时，不允许"静默成功"
 */

export interface ExecRequest {
  /** 可执行文件（不要用 shell 字符串拼接） */
  readonly command: string;
  readonly args: readonly string[];
  /** 工作目录 */
  readonly cwd: string;
  /** 超时（毫秒）。必须显式给出，避免命令挂死拖垮会话。 */
  readonly timeoutMs: number;
  /** 环境变量增量（不替换整个环境） */
  readonly env?: Readonly<Record<string, string>>;
  /** 标准输入（可选） */
  readonly stdin?: string;
  /** 输出上限（字节），超过则截断 —— 防止 `cat` 一个巨型文件把上下文撑爆 */
  readonly maxOutputBytes?: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** 是否因超时被终止 */
  readonly timedOut: boolean;
  /** 输出是否被截断 */
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface ExecPort {
  /**
   * 执行命令。
   *
   * ⚠️ 实现**不得**抛出未捕获异常来表示"命令失败" ——
   *    非零退出码是正常结果，要如实返回 exitCode。
   *    只有"根本没能启动"才抛错。
   */
  run(req: ExecRequest): Promise<ExecResult>;

  /** 该环境是否支持执行命令（浏览器里为 false，诚实降级）。 */
  readonly supported: boolean;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_SUPPORTED' | 'SPAWN_FAILED' | 'INVALID_REQUEST',
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

/** 默认输出上限：256 KiB。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** 默认超时：15 秒。 */
export const DEFAULT_TIMEOUT_MS = 15_000;
