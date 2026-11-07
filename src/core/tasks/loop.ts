/**
 * 用户工作任务循环。
 *
 * 与系统内置调度器分开；只负责 tick 用户任务。
 * 使用 globalThis 防 Next 热重载重复注册；unref 防止进程被 timer 挂住。
 */

import type { UserTaskService } from './service.js';

const LOOP_KEY = '__butlerUserTaskLoop';

interface LoopHandle {
  stop(): void;
}

interface GlobalWithLoop {
  __butlerUserTaskLoop?: LoopHandle;
}

export function startUserTaskLoop(args: {
  readonly service: UserTaskService;
  readonly intervalMs?: number;
  readonly onError?: (err: unknown) => void;
}): { stop(): void } {
  const scope = globalThis as typeof globalThis & GlobalWithLoop;
  const existing = scope[LOOP_KEY];
  if (existing !== undefined) return existing;

  const timer = setInterval(() => {
    void args.service.tick().catch((err) => args.onError?.(err));
  }, args.intervalMs ?? 60_000);
  timer.unref?.();

  const handle: LoopHandle = {
    stop(): void {
      clearInterval(timer);
      delete scope[LOOP_KEY];
    },
  };
  scope[LOOP_KEY] = handle;
  return handle;
}

export function stopUserTaskLoop(): void {
  const scope = globalThis as typeof globalThis & GlobalWithLoop;
  scope[LOOP_KEY]?.stop();
  delete scope[LOOP_KEY];
}
