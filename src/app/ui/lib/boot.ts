/**
 * 启动门状态 —— 只用真实加载单元计算，不依赖计时器。
 *
 * 单元顺序：
 *   界面挂载 → overview 就绪 → 会话列表就绪 → 首个会话就绪 → 可交互
 *
 * 进度只用于表达“已经完成了哪些真实步骤”，不是动画时长。
 */

export type ChatBootPhase = 'sessions' | 'session';

export type ChatBootState =
  | { readonly state: 'loading'; readonly phase: ChatBootPhase }
  | { readonly state: 'ready' }
  | { readonly state: 'error'; readonly error: string };

export interface BootStatus {
  readonly progress: number;
  readonly stage: string;
  readonly ready: boolean;
  readonly error: string | null;
}

export interface BootStatusInput {
  readonly hydrated: boolean;
  readonly chat: ChatBootState;
  readonly timedOut?: boolean;
  /**
   * @deprecated 总览不再参与启动门。保留字段只为兼容旧调用方；
   * 总览慢/失败不应阻止用户进入工作台。
   */
  readonly overview?: 'loading' | 'ready' | 'error';
  /** @deprecated 同上。 */
  readonly overviewError?: string | null;
}

const INITIAL_PROGRESS = 0.05;

export function computeBootStatus(input: BootStatusInput): BootStatus {
  // ★ 总览是旁路数据：它慢/失败只显示横幅，不阻塞启动门。
  const error =
    (input.chat.state === 'error' ? input.chat.error : null) ??
    (input.timedOut === true ? '启动时间超过 30 秒，请重试' : null);

  if (error !== null) {
    return {
      progress: INITIAL_PROGRESS,
      stage: '启动失败',
      ready: false,
      error,
    };
  }

  if (!input.hydrated) {
    return { progress: INITIAL_PROGRESS, stage: '正在加载界面', ready: false, error: null };
  }

  if (input.chat.state === 'ready') {
    return { progress: 1, stage: '进入工作台', ready: true, error: null };
  }

  if (input.chat.state === 'error') {
    return { progress: 0.8, stage: '启动失败', ready: false, error: input.chat.error };
  }

  if (input.chat.phase === 'session') {
    return { progress: 0.8, stage: '正在恢复最近对话', ready: false, error: null };
  }

  return { progress: 0.55, stage: '正在恢复会话', ready: false, error: null };
}
