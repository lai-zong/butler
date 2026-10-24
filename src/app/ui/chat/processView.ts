/**
 * 过程视图的纯函数层 —— 把“轮次 + 工具调用”摊平成 DSH 式的一行一条。
 *
 * ★ 为什么要单独一层：
 *   渲染容易写对、状态容易写乱。把「数据 → 行/统计」抽成纯函数，
 *   组件只负责展开/收起，测试可以直接断言顺序、标签与统计口径。
 *
 * ★ 统计口径（用户确认）：
 *   “思考次数” = 有思考内容的轮次数量，不是轮次总数。
 */

import type { LiveToolStatus } from '../lib/types.js';

export interface ProcTool {
  readonly callId: string;
  readonly name: string;
  readonly argsText: string;
  readonly status: LiveToolStatus;
  readonly output: string;
  readonly durationMs: number | null;
}

export interface ProcRound {
  readonly round: number;
  readonly reasoning: string;
  readonly text: string;
  readonly tools: readonly ProcTool[];
}

export interface ProcFinished {
  readonly rounds: number;
  readonly reason: string;
}

type LineBase = { readonly key: string; readonly round: number };

export type ProcLine =
  | (LineBase & { readonly kind: 'thinking'; readonly text: string })
  | (LineBase & { readonly kind: 'text'; readonly text: string })
  | (LineBase & { readonly kind: 'tool'; readonly tool: ProcTool });

export type ToolCategory = 'read' | 'write' | 'run' | 'search' | 'desktop' | 'submit' | 'other';

export interface ToolDisplay {
  readonly category: ToolCategory;
  readonly label: string;
  readonly detail: string;
  readonly icon: 'file' | 'upload' | 'command' | 'search' | 'external' | 'checkCircle' | 'sparkle';
}

export interface ProcessComposition {
  readonly label: string;
  readonly count: number;
}

export interface ProcessStats {
  readonly thinkingCount: number;
  readonly toolCount: number;
  readonly durationMs: number | null;
  readonly composition: readonly ProcessComposition[];
  readonly denied: number;
  readonly failed: number;
  /** 结束原因的人话；不出现“轮次/上限”。 */
  readonly outcome: string;
}

export interface ProcessView {
  readonly lines: readonly ProcLine[];
  readonly stats: ProcessStats;
}

const CATEGORY_LABEL: Record<ToolCategory, string> = {
  read: '读取',
  write: '写入',
  run: '运行',
  search: '搜索',
  desktop: '桌面',
  submit: '提交',
  other: '工具',
};

const CATEGORY_ICON: Record<ToolCategory, ToolDisplay['icon']> = {
  read: 'file',
  write: 'upload',
  run: 'command',
  search: 'search',
  desktop: 'external',
  submit: 'checkCircle',
  other: 'sparkle',
};

const CATEGORY_ORDER: readonly ToolCategory[] = [
  'read',
  'write',
  'run',
  'search',
  'desktop',
  'submit',
  'other',
];

type Args = Record<string, unknown>;

function parseArgs(argsText: string): Args | null {
  const text = argsText.trim();
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Args;
    }
  } catch {
    // 参数可能被截断或不是 JSON —— 调用方会退回原始文本
  }
  return null;
}

function str(args: Args | null, key: string): string {
  const v = args?.[key];
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? '';
}

function runCommandText(args: Args | null): string {
  const command = str(args, 'command');
  if (command.length === 0) return '';
  const rest = Array.isArray(args?.['args']) ? (args?.['args'] as unknown[]).map(String) : [];
  return [command, ...rest].join(' ');
}

