/**
 * 内置工具集 —— 六类基础工具
 *
 * 设计依据：方案 § 6（三层能力模型·基础层）
 *
 * ⚠️ 答辩措辞纪律（方案 § 6.2）：
 *    这一层是**对标主流 Agent 工具的基本能力**，**不作为创新点宣称**。
 *    差异化在"记忆化执行"（记住哪种方式在这台机器上更可靠），
 *    不在"我们有文件读写"。
 *
 * 分级依据是**后果的不可逆程度**：
 *   · 读文件、列目录、搜索        → readOnly（自动放行）
 *   · 写文件、建目录              → normal（需确认）
 *   · 移动、覆盖                  → highRisk（需确认 + 预览）
 *   · 递归删除                    → dangerous（默认禁用）
 */

import type { FileSystemPort } from '../../ports/fs.js';
import { FileSystemError } from '../../ports/fs.js';
import type { DirEntry } from '../../ports/fs.js';
import type { ToolContext, ToolSpec } from '../types.js';

/** 把文件系统错误转成模型能理解的一句话。 */
function fsMessage(err: unknown): string {
  if (err instanceof FileSystemError) {
    const map: Record<FileSystemError['code'], string> = {
      NOT_FOUND: '路径不存在',
      PERMISSION: '没有权限',
      IS_DIRECTORY: '这是一个目录，不是文件',
      NOT_DIRECTORY: '这不是一个目录',
      EXISTS: '目标已存在',
      UNKNOWN: '未知错误',
    };
    return `${map[err.code]}：${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ═══════════════════════════════════════════════════════════
// ① 文件读取（readOnly）
// ═══════════════════════════════════════════════════════════

export function readFileTool(fs: FileSystemPort): ToolSpec {
  return {
    name: 'read_file',
    description:
      '读取一个文本文件的内容。适合看配置、源码、文档。' +
      '不要用它读二进制文件（图片、压缩包）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对或绝对）' },
        maxBytes: {
          type: 'number',
          description: '最大读取字节数，默认 1MiB。超过会报错，请改用更精确的方式。',
        },
      },
      required: ['path'],
    },
    tier: 'readOnly',
    summarize: (args: unknown) => `读取文件 ${String((args as { path?: unknown })?.path ?? '?')}`,
    async execute(args: unknown, ctx: ToolContext) {
      const a = args as { path?: string; maxBytes?: number };
      if (typeof a?.path !== 'string') {
        return { ok: false, output: '参数错误：path 必须是字符串', isError: true, durationMs: 0 };
      }
      const started = ctx.clock.now();
      try {
        const text = await fs.readText(a.path, a.maxBytes);
        const lines = text.split('\n').length;
        return {
          ok: true,
          output: text,
          data: { path: fs.resolve(a.path), bytes: text.length, lines },
          durationMs: ctx.clock.now() - started,
        };
      } catch (err) {
        return {
          ok: false,
          output: fsMessage(err),
          isError: true,
          durationMs: ctx.clock.now() - started,
        };
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════
// ② 列目录（readOnly）
// ═══════════════════════════════════════════════════════════

export function listDirTool(fs: FileSystemPort): ToolSpec {
  return {
    name: 'list_dir',
    description: '列出一个目录下的文件和子目录（不递归）。用于先了解结构再决定读哪个文件。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径' } },
      required: ['path'],
    },
    tier: 'readOnly',
    summarize: (args: unknown) => `列出目录 ${String((args as { path?: unknown })?.path ?? '?')}`,
    async execute(args: unknown, ctx: ToolContext) {
      const a = args as { path?: string };
      if (typeof a?.path !== 'string') {
        return { ok: false, output: '参数错误：path 必须是字符串', isError: true, durationMs: 0 };
      }
      const started = ctx.clock.now();
      try {
        const entries = await fs.listDir(a.path);
        const lines = entries
          .map((e: DirEntry) => `${e.isDirectory ? '[目录]' : '      '} ${e.name}${e.isDirectory ? '' : `  (${e.size}B)`}`)
          .join('\n');
        return {
          ok: true,
          output: `${entries.length} 项：\n${lines}`,
          data: { entries },
          durationMs: ctx.clock.now() - started,
        };
      } catch (err) {
        return {
          ok: false,
          output: fsMessage(err),
          isError: true,
          durationMs: ctx.clock.now() - started,
        };
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════
// ③ 写入文件（normal）
// ═══════════════════════════════════════════════════════════

export function writeFileTool(fs: FileSystemPort): ToolSpec {
  return {
    name: 'write_file',
    description:
      '把内容写入一个文件。若文件已存在会**覆盖**。' +
      '写新文件或完全替换内容时用它；只改几行应当用编辑类工具（若可用）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['path', 'content'],
    },
    tier: 'normal',
    summarize: (args: unknown) => {
      const a = args as { path?: unknown; content?: unknown };
      const len = typeof a?.content === 'string' ? a.content.length : 0;
      return `写入文件 ${String(a?.path ?? '?')}（${len} 字符）`;
    },
    async preview(args: unknown) {
      const a = args as { path?: string; content?: string };
      const path = a?.path ?? '?';
      const exists = await fs.exists(path).catch(() => false);
      if (!exists) return `将新建文件：${path}`;

      // 已存在 → 告诉用户"这会覆盖多少内容"，而不是笼统说"会覆盖"
      try {
        const before = await fs.readText(path).catch(() => '');
        const after = a?.content ?? '';
        const beforeLines = before.split('\n').length;
        const afterLines = after.split('\n').length;
        return `将覆盖已有文件：${path}\n原 ${beforeLines} 行 → 新 ${afterLines} 行`;
      } catch {
        return `将覆盖已有文件：${path}`;
      }
    },
    async execute(args: unknown, ctx: ToolContext) {
      const a = args as { path?: string; content?: string };
      if (typeof a?.path !== 'string' || typeof a?.content !== 'string') {
        return {
          ok: false,
          output: '参数错误：需要 path 与 content 两个字符串',
          isError: true,
          durationMs: 0,
        };
      }
      const started = ctx.clock.now();
      try {
        const bytes = await fs.writeText(a.path, a.content);
        return {
          ok: true,
          output: `已写入 ${fs.resolve(a.path)}（${bytes} 字节）`,
          data: { path: fs.resolve(a.path), bytes },
          durationMs: ctx.clock.now() - started,
        };
      } catch (err) {
        return {
          ok: false,
          output: fsMessage(err),
          isError: true,
          durationMs: ctx.clock.now() - started,
        };
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════
// ④ 建目录（normal）
// ═══════════════════════════════════════════════════════════

export function makeDirTool(fs: FileSystemPort): ToolSpec {
  return {
    name: 'make_dir',
    description: '创建一个目录（含缺失的上级目录）。已存在时不报错。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径' } },
      required: ['path'],
    },
    tier: 'normal',
    summarize: (args: unknown) => `创建目录 ${String((args as { path?: unknown })?.path ?? '?')}`,
    async execute(args: unknown, ctx: ToolContext) {
      const a = args as { path?: string };
      if (typeof a?.path !== 'string') {
        return { ok: false, output: '参数错误：path 必须是字符串', isError: true, durationMs: 0 };
      }
      const started = ctx.clock.now();
      try {
        await fs.mkdir(a.path);
        return {
          ok: true,
          output: `已创建目录 ${fs.resolve(a.path)}`,
          durationMs: ctx.clock.now() - started,
        };
      } catch (err) {
        return { ok: false, output: fsMessage(err), isError: true, durationMs: ctx.clock.now() - started };
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════
// ⑤ 移动 / 重命名（highRisk）
// ═══════════════════════════════════════════════════════════

export function moveTool(fs: FileSystemPort): ToolSpec {
  return {
    name: 'move_path',
    description: '移动或重命名文件与目录。**原路径会消失**，属于难以撤销的操作。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '原路径' },
        to: { type: 'string', description: '目标路径' },
      },
      required: ['from', 'to'],
    },
    tier: 'highRisk',
    summarize: (args: unknown) => {
      const a = args as { from?: unknown; to?: unknown };
      return `移动 ${String(a?.from ?? '?')} → ${String(a?.to ?? '?')}`;
    },
    async preview(args: unknown) {
      const a = args as { from?: string; to?: string };
      const from = a?.from ?? '?';
      const to = a?.to ?? '?';
      const fromExists = await fs.exists(from).catch(() => false);
      const toExists = await fs.exists(to).catch(() => false);
      const parts = [`将移动：${from} → ${to}`];
      if (!fromExists) parts.push('⚠️ 原路径不存在');
      if (toExists) parts.push('⚠️ 目标已存在，可能被覆盖');
      return parts.join('\n');
    },
    async execute(args: unknown, ctx: ToolContext) {
      const a = args as { from?: string; to?: string };
      if (typeof a?.from !== 'string' || typeof a?.to !== 'string') {
        return { ok: false, output: '参数错误：需要 from 与 to', isError: true, durationMs: 0 };
      }
      const started = ctx.clock.now();
      try {
        await fs.move(a.from, a.to);
        return {
          ok: true,
          output: `已移动 ${fs.resolve(a.from)} → ${fs.resolve(a.to)}`,
          durationMs: ctx.clock.now() - started,
        };
      } catch (err) {
        return { ok: false, output: fsMessage(err), isError: true, durationMs: ctx.clock.now() - started };
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════
// ⑥ 删除（dangerous，默认禁用）
// ═══════════════════════════════════════════════════════════

export function removeTool(fs: FileSystemPort): ToolSpec {
  return {
    name: 'remove_path',
    description:
      '删除文件或目录。**不可恢复**。目录删除必须显式传 recursive=true。' +
      '该工具默认禁用，需在设置中开启危险操作。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的路径' },
        recursive: {
          type: 'boolean',
          description: '是否递归删除目录。删除目录时必须为 true，默认 false。',
        },
      },
      required: ['path'],
    },
    tier: 'dangerous',
    summarize: (args: unknown) => {
      const a = args as { path?: unknown; recursive?: unknown };
      return `删除 ${String(a?.path ?? '?')}${a?.recursive === true ? '（含子内容）' : ''}`;
    },
    async preview(args: unknown) {
      const a = args as { path?: string; recursive?: boolean };
      const path = a?.path ?? '?';
      try {
        const st = await fs.stat(path);
        if (!st.isDirectory) return `将删除文件：${path}（${st.size} 字节）\n⚠️ 不可恢复`;
        const entries = await fs.listDir(path);
        const names = entries.slice(0, 15).map((e: DirEntry) => `  · ${e.name}`).join('\n');
        const more = entries.length > 15 ? `\n  …另有 ${entries.length - 15} 项` : '';
        return `将删除目录：${path}\n包含 ${entries.length} 项：\n${names}${more}\n⚠️ 不可恢复`;
      } catch {
        return `将删除：${path}\n⚠️ 不可恢复`;
      }
    },
    async execute(args: unknown, ctx: ToolContext) {
      const a = args as { path?: string; recursive?: boolean };
      if (typeof a?.path !== 'string') {
        return { ok: false, output: '参数错误：path 必须是字符串', isError: true, durationMs: 0 };
      }
      const started = ctx.clock.now();
      try {
        // 安全边界：删目录必须显式声明 recursive，避免"想删个文件结果删了整个目录"
        await fs.remove(a.path, a.recursive === true ? { recursive: true } : {});
        return {
          ok: true,
          output: `已删除 ${fs.resolve(a.path)}`,
          durationMs: ctx.clock.now() - started,
        };
      } catch (err) {
        return { ok: false, output: fsMessage(err), isError: true, durationMs: ctx.clock.now() - started };
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════
// ⑦ 路径信息（readOnly）
// ═══════════════════════════════════════════════════════════

export function statTool(fs: FileSystemPort): ToolSpec {
  return {
    name: 'stat_path',
    description: '查看路径的类型、大小与修改时间。在想确认"这是文件还是目录"时用它。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '路径' } },
      required: ['path'],
    },
    tier: 'readOnly',
    summarize: (args: unknown) => `查看路径信息 ${String((args as { path?: unknown })?.path ?? '?')}`,
    async execute(args: unknown, ctx: ToolContext) {
      const a = args as { path?: string };
      if (typeof a?.path !== 'string') {
        return { ok: false, output: '参数错误：path 必须是字符串', isError: true, durationMs: 0 };
      }
      const started = ctx.clock.now();
      try {
        const st = await fs.stat(a.path);
        const kind = st.isDirectory ? '目录' : '文件';
        const time = new Date(st.modifiedAt).toISOString();
        return {
          ok: true,
          output: `${fs.resolve(a.path)}\n类型：${kind}\n大小：${st.size} 字节\n修改时间：${time}`,
          data: st,
          durationMs: ctx.clock.now() - started,
        };
      } catch (err) {
        return { ok: false, output: fsMessage(err), isError: true, durationMs: ctx.clock.now() - started };
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════

/**
 * 六类基础工具（文件读写 · 目录 · 路径信息）。
 *
 * ⚠️ 命令执行与网页抓取**刻意不在这里** ——
 *    它们需要独立的沙箱与超时策略，会单独成组。
 */
export function fileTools(fs: FileSystemPort): readonly ToolSpec[] {
  return [
    readFileTool(fs),
    listDirTool(fs),
    writeFileTool(fs),
    makeDirTool(fs),
    moveTool(fs),
    removeTool(fs),
    statTool(fs),
  ];
}
