/**
 * 工作区文件服务（工作区面板的后端）
 *
 * ★ 面板是**用户自己**在改文件，不是 AI 在调工具，所以权限策略不同：
 *   · 会话的 `read-only` 不限制用户手动保存（用户没把电脑锁给自己）；
 *   · 但**受保护路径**与**工作区边界**任何情况下都不放开。
 *
 * ★ 每次保存都落一条 `file.edited` 事件（只记路径/大小/指纹，不记内容）：
 *   AI 写文件有 `tool.call` 留痕，用户手改也必须能查到"这个文件是谁改成这样的"。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ClockPort } from '@/core/ports/clock.js';
import type { EventLog } from '@/core/events/log.js';
import { isPathInside, resolveRealPathForGuard } from './sessionWorkspace.js';

/** 文本编辑上限（编辑器不是二进制查看器）。 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** 单目录最多返回多少项，避免把界面卡死。 */
const MAX_ENTRIES = 500;

const IMAGE_MIME: Readonly<Record<string, string>> = {
  // PDF 也走这里：浏览器内置查看器直接渲染，不需要我们解析
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

export class WorkspaceFileError extends Error {
  override readonly name = 'WorkspaceFileError';
  constructor(
    message: string,
    readonly code:
      | 'outside_workspace'
      | 'protected'
      | 'not_found'
      | 'not_a_file'
      | 'not_a_directory'
      | 'too_large'
      | 'not_text'
      | 'conflict'
      | 'bad_path',
  ) {
    super(message);
  }
}

export interface WorkspaceEntry {
  readonly name: string;
  /** 相对工作区的路径（用 `/` 分隔，界面直接用） */
  readonly path: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface WorkspaceTextFile {
  readonly path: string;
  readonly content: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** 内容指纹；保存时带回来做冲突检测 */
  readonly sha256: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  if (rel === '') return '.';
  return rel.split(sep).join('/');
}

/**
 * 把界面传来的相对路径解析成工作区内的绝对路径。
 *
 * 两道检查：字面 resolve 必须在工作区内；**真实路径**（含父目录）也必须在。
 * 后者防的是"工作区里有个 junction 指向外面"。
 */
export async function resolveWorkspacePath(
  root: string,
  protectedPaths: readonly string[],
  inputPath: string,
): Promise<{ absolute: string; relative: string }> {
  const raw = inputPath.trim();
  if (raw.length === 0) throw new WorkspaceFileError('路径不能为空', 'bad_path');

  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (!isPathInside(root, absolute)) {
    throw new WorkspaceFileError(`路径不在工作区内：${inputPath}`, 'outside_workspace');
  }
  for (const p of protectedPaths) {
    if (isPathInside(p, absolute)) {
      throw new WorkspaceFileError('这是受保护的路径，面板不能修改。', 'protected');
    }
  }

  const realRoot = await resolveRealPathForGuard(root);
  const realTarget = await resolveRealPathForGuard(absolute);
  if (!isPathInside(realRoot, realTarget)) {
    throw new WorkspaceFileError(`真实路径不在工作区内：${inputPath}`, 'outside_workspace');
  }
  for (const p of protectedPaths) {
    const realP = await resolveRealPathForGuard(p);
    if (isPathInside(realP, realTarget)) {
      throw new WorkspaceFileError('这是受保护的路径，面板不能修改。', 'protected');
    }
  }

  return { absolute, relative: toRelative(root, absolute) };
}

/** 列目录（不跨符号链接，不返回受保护路径）。 */
export async function listWorkspace(
  root: string,
  protectedPaths: readonly string[],
  inputPath = '.',
): Promise<{ root: string; path: string; entries: readonly WorkspaceEntry[] }> {
  const { absolute, relative } = await resolveWorkspacePath(root, protectedPaths, inputPath);

  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new WorkspaceFileError('目录不存在', 'not_found');
  }
  if (!info.isDirectory()) throw new WorkspaceFileError('这不是目录', 'not_a_directory');

  const dirents = await readdir(absolute, { withFileTypes: true });
  const entries: WorkspaceEntry[] = [];
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    const childAbs = join(absolute, dirent.name);
    let childInfo;
    try {
      childInfo = await stat(childAbs);
    } catch {
      continue;
    }
    // 符号链接只显示、不进入：避免"点一下目录跑到了工作区外"
    const isLink = dirent.isSymbolicLink();
    if (protectedPaths.some((p) => isPathInside(p, childAbs))) continue;
    entries.push({
      name: dirent.name,
      path: relative === '.' ? dirent.name : `${relative}/${dirent.name}`,
      isDirectory: isLink ? false : childInfo.isDirectory(),
      isSymbolicLink: isLink,
      size: childInfo.isDirectory() ? 0 : childInfo.size,
      mtimeMs: childInfo.mtimeMs,
    });
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return { root, path: relative, entries };
}

/** 读文本文件（编辑器用）。 */
export async function readWorkspaceText(
  root: string,
  protectedPaths: readonly string[],
  inputPath: string,
): Promise<WorkspaceTextFile> {
  const { absolute, relative } = await resolveWorkspacePath(root, protectedPaths, inputPath);

  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new WorkspaceFileError('文件不存在', 'not_found');
  }
  if (!info.isFile()) throw new WorkspaceFileError('这不是文件', 'not_a_file');
  if (info.size > MAX_TEXT_BYTES) {
    throw new WorkspaceFileError(`文件超过 ${Math.round(MAX_TEXT_BYTES / 1024)} KB，面板不打开`, 'too_large');
  }

  const buffer = await readFile(absolute);
  // 含 NUL 的一律按二进制处理：编辑器打开会变成乱码，不如直接说清楚
  if (buffer.includes(0)) throw new WorkspaceFileError('这不是文本文件', 'not_text');
  const content = buffer.toString('utf8');

  return { path: relative, content, size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(content) };
}

