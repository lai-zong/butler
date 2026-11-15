/**
 * 本地登录：单用户、强制、不可关闭。
 *
 * ★ 定位：
 *   这是本机访问控制，不是多用户隔离，也不加密磁盘数据。
 *   认证文件存在 = 已配置；文件不存在 = 首次启动，必须完成设置。
 *
 * ★ 找回方式：
 *   首次设置密码时必须同时设置一个找回问题（答案只存 scrypt 哈希）。
 *   忘记密码用问题答案重置；不生成、也不保存任何一次性恢复码。
 */

import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isSecurityQuestionId,
  securityQuestionById,
  type SecurityQuestionId,
} from './localAuthQuestions.js';

export const LOCAL_AUTH_FILE = 'local-auth.json';
export const LOCAL_AUTH_COOKIE = 'butler_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;
const ANSWER_MIN = 2;
const ANSWER_MAX = 200;
const SCRYPT = { n: 16384, r: 8, p: 1, keylen: 64 } as const;

export type LocalAuthErrorCode =
  | 'already_configured'
  | 'not_configured'
  | 'security_not_configured'
  | 'invalid_question'
  | 'invalid_answer'
  | 'invalid_password'
  | 'invalid_session'
  | 'auth_file_corrupt';

export class LocalAuthError extends Error {
  readonly code: LocalAuthErrorCode;
  readonly status: number;

  constructor(code: LocalAuthErrorCode, message: string, status: number) {
    super(message);
    this.name = 'LocalAuthError';
    this.code = code;
    this.status = status;
  }
}

interface PasswordRecord {
  readonly algorithm: 'scrypt';
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: string;
  readonly hash: string;
}

export interface SecurityRecord {
  readonly questionId: SecurityQuestionId;
  readonly answer: PasswordRecord;
}

export interface LocalAuthFile {
  readonly version: 1;
  readonly password: PasswordRecord;
  /** 旧认证文件没有这个问题；已登录用户可以在设置里补设。 */
  readonly security: SecurityRecord | null;
  readonly sessionSecret: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SessionPayload {
  readonly v: 1;
  readonly iat: number;
  readonly exp: number;
  readonly nonce: string;
}

interface ScryptOptions {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export function localAuthPath(dir = resolveDataDir()): string {
  return join(dir, LOCAL_AUTH_FILE);
}

export function resolveDataDir(): string {
  return process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
}

function base64(value: Buffer): string {
  return value.toString('base64');
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePasswordRecord(value: unknown): PasswordRecord {
  if (!isRecord(value)) throw corrupt();
  const { algorithm, n, r, p, salt, hash } = value;
  if (
    algorithm !== 'scrypt' ||
    typeof n !== 'number' ||
    typeof r !== 'number' ||
    typeof p !== 'number' ||
    typeof salt !== 'string' ||
    typeof hash !== 'string' ||
    salt.length === 0 ||
    hash.length === 0
  ) {
    throw corrupt();
  }
  return { algorithm, n, r, p, salt, hash };
}

function parseSecurityRecord(value: unknown): SecurityRecord | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw corrupt();
  const questionId = value['questionId'];
  if (!isSecurityQuestionId(questionId)) throw corrupt();
  return { questionId, answer: parsePasswordRecord(value['answer']) };
}

function corrupt(): LocalAuthError {
  return new LocalAuthError(
    'auth_file_corrupt',
    '本地认证文件损坏；请删除 .butler-data/local-auth.json 后重新设置。',
    503,
  );
}

function parseAuthFile(value: unknown): LocalAuthFile {
  if (!isRecord(value) || value['version'] !== 1) throw corrupt();
  if (typeof value['sessionSecret'] !== 'string' || value['sessionSecret'].length === 0) {
    throw corrupt();
  }
  if (typeof value['createdAt'] !== 'number' || typeof value['updatedAt'] !== 'number') {
    throw corrupt();
  }
  return {
    version: 1,
    password: parsePasswordRecord(value['password']),
    // 兼容上一版带 recovery 的认证文件：读取时直接忽略 recovery。
    security: parseSecurityRecord(value['security']),
    sessionSecret: value['sessionSecret'],
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
  };
}

export async function loadLocalAuth(dir = resolveDataDir()): Promise<LocalAuthFile | null> {
  let raw: string;
  try {
    raw = await readFile(localAuthPath(dir), 'utf8');
  } catch (err) {
    if (isRecord(err) && err['code'] === 'ENOENT') return null;
    throw err;
  }
  try {
    return parseAuthFile(JSON.parse(raw) as unknown);
  } catch (err) {
    if (err instanceof LocalAuthError) throw err;
    throw corrupt();
  }
}

async function writeLocalAuth(file: LocalAuthFile, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = localAuthPath(dir);
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
}

function deriveKey(
  secret: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(secret, salt, keylen, options, (err, derived) => {
      if (err !== null) reject(err);
      else resolve(derived);
    });
  });
}

