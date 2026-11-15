/**
 * 本地登录的前端 HTTP 客户端。
 *
 * ★ 为什么不用 lib/api.ts 的 fetchJson：
 *   登录页要按 HTTP 状态区分“密码错 / 限速 / 认证文件损坏”，
 *   还要读 429 的 Retry-After；fetchJson 只抛一个 message 为错误码的 ApiError。
 *   这里把失败统一成 AuthRequestError，界面只关心 status + code。
 *
 * ★ 会话是 httpOnly cookie：前端读不到，也不该读。
 *   所有请求都带 credentials: 'same-origin'，由浏览器负责携带。
 *
 * ★ 找回方式只有一个：设置时选的找回问题 + 答案。
 *   答案只在服务端做哈希，前端永远拿不到答案，也没有一次性凭据。
 */

export interface SecurityQuestion {
  readonly id: string;
  readonly label: string;
}

export interface LocalAuthStatus {
  readonly ok: true;
  readonly configured: boolean;
  readonly authenticated: boolean;
  readonly setupRequired: boolean;
  readonly securityQuestion: SecurityQuestion | null;
}

export interface LoginResult {
  readonly expiresAt: number;
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const ANSWER_MIN_LENGTH = 2;
export const ANSWER_MAX_LENGTH = 200;

/** 服务端没给 message 时的兜底；正常的 auth 错误都自带中文 message。 */
const FALLBACK_MESSAGES: Record<string, string> = {
  network_error: '连不上本地服务，请确认终端里的 butler 仍在运行',
  invalid_password: '密码不正确',
  invalid_question: '请选择一个找回问题',
  invalid_answer: '找回问题答案不正确',
  security_not_configured: '这台电脑还没有设置找回问题',
  invalid_session: '登录已失效，请重新登录',
  invalid_body: '请求格式不正确',
  not_configured: '还没有设置本地登录',
  already_configured: '本地登录已经设置过',
  auth_file_corrupt: '本地认证文件损坏',
  auth_unavailable: '本地认证暂时不可用',
  rate_limited: '尝试过多，请稍后再试',
  unauthorized: '请先登录',
  invalid_response: '服务端返回了无法识别的内容',
};

export class AuthRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    status: number,
    code: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'AuthRequestError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function asAuthError(error: unknown): AuthRequestError {
  if (error instanceof AuthRequestError) return error;
  return new AuthRequestError(
    error instanceof Error ? error.message : '请求失败，请稍后再试',
    0,
    'network_error',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 控制字符会破坏 URL 解析；逐个字符检查，避免正则里的控制字符告警。 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  if (header === null) return null;
  const seconds = Number.parseInt(header, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds;
}

function failure(response: Response, payload: unknown): AuthRequestError {
  const record = isRecord(payload) ? payload : null;
  const rawCode = record === null ? undefined : record['error'];
  const code = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : 'unknown';
  const rawMessage = record === null ? undefined : record['message'];
  const serverMessage = typeof rawMessage === 'string' ? rawMessage.trim() : '';
  const fallback = FALLBACK_MESSAGES[code] ?? `请求失败（HTTP ${response.status}）`;
  return new AuthRequestError(
    serverMessage.length > 0 ? serverMessage : fallback,
    response.status,
    code,
    retryAfterSeconds(response),
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new AuthRequestError(
      '连不上本地服务，请确认终端里的 butler 仍在运行',
      0,
      'network_error',
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) throw failure(response, payload);
  return payload as T;
}

function jsonPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function parseSecurityQuestion(value: unknown): SecurityQuestion | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const label = value['label'];
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof label !== 'string' || label.length === 0) return null;
  return { id, label };
}

function parseStatus(payload: unknown): LocalAuthStatus {
  if (!isRecord(payload) || payload['ok'] !== true) {
    throw new AuthRequestError(
      '本地认证返回了无法识别的状态，请重启 butler 后重试',
      500,
      'invalid_response',
    );
  }
  return {
    ok: true,
    configured: payload['configured'] === true,
    authenticated: payload['authenticated'] === true,
    setupRequired: payload['setupRequired'] === true,
    // 旧版 status 不带 securityQuestion；缺失时按“未设置”处理。
    securityQuestion: parseSecurityQuestion(payload['securityQuestion']),
  };
}

// ═══════════════════════════════════════════════════════════
// 接口
// ═══════════════════════════════════════════════════════════

export async function getAuthStatus(): Promise<LocalAuthStatus> {
  return parseStatus(await request<unknown>('/api/auth/status'));
}

/** 首次设置：密码 + 找回问题；成功后服务端直接写会话 cookie。 */
export async function setupAuth(
  password: string,
  questionId: string,
  answer: string,
): Promise<void> {
  await jsonPost<unknown>('/api/auth/setup', { password, questionId, answer });
}

export async function loginWithPassword(password: string): Promise<LoginResult> {
  const payload = await jsonPost<unknown>('/api/auth/login', { password });
  const expiresAt =
    isRecord(payload) && typeof payload['expiresAt'] === 'number' ? payload['expiresAt'] : 0;
  return { expiresAt };
}

export async function logoutAuth(): Promise<void> {
  await request<unknown>('/api/auth/logout', { method: 'POST' });
}

export async function changeLocalPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await jsonPost<unknown>('/api/auth/change-password', { currentPassword, newPassword });
}