/** 读图片 / PDF 等二进制（预览用）。 */
export async function readWorkspaceRaw(
  root: string,
  protectedPaths: readonly string[],
  inputPath: string,
): Promise<{ buffer: Buffer; mime: string; size: number }> {
  const { absolute } = await resolveWorkspacePath(root, protectedPaths, inputPath);
  const mime = IMAGE_MIME[extname(absolute).toLowerCase()];
  if (mime === undefined) throw new WorkspaceFileError('这种文件不在预览白名单里', 'not_text');

  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new WorkspaceFileError('文件不存在', 'not_found');
  }
  if (!info.isFile()) throw new WorkspaceFileError('这不是文件', 'not_a_file');

  const buffer = await readFile(absolute);
  return { buffer, mime, size: info.size };
}

/**
 * 读任意文件字节（供服务端解析预览，不对外直出）。
 *
 * ★ 与 `readWorkspaceRaw` 的区别：后者是**直接回给浏览器**的端点，所以只放行
 *   图片/PDF；docx/xlsx 需要读进内存解析，不能因为 MIME 白名单被挡在门外。
 *   两者共用同一套工作区/受保护路径校验。
 */
export async function readWorkspaceBytes(
  root: string,
  protectedPaths: readonly string[],
  inputPath: string,
): Promise<{ buffer: Buffer; size: number; extension: string }> {
  const { absolute } = await resolveWorkspacePath(root, protectedPaths, inputPath);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new WorkspaceFileError('文件不存在', 'not_found');
  }
  if (!info.isFile()) throw new WorkspaceFileError('这不是文件', 'not_a_file');
  const buffer = await readFile(absolute);
  return { buffer, size: info.size, extension: extname(absolute).toLowerCase() };
}

/** 保存文本（带冲突检测 + 事件留痕）。 */
export async function writeWorkspaceText(args: {
  readonly root: string;
  readonly protectedPaths: readonly string[];
  readonly path: string;
  readonly content: string;
  /** 界面打开文件时拿到的指纹；不等于当前指纹说明文件已被别人改过 */
  readonly baseSha?: string;
  readonly log: EventLog;
  readonly clock: ClockPort;
}): Promise<{ path: string; sha256: string; size: number; mtimeMs: number }> {
  const { absolute, relative } = await resolveWorkspacePath(args.root, args.protectedPaths, args.path);

  const bytes = Buffer.byteLength(args.content, 'utf8');
  if (bytes > MAX_TEXT_BYTES) {
    throw new WorkspaceFileError(`内容超过 ${Math.round(MAX_TEXT_BYTES / 1024)} KB，不能保存`, 'too_large');
  }

  let previousSha: string | undefined;
  let exists = true;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new WorkspaceFileError('目标不是文件', 'not_a_file');
    const current = await readFile(absolute);
    previousSha = sha256(current.toString('utf8'));
  } catch (err) {
    if (err instanceof WorkspaceFileError) throw err;
    exists = false;
  }

  if (exists && args.baseSha !== undefined && previousSha !== undefined && previousSha !== args.baseSha) {
    throw new WorkspaceFileError('文件已被外部修改，请重新打开后再保存', 'conflict');
  }

  /**
   * ⚠️ 父目录必须重新校验：
   *    新文件本身不存在，`resolveRealPathForGuard` 只能解析到父目录，
   *    上面那次检查已经覆盖；这里再确认父目录没有变成链接。
   */
  const parent = dirname(absolute);
  const realParent = await resolveRealPathForGuard(parent);
  const realRoot = await resolveRealPathForGuard(args.root);
  if (!isPathInside(realRoot, realParent)) {
    throw new WorkspaceFileError('父目录不在工作区内', 'outside_workspace');
  }

  await mkdir(parent, { recursive: true });
  const tmp = `${absolute}.${process.pid}.tmp`;
  const text = args.content;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, absolute);

  const nextSha = sha256(text);
  const info = await stat(absolute);

  args.log.append({
    type: 'file.edited',
    actor: 'user',
    payload: {
      path: relative,
      source: 'panel',
      bytes,
      sha256: nextSha,
      ...(previousSha !== undefined ? { previousSha256: previousSha } : {}),
    },
    createdAt: args.clock.now(),
  });

  return { path: relative, sha256: nextSha, size: bytes, mtimeMs: info.mtimeMs };
}
