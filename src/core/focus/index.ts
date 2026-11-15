/**
 * 专注空间的数据层。
 *
 * 与 `core/tasks`（定时任务）刻意分开导出：
 * 专注日程不进入用户任务服务，也不被任何调度器读取。
 */

export { FocusScheduleService } from './service.js';
export { loadFocusSchedules, saveFocusSchedules, FOCUS_SCHEDULES_FILE } from './store.js';
export type {
  FocusSchedule,
  FocusScheduleCreateInput,
  FocusScheduleState,
  FocusScheduleUpdateInput,
} from './types.js';
