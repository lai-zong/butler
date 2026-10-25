/**
 * 操作范围熔断（方案 §11 第三层）
 *
 * 与 D-43 的“成本额度”不是一回事：
 *   · 成本额度：花多少钱；
 *   · 范围熔断：单位时间内发生了多少次**会改变系统状态**的动作。
 *
 * 当前按“非 readOnly 工具调用次数”计数。文件写入、命令执行、桌面写操作
 * 都属于这一类；只读枚举/查询不算。
 *
 * ⚠️ 这是**确定性防线**，不是靠模型自律。阈值触发后必须真的拒绝下一次调用，
 *    并在审计里留下 action.blocked。
 */

export interface ToolFuseOptions {
  /** 统计窗口（毫秒） */
  readonly windowMs: number;
  /** 窗口内允许的非只读调用次数 */
  readonly maxWrites: number;
}

export const DEFAULT_TOOL_FUSE: ToolFuseOptions = {
  windowMs: 60_000,
  maxWrites: 30,
};

export class ToolFuse {
  private readonly windowMs: number;
  private readonly maxWrites: number;
  private readonly timestamps: number[] = [];

  constructor(options: Partial<ToolFuseOptions> = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_TOOL_FUSE.windowMs;
    this.maxWrites = options.maxWrites ?? DEFAULT_TOOL_FUSE.maxWrites;
  }

  /**
   * 当前窗口还允许一次非只读调用吗？
   *
   * 只检查，不记账 —— 调用方确认真正执行后再 `record`。
   * 这样“授权被拒/执行失败”不会消耗熔断额度。
   */
  allows(now: number): boolean {
    this.prune(now);
    return this.timestamps.length < this.maxWrites;
  }

  /** 记录一次真正要执行的非只读调用。 */
  record(now: number): void {
    this.prune(now);
    this.timestamps.push(now);
  }

  /** 当前窗口内已记录次数（测试/诊断用）。 */
  count(now: number): number {
    this.prune(now);
    return this.timestamps.length;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }
}