/** 工具 → 一行人话。未知工具原样显示，不猜语义。 */
export function describeTool(tool: ProcTool): ToolDisplay {
  const args = parseArgs(tool.argsText);
  const name = tool.name;

  switch (name) {
    case 'read_file':
      return { category: 'read', label: '读取', detail: str(args, 'path'), icon: 'file' };
    case 'list_dir':
      return { category: 'read', label: '浏览', detail: str(args, 'path'), icon: 'file' };
    case 'stat_path':
      return { category: 'read', label: '查看', detail: str(args, 'path'), icon: 'file' };
    case 'write_file':
      return { category: 'write', label: '写入', detail: str(args, 'path'), icon: 'upload' };
    case 'make_dir':
      return { category: 'write', label: '新建目录', detail: str(args, 'path'), icon: 'upload' };
    case 'move_path': {
      const from = str(args, 'from');
      const to = str(args, 'to');
      return {
        category: 'write',
        label: '移动',
        detail: from.length > 0 && to.length > 0 ? `${from} → ${to}` : from || to,
        icon: 'upload',
      };
    }
    case 'remove_path':
      return { category: 'write', label: '删除', detail: str(args, 'path'), icon: 'upload' };
    case 'run_command':
      return { category: 'run', label: '运行命令', detail: runCommandText(args), icon: 'command' };
    case 'web_search':
      return { category: 'search', label: '搜索', detail: str(args, 'query'), icon: 'search' };
    case 'web_fetch':
      return { category: 'search', label: '抓取', detail: str(args, 'url'), icon: 'search' };
    case 'submit_report': {
      const reply = firstLine(str(args, 'reply'));
      return { category: 'submit', label: '提交结果', detail: reply, icon: 'checkCircle' };
    }
    default:
      if (name.startsWith('desktop_')) {
        return {
          category: 'desktop',
          label: `桌面 · ${name.slice('desktop_'.length).replace(/_/g, ' ')}`,
          detail: str(args, 'path') || str(args, 'name') || str(args, 'window') || '',
          icon: 'external',
        };
      }
      if (name.startsWith('mcp.') || name.startsWith('mcp__') || name.includes('/')) {
        return { category: 'other', label: '外部工具', detail: name, icon: 'sparkle' };
      }
      return {
        category: 'other',
        label: name.length > 0 ? name : '工具调用',
        detail: firstLine(tool.argsText),
        icon: CATEGORY_ICON.other,
      };
  }
}

/** 结束原因 → 人话；roundLimit 只写“未完成”，不暴露内部限制词。 */
export function outcomeLabel(finished: ProcFinished | null, streaming: boolean): string {
  if (streaming) return '执行中';
  if (finished === null) return '已结束';
  switch (finished.reason) {
    case 'noToolCalls':
      return '直接作答';
    case 'terminalTool':
      return '提交结果';
    case 'roundLimit':
      return '执行未完成';
    default:
      return finished.reason.length > 0 ? finished.reason : '已结束';
  }
}

export function buildProcessView(args: {
  readonly rounds: readonly ProcRound[];
  readonly finished: ProcFinished | null;
  readonly durationMs: number | null;
  readonly streaming?: boolean;
}): ProcessView {
  const lines: ProcLine[] = [];
  let thinkingCount = 0;
  let toolCount = 0;
  let denied = 0;
  let failed = 0;
  const composition = new Map<ToolCategory, number>();

  for (const round of args.rounds) {
    if (round.reasoning.trim().length > 0) {
      thinkingCount += 1;
      lines.push({
        kind: 'thinking',
        key: `${round.round}-thinking`,
        round: round.round,
        text: round.reasoning,
      });
    }

    for (const tool of round.tools) {
      toolCount += 1;
      if (tool.status === 'denied') denied += 1;
      if (tool.status === 'error') failed += 1;
      const display = describeTool(tool);
      composition.set(display.category, (composition.get(display.category) ?? 0) + 1);
      lines.push({
        kind: 'tool',
        key: `${round.round}-tool-${tool.callId}`,
        round: round.round,
        tool,
      });
    }

    if (round.text.trim().length > 0) {
      lines.push({
        kind: 'text',
        key: `${round.round}-text`,
        round: round.round,
        text: round.text,
      });
    }
  }

  return {
    lines,
    stats: {
      thinkingCount,
      toolCount,
      durationMs: args.durationMs,
      composition: CATEGORY_ORDER.filter((c) => (composition.get(c) ?? 0) > 0).map((c) => ({
        label: CATEGORY_LABEL[c],
        count: composition.get(c) ?? 0,
      })),
      denied,
      failed,
      outcome: outcomeLabel(args.finished, args.streaming === true),
    },
  };
}

/** 单行预览：折叠换行并截断，用于“部分内容”展示。 */
export function previewText(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max)}…`;
}

export { CATEGORY_LABEL };
