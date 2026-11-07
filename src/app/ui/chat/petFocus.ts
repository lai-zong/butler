/**
 * 桌宠 → Web 聚焦请求的纯逻辑。
 *
 * 轮询与“什么时候真正切”的状态机放在 ChatView（需要访问当前会话、流式状态和
 * loadSession 的加载序号）；这里放能独立验证的三件事：
 *   · 解析 GET /api/pet/focus 的响应（坏数据一律当没有）
 *   · 判断排队中的请求是否已经被用户手动切走（竞态保护）
 *   · 把 ?session=<id> 写进当前地址，同时保留 hash（#/chat）
 */

export interface PetFocusTarget {
  readonly sessionId: string;
  readonly requestedAt: number;
}

/** 桌宠请求聚焦时，在本页排队的一次跳转。 */
export interface PendingPetFocus {
  readonly sessionId: string;
  readonly seq: number;
  /** 收到请求时用户所在的会话；变了说明用户已经手动切走。 */
  readonly originSessionId: string | null;
  /** 首屏完成前收到的请求：此时还没有用户可切换的会话，不看 origin。 */
  readonly fromBeforeBoot: boolean;
}

/**
 * 收到聚焦请求之后，用户是否已经手动切到了别的会话。
 * 首屏完成前的请求不受此约束 —— 那时 origin 还是 null，不算用户切换。
 */
export function petFocusOriginChanged(
  pending: PendingPetFocus,
  currentSessionId: string | null,
): boolean {
  return !pending.fromBeforeBoot && pending.originSessionId !== currentSessionId;
}

/** 解析 `{ ok: true, focus: { sessionId, requestedAt } | null }`。 */
export function parsePetFocusPayload(payload: unknown): PetFocusTarget | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record['ok'] !== true) return null;
  const focus = record['focus'];
  if (typeof focus !== 'object' || focus === null) return null;
  const focusRecord = focus as Record<string, unknown>;
  const rawId = focusRecord['sessionId'];
  if (typeof rawId !== 'string') return null;
  const sessionId = rawId.trim();
  if (sessionId.length === 0) return null;
  const rawRequestedAt = focusRecord['requestedAt'];
  const requestedAt =
    typeof rawRequestedAt === 'number' && Number.isFinite(rawRequestedAt) ? rawRequestedAt : 0;
  return { sessionId, requestedAt };
}

/**
 * 返回带 `?session=<id>` 的相对地址，保留其余 query 与 hash。
 *
 * 用相对地址喂给 history.replaceState：不跳转、不新开标签页，也不会把
 * 当前 origin 之外的东西写进地址栏。
 */
export function withSessionParam(href: string, sessionId: string): string {
  const url = new URL(href);
  url.searchParams.set('session', sessionId);
  return `${url.pathname}${url.search}${url.hash}`;
}
