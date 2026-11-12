/**
 * 浏览器本地网关客户端
 *
 * 输入与画面直连 127.0.0.1 上的轻量网关，绕开 Next dev 每请求 ~45ms 的开销。
 * 网关在同一进程里，读的是同一份浏览器会话，不需要额外同步。
 */

export interface GatewayInfo {
  readonly url: string;
  readonly token: string;
}

export interface GatewayFrame {
  readonly width: number;
  readonly height: number;
  readonly jpeg: Uint8Array;
}

const TOKEN_HEADER = 'x-butler-gateway-token';

/** 读一个 UTF-8 JSON 响应，失败返回 null。 */
export async function loadGatewayInfo(): Promise<GatewayInfo | null> {
  try {
    const res = await fetch('/api/browser/gateway', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { url?: unknown; token?: unknown };
    if (typeof data.url !== 'string' || typeof data.token !== 'string') return null;
    return { url: data.url, token: data.token };
  } catch {
    return null;
  }
}

/**
 * 调一次网关 RPC（导航/标签/状态/读取……）。
 *
 * ★ 这些操作以前走 Next 路由，dev 下每次 ~45ms；网关实测 ~3ms，
 *   关标签/导航这种"点了要立刻有反应"的动作差别非常明显。
 */
export async function gatewayRpc<T>(
  info: GatewayInfo,
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${info.url}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: info.token },
    body: JSON.stringify({ op, args }),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
  if (!res.ok || data === null || data.ok === false) {
    throw new Error(typeof data?.error === 'string' ? data.error : `网关请求失败（${res.status}）`);
  }
  return data as T;
}

/** 发一条输入事件；失败静默（断线由画面流提示）。 */
export async function sendGatewayInput(info: GatewayInfo, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${info.url}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: info.token },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
  } catch {
    // 忽略：下一次事件仍会尝试
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * 打开二进制帧流：`[u16 宽][u16 高][u32 长度][JPEG]` 循环。
 *
 * 一条连接持续读，不需要 SSE 的 base64/JSON 包装；单帧少约 33% 体积，
 * 也省掉主线程上的 JSON.parse。
 */
export async function streamGatewayFrames(
  info: GatewayInfo,
  signal: AbortSignal,
  onFrame: (frame: GatewayFrame) => void,
): Promise<void> {
  const res = await fetch(`${info.url}/frames`, {
    headers: { [TOKEN_HEADER]: info.token },
    cache: 'no-store',
    signal,
  });
  if (!res.ok || res.body === null) throw new Error(`帧流失败（${res.status}）`);

  const reader = res.body.getReader();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) buffer = concat(buffer, value);
    for (;;) {
      if (buffer.length < 8) break;
      const width = buffer[0]! | (buffer[1]! << 8);
      const height = buffer[2]! | (buffer[3]! << 8);
      const length = buffer[4]! | (buffer[5]! << 8) | (buffer[6]! << 16) | (buffer[7]! << 24);
      if (length <= 0 || length > 8 * 1024 * 1024) throw new Error('帧数据损坏');
      if (buffer.length < 8 + length) break;
      const jpeg = new Uint8Array(length);
      jpeg.set(buffer.subarray(8, 8 + length));
      buffer = buffer.slice(8 + length);
      onFrame({ width, height, jpeg });
    }
  }
}
