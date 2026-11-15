/**
 * 专注空间的日程 —— 与「定时任务」完全独立的一类数据。
 *
 * ★ 为什么单独建模，而不是复用 user-tasks：
 *   · 定时任务带 kind / repeat / 工作区 / 权限 / 模型，语义是「到点让管家做事」；
 *   · 专注日程只有一件事：用户在某个时间段里想做什么，
 *     它不进入调度器、不触发 AI、不写 user-tasks.json。
 *   两张表混在一起后，任何一次字段扩展都会让两边互相将就。
 *
 * ★ 时间用绝对毫秒时间戳，保存「开始」与「结束」两个点；
 *   不做重复规则，也不做「全天 / 周视图」这类派生结构。
 */

export interface FocusSchedule {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  /** 开始时间（毫秒时间戳，本地时区解释） */
  readonly startAt: number;
  /** 结束时间（毫秒时间戳）；必须晚于 startAt */
  readonly endAt: number;
  /** 到点是否在专注空间里提醒；提醒只在页面打开时由客户端检查 */
  readonly remind: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 磁盘上的完整状态：日程列表 + 当前安排。 */
export interface FocusScheduleState {
  readonly version: 1;
  readonly currentId: string | null;
  readonly schedules: readonly FocusSchedule[];
}

export interface FocusScheduleCreateInput {
  readonly title: string;
  readonly note?: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly remind?: boolean;
}

export interface FocusScheduleUpdateInput {
  readonly title?: string;
  readonly note?: string;
  readonly startAt?: number;
  readonly endAt?: number;
  readonly remind?: boolean;
}
