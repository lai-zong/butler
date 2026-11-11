/**
 * 过程视图的纯函数层 —— 把“轮次 + 工具调用”摊平成 DSH 式的一行一条。
 *
 * ★ 为什么要单独一层：
 *   渲染容易写对、状态容易写乱。把「数据 → 行/统计」抽成纯函数，
 *   组件只负责展开/收起，测试可以直接断言顺序、标签与统计口径。
 *
 * ★ 动作口径（用户确认）：
 *   主对话与审查共用同一套动作标签：读取 / 编辑 / 执行 / 搜索 / 浏览 / 操作 / 工具。
 *   `submit_report`、`submit_review` 是执行协议的一部分，不进入过程列表。
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

/** 过程行上只暴露动作，不暴露工具实现名。 */
export type ToolAction = 'read' | 'edit' | 'exec' | 'search' | 'browse' | 'operate' | 'tool';

export interface ToolDisplay {
  readonly action: ToolAction;
  readonly label: string;
  readonly detail: string;
  readonly icon: 'file' | 'pencil' | 'upload' | 'command' | 'search' | 'eye' | 'external' | 'sparkle';
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

export const ACTION_LABEL: Record<ToolAction, string> = {
  read: '读取',
  edit: '编辑',
  exec: '执行',
  search: '搜索',
  browse: '浏览',
  operate: '操作',
  tool: '工具',
};

const ACTION_ORDER: readonly ToolAction[] = [
  'read',
  'edit',
  'exec',
  'search',
  'browse',
  'operate',
  'tool',
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

function joinDetail(...parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join(' · ');
}

/** `from → to` / `source → target`：两端都在才画箭头，缺一端就退回有值的那端。 */
function arrowDetail(args: Args | null, fromKey: string, toKey: string): string {
  const from = str(args, fromKey);
  const to = str(args, toKey);
  return from.length > 0 && to.length > 0 ? `${from} → ${to}` : from || to;
}

function runCommandText(args: Args | null): string {
  const command = str(args, 'command');
  if (command.length === 0) return '';
  const rest = Array.isArray(args?.['args']) ? (args?.['args'] as unknown[]).map(String) : [];
  return [command, ...rest].join(' ');
}

/**
 * 工具名 → 动作。主对话与审查都只走这一个映射。
 *
 * ★ 工具收敛后，`file_op` 一个入口承担 mkdir/move/remove，
 *   桌面观察/操作收成 `desktop_observe`/`desktop_act`；
 *   旧名字（make_dir/move_path/remove_path、desktop_*）保留映射，
 *   因为历史 trace 里仍会出现。
 * 未知工具 / MCP 一律落到 `tool`，不猜语义。
 */
export function actionForTool(name: string): ToolAction {
  switch (name) {
    case 'read_file':
    case 'list_dir':
    case 'stat_path':
      return 'read';
    case 'write_file':
    case 'file_op':
    case 'make_dir':
    case 'move_path':
    case 'remove_path':
    case 'apply_patch':
      return 'edit';
    case 'run_command':
      return 'exec';
    case 'grep':
    case 'glob':
    case 'script_search':
    case 'document_search':
    case 'web_search':
      return 'search';
    case 'web_fetch':
      return 'browse';
    case 'desktop_observe':
    case 'desktop_act':
      return 'operate';
    default:
      // 旧桌面工具（desktop_screenshot / desktop_uia_* / …）仍按操作处理。
      return name.startsWith('desktop_') ? 'operate' : 'tool';
  }
}

/** 折叠行只显示这个标签；真实工具名留在展开详情里。 */
export function actionLabelForTool(name: string): string {
  return ACTION_LABEL[actionForTool(name)];
}

/** 提交是执行协议的一部分，不算用户可见动作。 */
export function isHiddenProcessTool(name: string): boolean {
  return name === 'submit_report' || name === 'submit_review';
}

/** 过滤提交工具，保留其余工具的顺序。 */
export function visibleProcessTools<T extends { readonly name: string }>(
  tools: readonly T[],
): readonly T[] {
  return tools.filter((tool) => !isHiddenProcessTool(tool.name));
}

interface RoundShape {
  readonly reasoning: string;
  readonly text: string;
  readonly tools: readonly { readonly name: string }[];
}

/**
 * 这一轮是否只有提交调用（可能带正文），没有其他可见工具。
 *
 * 主对话用它连“准备提交”的思考一起隐藏；审查用它丢掉整个不可见分组。
 */
export function isSubmissionOnlyRound(round: RoundShape): boolean {
  const hasSubmit = round.tools.some((tool) => isHiddenProcessTool(tool.name));
  if (!hasSubmit) return false;
  return visibleProcessTools(round.tools).length === 0;
}

/** 工具 → 一行人话。label 永远是动作，detail 保留路径/参数摘要。 */
export function describeTool(tool: ProcTool): ToolDisplay {
  const args = parseArgs(tool.argsText);
  const name = tool.name;
  const action = actionForTool(name);
  const base = { action, label: ACTION_LABEL[action] };

  switch (name) {
    case 'read_file':
    case 'list_dir':
    case 'stat_path':
      return { ...base, detail: str(args, 'path'), icon: 'file' };
    case 'write_file':
    case 'make_dir':
    case 'remove_path':
    case 'apply_patch':
      return { ...base, detail: str(args, 'path'), icon: 'pencil' };
    case 'file_op': {
      // 一个入口三种动作：mkdir/remove 看 path，move 看 from → to；
      // 参数被截断时用另一侧兜底，仍然只暴露目标，不暴露工具名。
      const op = str(args, 'action');
      const detail =
        op === 'move'
          ? arrowDetail(args, 'from', 'to')
          : str(args, 'path') || arrowDetail(args, 'from', 'to');
      return { ...base, detail, icon: 'upload' };
    }
    case 'move_path': {
      return { ...base, detail: arrowDetail(args, 'from', 'to'), icon: 'pencil' };
    }
    case 'run_command':
      return { ...base, detail: runCommandText(args), icon: 'command' };
    case 'grep': {
      const query = str(args, 'query');
      const path = str(args, 'path');
      const glob = str(args, 'glob');
      return { ...base, detail: joinDetail(query, path, glob), icon: 'search' };
    }
    case 'glob': {
      const pattern = str(args, 'pattern');
      const path = str(args, 'path');
      return { ...base, detail: joinDetail(pattern, path), icon: 'search' };
    }
    case 'script_search':
    case 'document_search':
    case 'web_search':
      return { ...base, detail: str(args, 'query'), icon: 'search' };
    case 'web_fetch':
      return { ...base, detail: str(args, 'url'), icon: 'eye' };
    case 'desktop_observe': {
      // 观察类：截图看保存路径，其余看窗口；查经验看任务/应用。
      const op = str(args, 'action');
      const window = str(args, 'window');
      const path = str(args, 'path');
      if (op === 'screenshot') return { ...base, detail: path || window, icon: 'eye' };
      if (op === 'experience') {
        return {
          ...base,
          detail: joinDetail(str(args, 'task'), str(args, 'app')) || window,
          icon: 'eye',
        };
      }
      return { ...base, detail: window || str(args, 'name'), icon: 'eye' };
    }
    case 'desktop_act': {
      // 操作类：Office 转换看 source → target，其余看窗口 / 控件名。
      const op = str(args, 'action');
      const detail =
        op === 'convert_office'
          ? arrowDetail(args, 'source', 'target')
          : joinDetail(str(args, 'window'), str(args, 'name'));
      return { ...base, detail, icon: 'external' };
    }
    default:
      // 旧桌面工具（desktop_screenshot / desktop_uia_* / …）仍是操作：
      // 详情取路径 / 名称 / 窗口，保持历史 trace 的展示口径。
      if (name.startsWith('desktop_')) {
        return {
          ...base,
          detail: str(args, 'path') || str(args, 'name') || str(args, 'window') || '',
          icon: 'external',
        };
      }
      // 未知工具 / MCP：不把原始名带到折叠行，只显示“工具”；
      // 完整工具名、参数与结果在展开详情里看。
      return { ...base, detail: '', icon: 'sparkle' };
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
  const composition = new Map<ToolAction, number>();

  for (const round of args.rounds) {
    const tools = visibleProcessTools(round.tools);
    // 提交轮的思考只是在说“准备提交”，按要求整行隐藏。
    const hideThinking = isSubmissionOnlyRound(round);

    if (!hideThinking && round.reasoning.trim().length > 0) {
      thinkingCount += 1;
      lines.push({
        kind: 'thinking',
        key: `${round.round}-thinking`,
        round: round.round,
        text: round.reasoning,
      });
    }

    for (const tool of tools) {
      toolCount += 1;
      if (tool.status === 'denied') denied += 1;
      if (tool.status === 'error') failed += 1;
      const display = describeTool(tool);
      composition.set(display.action, (composition.get(display.action) ?? 0) + 1);
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
      composition: ACTION_ORDER.filter((action) => (composition.get(action) ?? 0) > 0).map(
        (action) => ({
          label: ACTION_LABEL[action],
          count: composition.get(action) ?? 0,
        }),
      ),
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
