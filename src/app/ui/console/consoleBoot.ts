/**
 * 控制台启动状态 —— 与启动门同一原则：进度只由真实步骤推进。
 *
 * 首次打开：
 *   点击 → 动态模块加载 → Shell 挂载 → 当前分区首次取数结束 → 就绪
 * 二次打开：
 *   已挂载且已有数据，直接就绪；只播“从中间打开”的短动画，不展示内容层。
 */

export type ConsoleBootMode = 'first' | 'quick';

export interface ConsoleBootStatus {
  readonly progress: number;
  readonly stage: string;
  readonly ready: boolean;
}

export interface ConsoleBootInput {
  readonly mode: ConsoleBootMode;
  readonly mounted: boolean;
  readonly shellMounted: boolean;
  readonly dataReady: boolean;
  readonly timedOut?: boolean;
}

export function computeConsoleBootStatus(input: ConsoleBootInput): ConsoleBootStatus {
  if (input.mode === 'quick' && input.mounted) {
    return { progress: 1, stage: '返回控制台', ready: true };
  }

  if (!input.mounted) {
    return { progress: 0, stage: '启动控制台', ready: false };
  }

  if (input.timedOut === true) {
    return { progress: 0.95, stage: '响应较慢，先行进入', ready: true };
  }

  if (!input.shellMounted) {
    return { progress: 0.18, stage: '启动控制台', ready: false };
  }

  if (!input.dataReady) {
    return { progress: 0.8, stage: '准备控制台', ready: false };
  }

  return { progress: 1, stage: '控制台已就绪', ready: true };
}
