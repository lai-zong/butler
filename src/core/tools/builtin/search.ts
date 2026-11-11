/**
 * 只读检索工具：按文件名找文件（glob）、按内容找行（grep）。
 *
 * ★ 为什么单独成组：它们和“读一个已知文件”不同，是 Agent 在
 *   不知道路径时定位证据的基础能力；只读、不进入写入链路。
 */

import type { FileSystemPort } from '../../ports/fs.js';
import type { ToolResult, ToolSpec } from '../types.js';

const SKIP_DIRS = new Set(['.git', '.next', 'node_modules', '.butler-data', '.cache']);
const MAX_FILES = 4000;

interface WalkEntry {
  readonly absolute: string;
  readonly relative: string;
  readonly isDirectory: boolean;
}

function slash(path: string): string {
  return path.replace(/\\/g, '/');
}

function globToRegExp(glob: string): RegExp {
  const text = slash(glob.trim());
  let out = '^';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '*') {
      if (text[i + 1] === '*') {
        i += 1;
        if (text[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\.+^$(){}|[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

async function walk(
  fs: FileSystemPort,
  start: string,
  root: string,
): Promise<readonly WalkEntry[]> {
  const out: WalkEntry[] = [];
  const queue = [start];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await fs.listDir(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) break;
      const relative = slash(entry.path)
        .replace(slash(root).replace(/\/$/, ''), '')
        .replace(/^\/+/, '');
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        out.push({ absolute: entry.path, relative, isDirectory: true });
        queue.push(entry.path);
      } else {
        out.push({ absolute: entry.path, relative, isDirectory: false });
      }
    }
  }
  return out;
}

function countLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function globTool(fs: FileSystemPort): ToolSpec {
  return {
    name: 'glob',
    description:
      '按文件名/通配符查找工作区里的文件，例如 **/*.ts、docs/*.md。' +
      '只返回路径，不读取文件内容；需要看内容再用 read_file 或 grep。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '通配符，例如 **/*.ts' },
        path: { type: 'string', description: '从哪个目录开始，默认工作区根目录' },
        maxResults: { type: 'number', description: '最多返回多少个，1—200，默认 80' },
      },
      required: ['pattern'],
    },
    tier: 'readOnly',
    summarize: (args) =>
      `找文件 ${String((args as { pattern?: unknown })?.pattern ?? '?')}`,
    async execute(args, ctx): Promise<ToolResult> {
      const started = ctx.clock.now();
      const a = args as { pattern?: string; path?: string; maxResults?: number };
      const pattern = typeof a.pattern === 'string' ? a.pattern.trim() : '';
      if (pattern.length === 0) {
        return { ok: false, output: 'pattern 不能为空', isError: true, durationMs: 0 };
      }
      const base = typeof a.path === 'string' && a.path.trim().length > 0 ? a.path : '.';
      const root = fs.resolve(base);
      const limit = typeof a.maxResults === 'number' ? Math.max(1, Math.min(200, a.maxResults)) : 80;
      let matcher: RegExp;
      try {
        matcher = globToRegExp(pattern);
      } catch {
        return { ok: false, output: `无效的通配符：${pattern}`, isError: true, durationMs: 0 };
      }
      const files = await walk(fs, base, root);
      const hits = files
        .filter((entry) => !entry.isDirectory && matcher.test(entry.relative))
        .slice(0, limit)
        .map((entry) => entry.relative);
      return {
        ok: true,
        output:
          hits.length === 0
            ? `没有找到匹配 ${pattern} 的文件。`
            : `找到 ${hits.length} 个文件：\n${hits.join('\n')}`,
        data: { files: hits },
        durationMs: ctx.clock.now() - started,
      };
    },
  };
}

export function grepTool(fs: FileSystemPort): ToolSpec {
  return {
    name: 'grep',
    description:
      '在工作区文件内容里搜索文本或正则，返回文件、行号和命中行。' +
      '适合“找出所有提到某关键词的文件”，不要用它读取整个大文件。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的文本或正则' },
        path: { type: 'string', description: '从哪个目录开始，默认工作区根目录' },
        glob: { type: 'string', description: '只搜索匹配此通配符的文件，例如 **/*.ts' },
        caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
        maxResults: { type: 'number', description: '最多返回多少条，1—200，默认 80' },
      },
      required: ['query'],
    },
    tier: 'readOnly',
    summarize: (args) =>
      `搜索内容 ${String((args as { query?: unknown })?.query ?? '?')}`,
    async execute(args, ctx): Promise<ToolResult> {
      const started = ctx.clock.now();
      const a = args as {
        query?: string;
        path?: string;
        glob?: string;
        caseSensitive?: boolean;
        maxResults?: number;
      };
      const query = typeof a.query === 'string' ? a.query.trim() : '';
      if (query.length === 0) {
        return { ok: false, output: 'query 不能为空', isError: true, durationMs: 0 };
      }
      let matcher: RegExp;
      try {
        matcher = new RegExp(query, a.caseSensitive === true ? '' : 'i');
      } catch (err) {
        return {
          ok: false,
          output: `无效的正则：${err instanceof Error ? err.message : String(err)}`,
          isError: true,
          durationMs: 0,
        };
      }
      const base = typeof a.path === 'string' && a.path.trim().length > 0 ? a.path : '.';
      const root = fs.resolve(base);
      const all = await walk(fs, base, root);
      let fileMatcher: RegExp | null = null;
      if (typeof a.glob === 'string' && a.glob.trim().length > 0) {
        try {
          fileMatcher = globToRegExp(a.glob);
        } catch {
          return { ok: false, output: 'glob 格式无效', isError: true, durationMs: 0 };
        }
      }
      const limit = typeof a.maxResults === 'number' ? Math.max(1, Math.min(200, a.maxResults)) : 80;
      const hits: string[] = [];
      for (const entry of all) {
        if (entry.isDirectory || hits.length >= limit) continue;
        if (fileMatcher !== null && !fileMatcher.test(entry.relative)) continue;
        let text: string;
        try {
          text = await fs.readText(entry.absolute, 1024 * 1024);
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue;
        for (const [index, line] of countLines(text).entries()) {
          if (hits.length >= limit) break;
          if (!matcher.test(line)) continue;
          const clipped = line.length > 240 ? `${line.slice(0, 240)}…` : line;
          hits.push(`${entry.relative}:${index + 1}: ${clipped}`);
        }
      }
      return {
        ok: true,
        output:
          hits.length === 0
            ? `没有找到「${query}」。`
            : `找到 ${hits.length} 条命中：\n${hits.join('\n')}`,
        data: { matches: hits },
        durationMs: ctx.clock.now() - started,
      };
    },
  };
}
