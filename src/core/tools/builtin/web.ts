/**
 * 只读联网工具：web_search（搜索）与 web_fetch（抓取网页正文）。
 *
 * ★ 没有浏览器实例、没有 API key；用公开 HTTP GET。
 *   只读、无副作用；URL 做基础 SSRF 拦截（localhost / 私网 / 非 http(s)）。
 */

import type { ToolResult, ToolSpec } from '../types.js';

const MAX_BODY_BYTES = 1_500_000;
const TIMEOUT_MS = 20_000;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function blockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '0.0.0.0') return true;
  /**
   * ★ 补充网段（实测缺失）：
   *   · `127.1` / `2130706433` 这类简写与十进制形式会被系统解析成 127.0.0.1；
   *   · `169.254.0.0/16` 是云主机元数据服务（AWS/GCP 的凭证就在这里）；
   *   · `100.64.0.0/10` 是运营商级 NAT；
   *   · `::ffff:127.0.0.1` 是 IPv4-mapped 的 IPv6 写法。
   */
  if (/^169\.254\./.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  if (/^::ffff:(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  // 纯数字主机名（十进制 IP）：`http://2130706433/`
  if (/^\d+$/.test(host)) return true;
  return false;
}

async function fetchText(url: string): Promise<{ readonly text: string; readonly contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    /**
     * ★ 逐跳校验跳转，而不是 `redirect: 'follow'`。
     *
     *   只校验初始 URL 时，一个公网地址 302 到 `169.254.169.254`（云元数据）
     *   或内网地址就能绕过黑名单。这里最多跟 3 跳，**每一跳的 host 都重新校验**。
     *   http→https 这类正常跳转仍然可用（否则大量站点会打不开）。
     */
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(current);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`只支持 http(s)：${parsed.protocol}`);
      }
      if (blockedHost(parsed.hostname)) throw new Error(`拒绝访问内网地址：${parsed.hostname}`);

      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'butler-review/1.0 (+read-only review agent)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (location === null || location.trim().length === 0) {
          throw new Error(`HTTP ${res.status}（跳转缺少 Location）`);
        }
        if (hop === MAX_REDIRECTS) throw new Error('跳转次数过多');
        current = new URL(location, current).toString();
        continue;
      }
      break;
    }

    if (res === null) throw new Error('没有拿到响应');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!/text\/|json|xml|xhtml/.test(contentType)) {
      throw new Error(`不支持的 Content-Type：${contentType || '未知'}`);
    }
    const text = await res.text();
    return { text: text.slice(0, MAX_BODY_BYTES), contentType };
  } finally {
    clearTimeout(timer);
  }
}

/** 最多跟随几跳（每一跳都重新做 host 校验）。 */
const MAX_REDIRECTS = 3;

export function webSearchTool(): ToolSpec {
  return {
    name: 'web_search',
    description:
      '联网搜索公开网页，返回标题、链接和摘要。需要最新信息或外部资料时用；只读 GET。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        maxResults: { type: 'number', description: '最多返回几条，1—10，默认 5' },
      },
      required: ['query'],
    },
    tier: 'readOnly',
    summarize: (args) => `联网搜索 ${String((args as { query?: unknown })?.query ?? '?')}`,
    async execute(args, ctx): Promise<ToolResult> {
      const started = ctx.clock.now();
      const a = args as { query?: string; maxResults?: number };
      const query = typeof a.query === 'string' ? a.query.trim() : '';
      if (query.length === 0) {
        return { ok: false, output: 'query 不能为空', isError: true, durationMs: 0 };
      }
      const limit = typeof a.maxResults === 'number' ? Math.max(1, Math.min(10, a.maxResults)) : 5;
      const endpoint = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
      try {
        const { text } = await fetchText(endpoint);
        const results: { title: string; url: string; snippet: string }[] = [];
        const anchor =
          /<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match: RegExpExecArray | null;
        while ((match = anchor.exec(text)) !== null && results.length < limit) {
          let href = decodeEntities(match[1] ?? '').trim();
          const title = stripHtml(match[2] ?? '');
          if (href.startsWith('/')) href = `https://www.sogou.com${href}`;
          if (!/^https?:\/\//i.test(href) || title.length === 0) continue;
          results.push({ title, url: href, snippet: '' });
        }
        return {
          ok: true,
          output:
            results.length === 0
              ? `没有找到「${query}」的搜索结果。`
              : results
                  .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`.trim())
                  .join('\n\n'),
          data: { query, results },
          durationMs: ctx.clock.now() - started,
        };
      } catch (err) {
        return {
          ok: false,
          output: `联网搜索失败：${err instanceof Error ? err.message : String(err)}`,
          isError: true,
          durationMs: ctx.clock.now() - started,
        };
      }
    },
  };
}

export function webFetchTool(): ToolSpec {
  return {
    name: 'web_fetch',
    description:
      '抓取一个公开网页并转成纯文本。适合读取搜索结果、文档页、公告页；只读 GET。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL' },
        maxChars: { type: 'number', description: '最多返回多少字符，默认 12000' },
      },
      required: ['url'],
    },
    tier: 'readOnly',
    summarize: (args) => `抓取网页 ${String((args as { url?: unknown })?.url ?? '?')}`,
    async execute(args, ctx): Promise<ToolResult> {
      const started = ctx.clock.now();
      const a = args as { url?: string; maxChars?: number };
      const raw = typeof a.url === 'string' ? a.url.trim() : '';
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return { ok: false, output: 'url 不是合法 URL', isError: true, durationMs: 0 };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, output: '只支持 http/https URL', isError: true, durationMs: 0 };
      }
      if (blockedHost(parsed.hostname)) {
        return { ok: false, output: '拒绝访问本机/私网地址', isError: true, durationMs: 0 };
      }
      const maxChars = typeof a.maxChars === 'number' ? Math.max(500, Math.min(40_000, a.maxChars)) : 12_000;
      try {
        const { text, contentType } = await fetchText(parsed.toString());
        const body = /html|xhtml/.test(contentType) ? stripHtml(text) : text;
        const clipped = body.slice(0, maxChars);
        return {
          ok: true,
          output:
            `来源：${parsed.toString()}\n类型：${contentType}\n\n${clipped}` +
            (body.length > maxChars ? '\n…（内容过长，已截断）' : ''),
          data: { url: parsed.toString(), contentType },
          durationMs: ctx.clock.now() - started,
        };
      } catch (err) {
        return {
          ok: false,
          output: `抓取失败：${err instanceof Error ? err.message : String(err)}`,
          isError: true,
          durationMs: ctx.clock.now() - started,
        };
      }
    },
  };
}

export function webTools(): readonly ToolSpec[] {
  return [webSearchTool(), webFetchTool()];
}
