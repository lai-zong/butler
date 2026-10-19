/**
 * HTTP 访问层 —— 所有请求只走这里
 *
 * ★ 目的：错误处理只有一份。视图里不需要每次都写
 *   `if (!res.ok) { const data = await res.json()... }`。
 */

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

function errorFrom(data: unknown, fallback: string): string {
  if (typeof data === 'object' && data !== null) {
    const rec = data as Record<string, unknown>;
    if (typeof rec['error'] === 'string' && rec['error'].length > 0) return rec['error'];
  }
  return fallback;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '网络错误';
    throw new ApiError(`连不上本地服务（${message}）`, 0, null);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    throw new ApiError(
      errorFrom(data, `请求失败（HTTP ${res.status}）`),
      res.status,
      data,
    );
  }

  return data as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
