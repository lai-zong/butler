/**
 * Web 界面的权限策略 —— 把「需要用户确认」变成**可见的待办**，而不是挂住
 *
 * ★★ 这里要解决一个真实的架构矛盾：
 *
 *   工具闸门的设计是「需要确认时**阻塞等待**用户回答」（`ask` 返回 Promise）。
 *   而 Web 界面走的是 **SSE 流式响应** —— 请求已经在流式传输中，
 *   **没法中途停下来等用户点确认**。
 *
 *   ⚠️ 若不处理这个矛盾，两种坏结果二选一：
 *     · 直接 `allow` → 写操作静默执行，安全闸门形同虚设
 *     · 直接挂住等确认 → 用户永远等不到，请求超时
 *
 * ★ 本策略的选择：**只读放行，其余拒绝并如实告知**。
 *
 *   实测依据（方案 § 6.1 的三层能力模型里，日常任务绝大多数是只读的）：
 *     · `read_file` / `list_dir` / `stat_path` / `search` → readOnly，放行
 *     · `write_file` / `exec` → normal/highRisk，**拒绝**
 *
 *   ⚠️ 拒绝不是"失败"：它会在界面上显示成一张**明确的拒绝结果**，
 *      用户看得见"它想做什么、被什么挡住了"。这比静默放行安全，
 *      也比挂住等确认可用。
 *
 * ★ 待做（这一步没做完，如实标注）：
 *   真正的方案是**把确认变成异步的**：工具调用挂起 → SSE 推一个确认请求
 *   → 用户在界面上点 → 另一个端点把答复送回 → 工具继续执行。
 *   那需要给 ToolFramework 加一个"可恢复的挂起"机制，
 *   属于独立的一步，不在这里草率实现。
 */

import type { ActionTier, PermissionPolicy } from '@/core/tools/types.js';

export interface WebPolicyOptions {
  /**
   * 是否允许写操作（`normal` 及以上）。
   *
   * ⚠️ 默认 **false**。理由见文件头：Web 的 SSE 响应没法中途等确认，
   *    而"静默放行写操作"会让安全闸门形同虚设。
   *
   *   设为 true 需要用户明确知道自己在做什么（例如本地单人使用、
   *   且已理解写操作不会被逐一确认）。
   */
  readonly allowWrite?: boolean;
}

export class WebPermissionPolicy implements PermissionPolicy {
  private readonly remembered = new Set<string>();
  private readonly allowWrite: boolean;

  constructor(opts?: WebPolicyOptions) {
    this.allowWrite = opts?.allowWrite ?? false;
  }

  isRemembered(toolName: string): boolean {
    return this.remembered.has(toolName);
  }

  /**
   * 该级别是否开启。
   *
   * ⚠️ `dangerous` **永远不放行** —— 那是方案 § 11 第三层防护的硬底线
   *    （"危险操作默认禁用"），不该由这个策略决定。
   */
  isTierEnabled(tier: ActionTier): boolean {
    if (tier === 'dangerous') return false;
    if (tier === 'readOnly') return true;
    return this.allowWrite;
  }

  /**
   * 「询问用户」在 SSE 场景下无法真正询问 —— 所以这里**直接拒绝**。
   *
   * ⚠️ 关键：返回 `'deny'` 而不是 `'allow'`。
   *    返回 allow 会让「写文件」这类操作在用户毫不知情的情况下执行。
   *
   * ★ 拒绝会在界面上呈现为一张明确的拒绝结果，带工具名与参数 ——
   *   用户看得见"它想做什么"。这就是"可见"与"可控"的平衡点：
   *   **不放行，但也不隐瞒。**
   */
  async ask(): Promise<'deny'> {
    return 'deny';
  }
}
