/**
 * 全局 Web 权限策略。
 *
 * 实际的 Web 会话使用不可变的 SessionPermissionPolicy；本类负责：
 *   · 从设置恢复 mode / confirmActions；
 *   · 作为运行时全局工具框架的默认策略；
 *   · 在没有 asker 且关闭确认时，按 mode 放行；
 *   · dangerous 永远拒绝。
 *
 * 需要弹窗确认时，聊天路由会注入 SseApprovals，框架优先走 asker；
 * 不设超时，流结束时只 deny 本轮 asker 自己的 pending。
 */

import type { ActionTier, PermissionMode, PermissionPolicy } from '@/core/tools/types.js';

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
  /** C5 三档模式；不填时保持旧的 allowWrite 行为。 */
  readonly mode?: PermissionMode;
  /**
   * true=需要确认时走弹窗；false=按权限模式直接执行。
   * dangerous 仍由 isTierEnabled 永远拒绝。
   */
  readonly confirmActions?: boolean;
}

export class WebPermissionPolicy implements PermissionPolicy {
  private readonly remembered = new Set<string>();
  mode: PermissionMode | undefined;
  confirmActions: boolean;
  private readonly allowWrite: boolean;

  constructor(opts?: WebPolicyOptions) {
    this.allowWrite = opts?.allowWrite ?? false;
    this.mode = opts?.mode;
    this.confirmActions = opts?.confirmActions ?? true;
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
  setMode(mode: PermissionMode | undefined): void {
    this.mode = mode;
  }

  isTierEnabled(tier: ActionTier): boolean {
    if (tier === 'dangerous') return false;
    if (this.mode === 'view') return tier === 'readOnly';
    if (this.mode === 'workspace') return tier === 'readOnly' || tier === 'normal';
    if (this.mode === 'full') return tier === 'readOnly' || tier === 'normal' || tier === 'highRisk';
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
   *
   * 关闭确认时，normal/highRisk 在权限模式允许的前提下直接放行；
   * dangerous 已在 isTierEnabled 被拒，到不了这里。
   */
  async ask(request: { readonly tier: ActionTier }): Promise<'allow' | 'deny'> {
    if (!this.confirmActions && this.isTierEnabled(request.tier)) return 'allow';
    return 'deny';
  }

  setConfirmActions(value: boolean): void {
    this.confirmActions = value;
  }
}