/** 用找回问题的答案重置密码；成功后服务端自动写会话 cookie。 */
export async function resetAuthWithAnswer(answer: string, newPassword: string): Promise<void> {
  await jsonPost<unknown>('/api/auth/reset', { answer, newPassword });
}

/** 已登录后补设/替换找回问题；必须提供当前密码。 */
export async function setSecurityQuestion(
  currentPassword: string,
  questionId: string,
  answer: string,
): Promise<SecurityQuestion> {
  const payload = await jsonPost<unknown>('/api/auth/security', {
    currentPassword,
    questionId,
    answer,
  });
  const question = isRecord(payload) ? parseSecurityQuestion(payload['securityQuestion']) : null;
  if (question === null) {
    throw new AuthRequestError(
      '服务端没有返回找回问题，请重试。',
      500,
      'invalid_response',
    );
  }
  return question;
}

// ═══════════════════════════════════════════════════════════
// 校验 / 跳转
// ═══════════════════════════════════════════════════════════

/** 与服务端一致的最短/最长限制；只用于设置与重置新密码。 */
export function passwordRuleError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (password.length > PASSWORD_MAX_LENGTH) return `密码最多 ${PASSWORD_MAX_LENGTH} 位`;
  return null;
}

/** 与服务端一致：NFKC 归一 + 去首尾空白后至少 2 个字符。 */
export function answerRuleError(answer: string): string | null {
  const normalized = answer.normalize('NFKC').trim();
  if (normalized.length < ANSWER_MIN_LENGTH) return `答案至少 ${ANSWER_MIN_LENGTH} 个字符`;
  if (normalized.length > ANSWER_MAX_LENGTH) return `答案最多 ${ANSWER_MAX_LENGTH} 个字符`;
  return null;
}

/**
 * `next` 只接受站内路径。
 *
 * 拒绝：绝对 URL、协议相对（//host）、反斜杠变体、控制字符、
 * 回跳登录/设置页、以及 /api/ 路径。拿不准时一律回 `/`——
 * 这里宁可少跳一个页面，也不能变成开放重定向。
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '/';
  const value = raw.trim();
  if (value.length === 0) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (hasControlCharacter(value)) return '/';

  let parsed: URL;
  try {
    parsed = new URL(value, 'http://butler.local');
  } catch {
    return '/';
  }
  if (parsed.origin !== 'http://butler.local') return '/';
  if (parsed.pathname === '/login' || parsed.pathname === '/setup') return '/';
  if (parsed.pathname.startsWith('/api/')) return '/';

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
