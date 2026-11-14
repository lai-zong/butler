/**
 * 桌宠主动说话的进程内串行锁。
 *
 * 多个标签页可能同时轮询 claim；如果两边同时读到“今天还没说过”，
 * 会各自说一次，频率上限就被绕过了。这里把 claim / feedback 的
 * 读-判断-写串起来，保证同一时刻只有一个领取者。
 *
 * 仅本机单进程使用；不把它包装成分布式锁。
 */

const LOCK_KEY = '__butlerPetProactiveChain';

export function withPetProactiveLock<T>(task: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const previous = (g[LOCK_KEY] as Promise<unknown> | undefined) ?? Promise.resolve();
  const next = previous.then(task, task);
  g[LOCK_KEY] = next.catch(() => undefined);
  return next;
}
