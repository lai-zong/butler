/**
 * 凭证脱敏
 *
 * 设计依据：方案 § 11 第二层（记忆侧防护）
 *
 * ★ 原则：**"可用不可见"**。
 *   工具可以用凭证去调 API、登录、签名，
 *   但凭证的值**绝不能**出现在：工具结果、审计记录、事件日志、长期记忆里。
 *
 * 这个模块是那条约束的执行者。任何可能包含凭证的文本都要过一遍。
 */

/** 已知的敏感键名（大小写不敏感，含常见变体）。 */
const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'accesskey',
  'access_key',
  'private_key',
  'privatekey',
  'credential',
  'authorization',
  'auth',
  'cookie',
  'session_id',
  'sessionid',
  'client_secret',
  'refresh_token',
  'id_token',
  'passphrase',
  '口令',
  '密码',
  '密钥',
  '凭证',
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[\s_-]/g, '');
  return SENSITIVE_KEYS.some((s) => k.includes(s.replace(/[\s_-]/g, '')));
}

/**
 * 常见凭证形态的文本模式。
 *
 * 用途：即使键名无害（如 `note`），值本身可能是密钥 ——
 * 例如用户把 key 贴在正文里。这类要按**形态**识别。
 */
const SENSITIVE_PATTERNS: readonly { readonly re: RegExp; readonly label: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, label: 'API 密钥' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'GitHub Token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS Access Key' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'JWT' },
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: '私钥',
  },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, label: 'Bearer Token' },
  // 中国大陆手机号与身份证
  { re: /\b1[3-9]\d{9}\b/g, label: '手机号' },
  { re: /\b\d{17}[\dXx]\b/g, label: '身份证号' },
  // 银行卡（16-19 位，允许空格或连字符分隔）
  { re: /\b(?:\d[ -]?){15,18}\d\b/g, label: '银行卡号' },
];

/** 替换用的占位符。保留类型信息，让调用方知道"这里本来是什么"。 */
function placeholder(label: string): string {
  return `[已脱敏:${label}]`;
}

/**
 * 对一段文本做凭证脱敏。
 *
 * 顺序：先按形态替换（更可靠），再处理键值对形态。
 */
export function redactText(input: string): string {
  let out = input;

  for (const p of SENSITIVE_PATTERNS) {
    out = out.replace(p.re, placeholder(p.label));
  }

  // 形如 `password=xxx` / `"token": "xxx"` / `密码：xxx` 的键值对
  //
  // ⚠️ 必须同时接受**全角标点** —— 中文输入下用户与模型都会写
  //    `密钥：xxx` 或 `密码＝xxx`，只匹配半角会漏掉（实测踩过）。
  for (const key of SENSITIVE_KEYS) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `(["'「『]?${escaped}["'」』]?\\s*[:=：＝]\\s*)(["'「『]?)([^\\s"',;｝}、，。]{3,})\\2`,
      'gi',
    );
    out = out.replace(re, (_m, prefix: string) => `${prefix}${placeholder('凭证')}`);
  }

  return out;
}

/**
 * 对工具参数做脱敏并生成一行摘要。
 *
 * 深度遍历对象：敏感键的值整体替换，其余值做文本脱敏并截断。
 */
export function redactArgs(args: unknown, maxLength = 300): string {
  const safe = walk(args, 0);
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe);
  const redacted = redactText(text);
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…`;
}

function walk(value: unknown, depth: number): unknown {
  if (depth > 6) return '[层级过深已省略]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => walk(v, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? placeholder('凭证') : walk(v, depth + 1);
    }
    return out;
  }
  return '[不可序列化]';
}

/**
 * 判断一段文本里是否含有凭证。
 *
 * 用途：写入长期记忆前的检查（方案 § 11 第二层"写入白名单"）。
 * 含凭证的内容不该进记忆库 —— 那是"可用不可见"的边界。
 */
export function containsCredentials(input: string): boolean {
  if (SENSITIVE_PATTERNS.some((p) => new RegExp(p.re.source, p.re.flags).test(input))) return true;
  const lowered = input.toLowerCase();
  return SENSITIVE_KEYS.some((k) => lowered.includes(k.toLowerCase()));
}

/** 供测试与调试：列出所有被识别的形态标签。 */
export function credentialPatternLabels(): readonly string[] {
  return SENSITIVE_PATTERNS.map((p) => p.label);
}
