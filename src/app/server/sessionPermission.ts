/**
 * 会话级权限策略 —— **不可变模式**，每个会话/每一轮一份
 *
 * ★ 为什么不复用 `WebPermissionPolicy`：
 *   那个类有一个可变的 `mode` 字段，运行时是**所有会话共享一个实例**。
 *   两个并发对话一个设工作区、一个设完全，互相 setMode 就会串味。
 *   本类把档位放在构造函数里（readonly），每个会话工具作用域各建一份。
 *
 * ★ 档位语义（修订后的实际能力）：
 *   · read-only：只允许只读；写/移动/删除/高风险一律拒绝。
 *   · workspace：只读 + 常规写（新建/覆盖文件、建目录）；
 *     **不开放 highRisk**（含 move_path）；路径限制在工作区内。
 *   · full：只读 + 常规写 + 高风险；路径放开到工作区外，
 *     但系统数据/密钥/全局 AGENTS 仍由 NodeFileSystem 与 pathGuard 拒绝。
 *   · 三档都**不**开放 dangerous：`remove_path` 等危险工具始终禁用，
 *     不会因为会话选“完全”就静默放开。
 *
 * ★ 命令执行：
 *   Web 会话的工具作用域**不注册** `run_command`。没有 OS 沙箱时，
 *   路径守卫无法阻止命令内部读取任意路径；宁可不提供该工具，
 *   也不承诺“工作区内执行”却实际可逃逸。`full` 只影响文件工具的路径范围。
 *
 * ★ 逐次确认：
 *   · Web 调用方声明 `supportsApproval:true` 时，normal/highRisk 会弹确认；
 *   · 没有确认通道的客户端（桌宠、直接调用）拿不到 asker，框架回退到
 *     `policy.ask()`：normal 按会话档位授权（显式选择 workspace 即授权写），
 *     **highRisk 一律拒绝**（没有确认通道就不静默执行高风险动作）；
 *   · dangerous 在更早的 tier 门禁被拒，不会到达 ask。
 */

import type { SessionPermission } from '@/core/chat/settings.js';
import type {
  ActionTier,
  Authorization,
  PermissionMode,
  PermissionPolicy,
} from '@/core/tools/types.js';

const READONLY_TIERS: readonly ActionTier[] = ['readOnly'];
const WORKSPACE_TIERS: readonly ActionTier[] = ['readOnly', 'normal'];
const FULL_TIERS: readonly ActionTier[] = ['readOnly', 'normal', 'highRisk'];

export class SessionPermissionPolicy implements PermissionPolicy {
  /** 供 ToolFramework 做档位拦截；与全局策略的 mode 同一套语义。 */
  readonly mode: PermissionMode;
  readonly permission: SessionPermission;

  constructor(permission: SessionPermission) {
    this.permission = permission;
    this.mode =
      permission === 'full' ? 'full' : permission === 'workspace' ? 'workspace' : 'view';
  }

  isRemembered(): boolean {
    return false;
  }

  isTierEnabled(tier: ActionTier): boolean {
    // dangerous 是硬底线：任何会话档位都不开放。
    if (tier === 'dangerous') return false;
    if (this.permission === 'read-only') return READONLY_TIERS.includes(tier);
    if (this.permission === 'workspace') return WORKSPACE_TIERS.includes(tier);
    return FULL_TIERS.includes(tier);
  }

  /**
   * 没有逐轮询问通道时的答案。
   *
   * ★ 只对 normal 放行（会话档位作为显式授权）；
   *   highRisk（移动等）在无确认通道时**拒绝**，不静默执行。
   *   readOnly 正常不会走到 ask；若凭证类工具走到这里，也拒绝。
   *
   * Web 有 asker 时根本不会调用这里，仍然逐次弹确认。
   */
  async ask(request: {
    readonly toolName: string;
    readonly tier: ActionTier;
    readonly args: unknown;
    readonly summary: string;
    readonly preview?: string;
  }): Promise<Exclude<Authorization, 'blocked'>> {
    if (request.tier === 'normal') return 'allow';
    return 'deny';
  }
}
