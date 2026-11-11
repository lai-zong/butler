/**
 * 模型探测（discover）的地址准入
 *
 * ★ 为什么要限制：`discover` 是**服务端发起**的 GET。任意 baseUrl 等于
 *   给这个程序一个端口扫描器，而且会把用户填的 API Key 发到任意主机。
 *   实测：把它指向本机探针，服务端真的发出 `GET /v1/models` 并接受了返回。
 *
 * 允许三类：
 *   · 与预设同源（host:port）—— "换网关但仍同一家"；
 *   · 本机回环 —— 本地 Ollama / 兼容层；
 *   · `MODEL_DISCOVER_ALLOWED_HOSTS` 里显式列出的主机 —— 自定义网关的出口。
 */
export function discoverHostAllowed(args: {
  readonly baseUrl: string;
  readonly presetBaseUrl: string;
  readonly allowedHosts?: readonly string[];
}): boolean {
  let target: URL;
  try {
    target = new URL(args.baseUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;

  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true;

  try {
    if (target.host === new URL(args.presetBaseUrl).host) return true;
  } catch {
    // 预设地址解析失败时不放行
  }

  const extra = (args.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
  return extra.includes(host) || extra.includes(target.host.toLowerCase());
}

/** 从环境变量读白名单（逗号分隔）。 */
export function discoverAllowedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return (env['MODEL_DISCOVER_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}
