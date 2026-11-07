/**
 * 用户自己的定时任务（提醒 / 工作）。
 *
 * 与 `core/schedule` 的系统内置任务分开：
 *   · 这里的数据由用户创建、编辑、删除；
 *   · 内置任务继续由设置里的「自动化」管理；
 *   · 两边共用事件流作为运行记录，但任务定义不混在一起。
 */

export type UserTaskKind = 'reminder' | 'work';
export type UserTaskRepeat = 'once' | 'daily' | 'weekly';
export type UserTaskStatus = 'active' | 'paused' | 'completed';
export type UserTaskPermission = 'read-only' | 'workspace' | 'full';

export interface UserTaskSchedule {
  readonly repeat: UserTaskRepeat;
  /** once 使用；绝对毫秒时间戳 */
  readonly dueAt: number | null;
  /** daily / weekly 使用，HH:mm */
  readonly timeOfDay: string | null;
  /** weekly 使用，0=周日 */
  readonly weekday: number | null;
}

export interface UserTaskModelChoice {
  readonly profileId: string;
  readonly modelId: string;
  readonly label: string;
}

export interface UserTask {
  readonly id: string;
  readonly kind: UserTaskKind;
  readonly title: string;
  readonly note: string;
  readonly schedule: UserTaskSchedule;
  readonly status: UserTaskStatus;
  /** 下一次应该触发的时间；完成后为 null */
  readonly nextRunAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;

  /** 工作专用；提醒为 null */
  readonly instruction: string | null;
  /** 工作专用；空表示程序默认工作区 */
  readonly workspace: string | null;
  /** 工作专用；注意 full 是任务级完全权限 */
  readonly permission: UserTaskPermission;
  /** 工作专用；null 表示跟随当前对话模型 */
  readonly model: UserTaskModelChoice | null;
  /** 参考文件路径，仅作为执行提示；真正权限仍由工具层判断 */
  readonly files: readonly string[];

  /** 提醒专用：用户点“稍后”后的时间 */
  readonly snoozeUntil: number | null;
  /** 提醒专用：用户完成后标记 */
  readonly completedAt: number | null;

  /** 最近一次运行结果 */
  readonly lastRunAt: number | null;
  readonly lastOutcome: 'succeeded' | 'failed' | 'skipped' | null;
  readonly lastSummary: string | null;
  readonly lastError: string | null;
}

export type UserTaskCreateInput = {
  readonly kind: UserTaskKind;
  readonly title: string;
  readonly note?: string;
  readonly schedule: UserTaskSchedule;
  readonly status?: UserTaskStatus;
  readonly instruction?: string | null;
  readonly workspace?: string | null;
  readonly permission?: UserTaskPermission;
  readonly model?: UserTaskModelChoice | null;
  readonly files?: readonly string[];
};

export type UserTaskUpdateInput = {
  readonly title?: string;
  readonly note?: string;
  readonly schedule?: UserTaskSchedule;
  readonly status?: UserTaskStatus;
  readonly instruction?: string | null;
  readonly workspace?: string | null;
  readonly permission?: UserTaskPermission;
  readonly model?: UserTaskModelChoice | null;
  readonly files?: readonly string[];
};

export interface UserTaskView extends UserTask {
  /** 当前是否已经到期，前端据此显示提醒/逾期状态 */
  readonly due: boolean;
}

export type WorkTaskResult =
  | { readonly outcome: 'succeeded'; readonly summary: string }
  | { readonly outcome: 'failed'; readonly summary: string; readonly error?: string };

export type WorkTaskRunner = (task: UserTask) => Promise<WorkTaskResult>;
