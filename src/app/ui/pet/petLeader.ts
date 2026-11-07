/**
 * Web 桌宠的“单标签页”选举
 *
 * ★ 为什么必须选举：
 *   Web 桌宠挂在全局布局上，多开几个标签页就会出现几只桌宠；
 *   更糟的是两个标签页可能同时往同一个固定会话发消息。
 *
 * ★ 首选 Web Locks：
 *   锁的生命周期由浏览器管理 —— 标签页关闭、崩溃、被冻结时自动释放，
 *   排队的下一个标签页立刻接手。不需要心跳，也不会出现“死锁住的
 *   leader 永远占着位置”。
 *
 * ★ 降级到 localStorage 租约：
 *   老浏览器没有 navigator.locks 时，用「带过期时间的租约 + 心跳」
 *   近似同一语义。它不能完全避免竞态，但能让“同一时刻基本只有一只”。
 */

const LOCK_NAME = 'butler.webpet.leader.v1';
const FALLBACK_KEY = 'butler.webpet.leader.lease.v1';
const FALLBACK_CHANNEL = 'butler.webpet.leader.v1';
const LEASE_MS = 5_000;
const HEARTBEAT_MS = 1_500;

interface LockManagerLike {
  request<T>(
    name: string,
    options: { readonly mode?: 'exclusive' | 'shared'; readonly signal?: AbortSignal },
    callback: () => Promise<T> | T,
  ): Promise<T>;
}

function lockManager(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { readonly locks?: LockManagerLike }).locks;
  return locks !== undefined && typeof locks.request === 'function' ? locks : null;
}

function makeId(): string {
  try {
    return `tab_${crypto.randomUUID()}`;
  } catch {
    return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

interface Lease {
  readonly id: string;
  readonly at: number;
}

function readLease(): Lease | null {
  try {
    const raw = window.localStorage.getItem(FALLBACK_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec['id'] !== 'string' || typeof rec['at'] !== 'number') return null;
    return { id: rec['id'], at: rec['at'] };
  } catch {
    return null;
  }
}

function writeLease(id: string): void {
  try {
    window.localStorage.setItem(FALLBACK_KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // 隐私模式 / 禁用 storage：没有降级选举，也只能单标签页使用。
  }
}

function startFallbackLeadership(onChange: (leader: boolean) => void): () => void {
  const id = makeId();
  let leader = false;
  let disposed = false;
  let channel: BroadcastChannel | null = null;

  try {
    if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(FALLBACK_CHANNEL);
  } catch {
    channel = null;
  }

  const publish = (): void => writeLease(id);

  const evaluate = (): void => {
    if (disposed) return;
    const lease = readLease();
    const fresh = lease !== null && Date.now() - lease.at < LEASE_MS;
    if (!fresh || (lease !== null && lease.id === id)) {
      publish();
      // 写完再读一次：两个标签页同时抢时，以最后写入者为准。
      const mine = readLease()?.id === id;
      if (mine !== leader) {
        leader = mine;
        onChange(mine);
      }
      return;
    }
    if (leader) {
      leader = false;
      onChange(false);
    }
  };

  evaluate();
  const timer = window.setInterval(evaluate, HEARTBEAT_MS);

  const onStorage = (event: StorageEvent): void => {
    if (event.key === FALLBACK_KEY) evaluate();
  };
  window.addEventListener('storage', onStorage);

  const onMessage = (): void => evaluate();
  channel?.addEventListener('message', onMessage);

  const onPageHide = (): void => {
    if (readLease()?.id !== id) return;
    try {
      window.localStorage.removeItem(FALLBACK_KEY);
    } catch {
      // 忽略
    }
    channel?.postMessage({ type: 'release', id });
  };
  window.addEventListener('pagehide', onPageHide);

  return () => {
    if (disposed) return;
    disposed = true;
    window.clearInterval(timer);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('pagehide', onPageHide);
    channel?.removeEventListener('message', onMessage);
    if (leader && readLease()?.id === id) {
      try {
        window.localStorage.removeItem(FALLBACK_KEY);
      } catch {
        // 忽略
      }
    }
    channel?.postMessage({ type: 'release', id });
    channel?.close();
    if (leader) {
      leader = false;
      onChange(false);
    }
  };
}

/**
 * 申请成为唯一显示 Web 桌宠的标签页。
 *
 * @param onChange 领导权变化时回调；首次获得/失去都会收到。
 * @returns 释放函数（组件卸载时调用）。
 */
export function acquirePetLeadership(onChange: (leader: boolean) => void): () => void {
  const locks = lockManager();
  if (locks === null) return startFallbackLeadership(onChange);

  const controller = new AbortController();
  let releaseHold: (() => void) | null = null;
  let disposed = false;

  try {
    void locks
      .request(LOCK_NAME, { mode: 'exclusive', signal: controller.signal }, () => {
        if (disposed) return undefined;
        onChange(true);
        return new Promise<void>((resolve) => {
          releaseHold = resolve;
        });
      })
      .catch(() => {
        // 排队期间被 abort 是正常的卸载路径，不需要降级或报错。
      });
  } catch {
    return startFallbackLeadership(onChange);
  }

  return () => {
    if (disposed) return;
    disposed = true;
    releaseHold?.();
    controller.abort();
  };
}
