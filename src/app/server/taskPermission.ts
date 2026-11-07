/**
 * 用户任务专用的权限策略。
 *
 * 自动任务运行时不问用户：
 *   · read-only：只开只读
 *   · workspace：只读 + 普通写（再由路径守卫限制在工作区）
 *   · full：全部档位，包括 dangerous；模型自行判断
 *
 * 这不是普通聊天的权限策略；它只注入到单次工作任务，
 * 不能把用户的全局设置改掉。
 */

import type { ActionTier, Authorization, PermissionMode, PermissionPolicy } from '@/core/tools/types.js';
import type { UserTaskPermission } from '@/core/tasks/types.js';

const ALL_TIERS: readonly ActionTier[] = ['readOnly', 'normal', 'highRisk', 'dangerous'];

export class TaskPermissionPolicy implements PermissionPolicy {
  readonly mode: PermissionMode;

  constructor(readonly permission: UserTaskPermission) {
    this.mode = permission === 'full' ? 'full' : permission === 'workspace' ? 'workspace' : 'view';
  }

  isRemembered(): boolean {
    return false;
  }

  isTierEnabled(tier: ActionTier): boolean {
    if (this.permission === 'full') return ALL_TIERS.includes(tier);
    if (this.permission === 'workspace') return tier === 'readOnly' || tier === 'normal';
    return tier === 'readOnly';
  }

  /**
   * 自动任务无人确认；策略直接放行已经开启的档位。
   * 未开启的档位在 ToolFramework 里会先被 blocked，不会走到这里。
   */
  async ask(): Promise<Exclude<Authorization, 'blocked'>> {
    return 'allow';
  }
}