async function makePasswordRecord(secret: string): Promise<PasswordRecord> {
  const salt = randomBytes(16);
  const derived = await deriveKey(secret, salt, SCRYPT.keylen, {
    N: SCRYPT.n,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return {
    algorithm: 'scrypt',
    n: SCRYPT.n,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: base64(salt),
    hash: base64(derived),
  };
}

async function verifyPasswordRecord(record: PasswordRecord, secret: string): Promise<boolean> {
  const salt = fromBase64(record.salt);
  const expected = fromBase64(record.hash);
  const derived = await deriveKey(secret, salt, expected.length, {
    N: record.n,
    r: record.r,
    p: record.p,
  });
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return '密码必须是字符串';
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (password.length > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 位`;
  return null;
}

/** 答案不做"猜用户想写什么"的模糊匹配，只做大小写/首尾空白归一。 */
export function normalizeSecurityAnswer(answer: string): string {
  return answer.normalize('NFKC').trim().toLowerCase();
}

export function validateSecurityAnswer(answer: unknown): string | null {
  if (typeof answer !== 'string') return '请填写找回问题的答案';
  const normalized = normalizeSecurityAnswer(answer);
  if (normalized.length < ANSWER_MIN) return `答案至少 ${ANSWER_MIN} 个字符`;
  if (normalized.length > ANSWER_MAX) return `答案最多 ${ANSWER_MAX} 个字符`;
  return null;
}

function generateSessionSecret(): string {
  return base64(randomBytes(32));
}

function sessionSignature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSessionToken(auth: LocalAuthFile, now = Date.now()): string {
  const payload: SessionPayload = {
    v: 1,
    iat: now,
    exp: now + SESSION_TTL_MS,
    nonce: randomBytes(12).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sessionSignature(auth.sessionSecret, encoded)}`;
}

export function verifySessionToken(
  token: string,
  auth: LocalAuthFile,
  now = Date.now(),
): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sessionSignature(auth.sessionSecret, encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(payload) || payload['v'] !== 1) return false;
    if (typeof payload['iat'] !== 'number' || typeof payload['exp'] !== 'number') return false;
    if (payload['exp'] <= now) return false;
    if (payload['iat'] > now + 60_000) return false;
    return true;
  } catch {
    return false;
  }
}

export function securityQuestionOf(auth: LocalAuthFile): {
  readonly id: SecurityQuestionId;
  readonly label: string;
} | null {
  if (auth.security === null) return null;
  const question = securityQuestionById(auth.security.questionId);
  return question === null ? null : { id: auth.security.questionId, label: question.label };
}

export interface SetupInput {
  readonly password: unknown;
  readonly questionId: unknown;
  readonly answer: unknown;
}

export async function setupLocalAuth(
  input: SetupInput,
  dir = resolveDataDir(),
): Promise<LocalAuthFile> {
  const passwordProblem = validatePassword(input.password);
  if (passwordProblem !== null) {
    throw new LocalAuthError('invalid_password', passwordProblem, 400);
  }
  if (!isSecurityQuestionId(input.questionId)) {
    throw new LocalAuthError('invalid_question', '请选择一个找回问题', 400);
  }
  const answerProblem = validateSecurityAnswer(input.answer);
  if (answerProblem !== null) {
    throw new LocalAuthError('invalid_answer', answerProblem, 400);
  }
  if ((await loadLocalAuth(dir)) !== null) {
    throw new LocalAuthError('already_configured', '本地登录已经设置过', 409);
  }

  const now = Date.now();
  const auth: LocalAuthFile = {
    version: 1,
    password: await makePasswordRecord(input.password as string),
    security: {
      questionId: input.questionId,
      answer: await makePasswordRecord(normalizeSecurityAnswer(input.answer as string)),
    },
    sessionSecret: generateSessionSecret(),
    createdAt: now,
    updatedAt: now,
  };
  await writeLocalAuth(auth, dir);
  return auth;
}

export async function verifyLocalPassword(
  password: unknown,
  dir = resolveDataDir(),
): Promise<LocalAuthFile> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new LocalAuthError('invalid_password', '请输入密码', 400);
  }
  const auth = await loadLocalAuth(dir);
  if (auth === null) {
    throw new LocalAuthError('not_configured', '还没有设置本地登录', 409);
  }
  if (!(await verifyPasswordRecord(auth.password, password))) {
    throw new LocalAuthError('invalid_password', '密码不正确', 401);
  }
  return auth;
}

