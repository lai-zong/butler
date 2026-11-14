/**
 * 浏览器内容工具：让管家在对话里直接读取用户当前打开的内嵌浏览器，
 * 不需要用户截图、复制正文，也不需要 web_fetch 重新下载页面。
 *
 * ★ 为什么放在工具层而不是自动塞正文：
 *   · 标题/URL 这类小上下文由路由每轮注入（几乎零成本）；
 *   · 正文可能很长，只有模型真的需要时才调用 browser_read，
 *     避免每轮都为一个没被问到的问题付 token。
 *
 * ★ 全部 readOnly，不带路径参数，因此不经过文件系统的 pathGuard；
 *   浏览器没启动时返回一句可读的错误，而不是抛异常中断整轮。
 */

import type { ToolContext, ToolResult, ToolSpec } from '@/core/tools/types.js';

import { listTabs, readPageText, readSelection } from './browserSession.js';

function textResult(started: number, output: string, data?: unknown): ToolResult {
  return {
    ok: true,
    output,
    ...(data !== undefined ? { data } : {}),
    durationMs: Date.now() - started,
  };
}

function errorResult(started: number, message: string): ToolResult {
  return {
    ok: false,
    output: message,
    isError: true,
    durationMs: Date.now() - started,
  };
}

const READ_TOOL: ToolSpec = {
  name: 'browser_read',
  description:
    '读取用户当前内嵌浏览器页面（已登录、已渲染的真实页面）的标题、URL 与可见正文。' +
    '比用 web_fetch 抓链接更快、更省 token，也能拿到登录后/动态渲染的内容。' +
    '用户问“这个页面”“当前网页”时优先用它。',
  parameters: {
    type: 'object',
    properties: {
      maxChars: {
        type: 'number',
        description: '正文最多返回多少字符，默认 12000；不要设得过小导致丢关键信息。',
      },
    },
    required: [],
  },
  tier: 'readOnly',
  summarize: () => '读取当前浏览器页面',
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    void ctx;
    const started = Date.now();
    const raw = (args as { maxChars?: unknown } | undefined)?.maxChars;
    const maxChars = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : 12_000;
    try {
      const page = await readPageText(maxChars);
      return textResult(
        started,
        [
          `URL: ${page.url}`,
          `标题: ${page.title}`,
          '',
          '页面正文：',
          page.text.trim() || '（页面没有可读正文）',
        ].join('\n'),
        { url: page.url, title: page.title, chars: page.text.length },
      );
    } catch (err) {
      return errorResult(
        started,
        `读取浏览器页面失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

const TABS_TOOL: ToolSpec = {
  name: 'browser_tabs',
  description:
    '列出用户内嵌浏览器当前打开的所有标签页（标题、URL、哪个是当前页）。' +
    '用户说“另一个标签”“刚才那个页面”时先用它定位。',
  parameters: { type: 'object', properties: {}, required: [] },
  tier: 'readOnly',
  summarize: () => '列出浏览器标签页',
  async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const tabs = await listTabs();
      if (tabs.length === 0) return textResult(started, '浏览器没有打开的页面。');
      const lines = tabs.map(
        (tab, index) =>
          `${index + 1}. ${tab.active ? '[当前] ' : ''}${tab.title || '（无标题）'} — ${tab.url}`,
      );
      return textResult(started, lines.join('\n'), { count: tabs.length });
    } catch (err) {
      return errorResult(
        started,
        `读取浏览器标签失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

const SELECTION_TOOL: ToolSpec = {
  name: 'browser_selection',
  description:
    '读取用户在内嵌浏览器页面里当前选中的文字。用户说“这段”“选中的内容”时用它。',
  parameters: { type: 'object', properties: {}, required: [] },
  tier: 'readOnly',
  summarize: () => '读取浏览器选区',
  async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const text = await readSelection();
      return textResult(started, text.length > 0 ? text : '（页面里没有选中的文字）');
    } catch (err) {
      return errorResult(
        started,
        `读取浏览器选区失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

export const browserToolSpecs: readonly ToolSpec[] = [READ_TOOL, TABS_TOOL, SELECTION_TOOL];

export function browserTools(): readonly ToolSpec[] {
  return browserToolSpecs;
}
