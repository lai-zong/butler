/**
 * 工具框架 —— 契约与安全闸门
 *
 * 设计依据：方案 § 6（操作能力）、§ 11（三层安全防护·动作侧）
 *
 * ★ 核心纪律：**权限判定在核心层强制执行，不交给调用方自觉。**
 *
 *   理由与"硬约束机械校验"完全一样：
 *   如果由编排层负责检查权限，那么只要有一条调用路径忘了检查，
 *   安全就破了。而工具是**唯一能让 AI 对外部世界产生副作用**的出口，
 *   这个出口必须只有一条路可走，且那条路上有闸门。
 *
 *   所以：任何工具调用都必须经过 `ToolFramework.execute()`，
 *   而它**没有**"跳过检查"的开关。
 */

import type { ClockPort } from '../ports/clock.js';

// ═══════════════════════════════════════════════════════════
// 动作分级（方案 § 11 第三层）
// ═══════════════════════════════════════════════════════════

/**
 * 动作分级 —— 决定需要什么级别的授权。
 *
 * 分级依据是**后果的不可逆程度**，不是"看起来危险不危险"。
 * 读一个文件看起来人畜无害，但如果那个文件是私钥，后果比删一个临时文件严重得多 ——
 * 所以凭证类读取得单独标记（见 ToolSpec.touchesCredentials）。
 */
export type ActionTier =
  | 'readOnly' // 只读，不影响系统状态
  | 'normal' // 常规变更，可撤销
  | 'highRisk' // 高风险，难以撤销或影响面广
  | 'dangerous'; // 危险且不可逆，**默认禁用**

/** 授权决定。 */
export type Authorization =
  | 'allow' // 放行（本会话已记住，或策略配置为自动放行）
  | 'deny' // 拒绝
  | 'ask' // 询问用户
  | 'blocked'; // 该级别默认禁用，需用户在设置里显式开启

/**
 * 权限策略。由应用层实现 —— 它可以弹出确认框、查配置、查会话记忆。
 *
 * ⚠️ 核心层**不假设**策略如何得到答案，只要求答案必须是这四个之一。
 *    这样界面可以问用户、测试可以脚本化、定时任务可以预设，
 *    而安全语义不变。
 */
export interface PermissionPolicy {
  /** 本会话已针对该工具记住的授权（"本次会话允许"） */
  isRemembered(toolName: string): boolean;
  /** 询问用户。只有在决定为 'ask' 时才会被调用。 */
  ask(request: {
    readonly toolName: string;
    readonly tier: ActionTier;
    readonly args: unknown;
    /** 一句话说明这次调用要做什么，供用户判断 */
    readonly summary: string;
    /** 只读预览（如截图、将要删除的文件清单），可能为空 */
    readonly preview?: string;
  }): Promise<Exclude<Authorization, 'blocked'>>;
  /** 该级别是否已被用户在设置里开启（dangerous 默认关闭） */
  isTierEnabled(tier: ActionTier): boolean;
}

// ═══════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════

export interface ToolResult {
  readonly ok: boolean;
  /** 给模型看的结果文本 */
  readonly output: string;
  /** 结构化数据（可选），用于界面渲染或后续处理 */
  readonly data?: unknown;
  readonly isError?: boolean;
  /** 耗时（毫秒） */
  readonly durationMs: number;
}

export interface ToolContext {
  readonly clock: ClockPort;
  /** 本次调用属于哪次任务（用于授权按任务失效） */
  readonly taskId: string;
  /**
   * 本次任务的**自然语言目标**（用户这次要干什么）。
   *
   * ★ 为什么工具需要它：操作记忆按"任务签名"归档（方案 §6.3 ①）。
   *   没有任务文本，就只剩"某工具成功/失败"这种无签名记录 ——
   *   下次无法回答"**这类任务**该用哪种方式"。
   *
   * ⚠️ 可能为空（不是所有调用都来自一趟带目标的会话），
   *    缺失时**不要编造**签名，宁可不记录。
   */
  readonly task?: string;
  /** 工具可主动报告它实际触碰的敏感项，供审计 */
  readonly reportTouch?: (what: string) => void;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema 形态的参数声明（直接喂给模型） */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** 该工具的动作分级 */
  readonly tier: ActionTier;
  /**
   * 桌面动作的**阶梯级**（方案 §9.4 / D-32）。
   *
   * ★ 与 `tier` 是**两个正交的维度**，不要混淆：
   *   - `tier` 回答"要不要用户同意"（只读 / 常规 / 高风险 / 危险）
   *   - `rung` 回答"用什么手段做的"（1 应用接口 / 2 模式调用 / 3 窗口消息 / 4 真实注入）
   *
   * ⚠️ 为什么必须记录它：第 4 级**随分辨率、缩放、主题、语言、界面改版而变**，
   *    与前三级的可靠性不是一个量级。审计里没有这个信息，
   *    事后就无法回答"这次到底是稳稳做的，还是靠模拟输入蒙的"。
   *
   * 只有**真正操作外部程序**的工具才需要填；纯内部工具留空。
   */
  readonly rung?: 1 | 2 | 3 | 4;
  /**
   * 是否会接触凭证（密钥、token、密码）。
   * 这类工具的结果必须脱敏，且不写入长期记忆（方案 § 11 第二层）。
   */
  readonly touchesCredentials?: boolean;
  /**
   * 只读预览：在执行前告诉用户"这次会动到什么"。
   * 高风险操作应当实现它 —— 用户看不到预览就没法真正判断。
   */
  preview?(args: unknown, ctx: ToolContext): Promise<string>;
  /** 一句话摘要，给确认界面用 */
  summarize(args: unknown): string;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// ═══════════════════════════════════════════════════════════
// 错误
// ═══════════════════════════════════════════════════════════

export type ToolDenyReason =
  | 'unknown_tool'
  | 'tier_disabled' // 该级别默认禁用且用户未开启
  | 'user_denied'
  | 'invalid_args'
  | 'execution_failed';

export class ToolError extends Error {
  constructor(
    message: string,
    readonly reason: ToolDenyReason,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

// ═══════════════════════════════════════════════════════════
// 审计记录
// ═══════════════════════════════════════════════════════════

/** 每次工具调用都产生一条 —— 方案 § 11 要求"全量审计"。 */
export interface ToolAudit {
  readonly toolName: string;
  readonly tier: ActionTier;
  readonly taskId: string;
  /** 参数摘要（**已脱敏**） */
  readonly argsSummary: string;
  readonly authorization: Authorization;
  readonly outcome: 'success' | 'error' | 'denied';
  readonly durationMs: number;
  readonly at: number;
  /** 结果摘要（**已脱敏**），便于事后追查做了什么 */
  readonly outputSummary: string;
}