export async function changeLocalPassword(
  currentPassword: unknown,
  newPassword: unknown,
  dir = resolveDataDir(),
): Promise<LocalAuthFile> {
  const auth = await verifyLocalPassword(currentPassword, dir);
  const invalid = validatePassword(newPassword);
  if (invalid !== null) {
    throw new LocalAuthError('invalid_password', invalid, 400);
  }
  const next: LocalAuthFile = {
    ...auth,
    password: await makePasswordRecord(newPassword as string),
    sessionSecret: generateSessionSecret(),
    updatedAt: Date.now(),
  };
  await writeLocalAuth(next, dir);
  return next;
}

/**
 * 设置或替换找回问题。
 *
 * 需要当前密码；已登录会话只是必要条件，不能替代当前密码，
 * 避免别人短暂碰到已解锁的页面就改掉找回方式。
 */
export async function setLocalSecurityQuestion(
  currentPassword: unknown,
  questionId: unknown,
  answer: unknown,
  dir = resolveDataDir(),
): Promise<LocalAuthFile> {
  const auth = await verifyLocalPassword(currentPassword, dir);
  if (!isSecurityQuestionId(questionId)) {
    throw new LocalAuthError('invalid_question', '请选择一个找回问题', 400);
  }
  const answerProblem = validateSecurityAnswer(answer);
  if (answerProblem !== null) {
    throw new LocalAuthError('invalid_answer', answerProblem, 400);
  }
  const next: LocalAuthFile = {
    ...auth,
    security: {
      questionId,
      answer: await makePasswordRecord(normalizeSecurityAnswer(answer as string)),
    },
    updatedAt: Date.now(),
  };
  await writeLocalAuth(next, dir);
  return next;
}

/** 用找回问题重置密码；成功后轮换会话密钥，旧会话全部失效。 */
export async function resetLocalAuthWithAnswer(
  answer: unknown,
  newPassword: unknown,
  dir = resolveDataDir(),
): Promise<LocalAuthFile> {
  const auth = await loadLocalAuth(dir);
  if (auth === null) {
    throw new LocalAuthError('not_configured', '还没有设置本地登录', 409);
  }
  if (auth.security === null) {
    throw new LocalAuthError(
      'security_not_configured',
      '还没有设置找回问题；请在登录后的设置中补设，或在项目目录运行 butler reset-password。',
      409,
    );
  }
  const answerProblem = validateSecurityAnswer(answer);
  if (answerProblem !== null) {
    throw new LocalAuthError('invalid_answer', answerProblem, 400);
  }
  if (!(await verifyPasswordRecord(auth.security.answer, normalizeSecurityAnswer(answer as string)))) {
    throw new LocalAuthError('invalid_answer', '找回答案不正确', 401);
  }
  const invalid = validatePassword(newPassword);
  if (invalid !== null) {
    throw new LocalAuthError('invalid_password', invalid, 400);
  }
  const next: LocalAuthFile = {
    ...auth,
    password: await makePasswordRecord(newPassword as string),
    sessionSecret: generateSessionSecret(),
    updatedAt: Date.now(),
  };
  await writeLocalAuth(next, dir);
  return next;
}

/** 退出登录：轮换会话密钥，让本机所有已签发的旧会话立即失效。 */
export async function revokeLocalSessions(dir = resolveDataDir()): Promise<void> {
  const auth = await loadLocalAuth(dir);
  if (auth === null) return;
  const next: LocalAuthFile = {
    ...auth,
    sessionSecret: generateSessionSecret(),
    updatedAt: Date.now(),
  };
  await writeLocalAuth(next, dir);
}

/** 路由层使用：从 cookie 中取会话并校验。 */
export function readSessionFromCookie(
  cookieValue: string | undefined,
  auth: LocalAuthFile,
): boolean {
  return typeof cookieValue === 'string' && verifySessionToken(cookieValue, auth);
}
