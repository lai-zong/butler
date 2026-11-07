/**
 * 桌宠 → Web 的“聚焦到某条会话”请求。
 *
 * 桌宠不能直接控制浏览器标签页；这里放一个很短的进程内队列：
 *   桌宠 POST 一个 sessionId
 *   已打开的 Web 页面轮询 GET，取走后自己 loadSession + 改 URL
 *   桌宠再用 Win32 把已有浏览器窗口提到前台
 *
 * 请求只保留很短时间，且 GET 取走即清空；没有 Web 页面消费时自动过期，
 * 不会无限堆积。它是单用户本地应用的展示投影，不是跨用户消息队列。
 */

export interface PetFocusRequest {
  readonly sessionId: string;
  readonly requestedAt: number;
}

const TTL_MS = 15_000;

interface FocusStore {
  pending: PetFocusRequest | null;
}

const globalKey = '__butlerPetFocusStore';
const holder = globalThis as typeof globalThis & {
  [globalKey]?: FocusStore;
};
const store: FocusStore = holder[globalKey] ?? { pending: null };
holder[globalKey] = store;

export function requestPetFocus(sessionId: string, now = Date.now()): PetFocusRequest {
  const request = { sessionId, requestedAt: now };
  store.pending = request;
  return request;
}

/**
 * 取走待处理请求。过期的请求视为没有。
 * 只允许一个 Web 页面消费；后到的轮询不会重复跳转。
 */
export function takePetFocus(now = Date.now()): PetFocusRequest | null {
  const pending = store.pending;
  if (pending === null) return null;
  if (now - pending.requestedAt > TTL_MS) {
    store.pending = null;
    return null;
  }
  store.pending = null;
  return pending;
}

export function clearPetFocus(): void {
  store.pending = null;
}

export const PET_FOCUS_TTL_MS = TTL_MS;
