/**
 * 内存文件系统 —— 测试用实现
 *
 * 用途：工具测试不碰真实磁盘（快、可重复、不会误删用户文件）。
 *
 * 同时它是**浏览器适配器的雏形** —— 接口完全一致，
 * 差别只在持久化后端（这里是 Map，未来是 File System Access API）。
 */

import {
  FileSystemError,
  type DirEntry,
  type FileStat,
  type FileSystemPort,
} from '../../core/ports/fs.js';

interface Node {
  readonly path: string;
  readonly isDirectory: boolean;
  content: string;
  modifiedAt: number;
}

export interface MemoryFsOptions {
  /** 初始时间戳，保证测试确定 */
  readonly now?: number;
}

export class MemoryFileSystem implements FileSystemPort {
  private readonly nodes = new Map<string, Node>();
  private readonly root: string;
  private clock: number;

  constructor(opts: MemoryFsOptions = {}) {
    this.root = '/root';
    this.clock = opts.now ?? 1_760_000_000_000;
    this.nodes.set(this.root, {
      path: this.root,
      isDirectory: true,
      content: '',
      modifiedAt: this.clock,
    });
  }

  /** 测试辅助：直接投喂一个文件。 */
  seedFile(path: string, content: string): void {
    const abs = this.resolve(path);
    const parent = this.parentOf(abs);
    if (!this.nodes.has(parent)) this.seedDir(parent);
    this.nodes.set(abs, { path: abs, isDirectory: false, content, modifiedAt: this.clock });
  }

  /** 测试辅助：直接投喂一个目录。 */
  seedDir(path: string): void {
    const abs = this.resolve(path);
    if (this.nodes.has(abs)) return;
    const parent = this.parentOf(abs);
    if (parent !== abs && !this.nodes.has(parent)) this.seedDir(parent);
    this.nodes.set(abs, { path: abs, isDirectory: true, content: '', modifiedAt: this.clock });
  }

  resolve(path: string): string {
    if (path.startsWith('/')) return normalize(path);
    return normalize(`${this.root}/${path}`);
  }

  async exists(path: string): Promise<boolean> {
    return this.nodes.has(this.resolve(path));
  }

  async stat(path: string): Promise<FileStat> {
    const n = this.nodes.get(this.resolve(path));
    if (!n) throw new FileSystemError(`路径不存在：${path}`, 'NOT_FOUND');
    return {
      path: n.path,
      size: n.isDirectory ? 0 : n.content.length,
      isDirectory: n.isDirectory,
      modifiedAt: n.modifiedAt,
    };
  }

  async readText(path: string, maxBytes?: number): Promise<string> {
    const n = this.nodes.get(this.resolve(path));
    if (!n) throw new FileSystemError(`路径不存在：${path}`, 'NOT_FOUND');
    if (n.isDirectory) throw new FileSystemError(`是目录而非文件：${path}`, 'IS_DIRECTORY');
    if (maxBytes !== undefined && n.content.length > maxBytes) {
      throw new FileSystemError(
        `文件 ${n.content.length} 字节，超过上限 ${maxBytes} 字节。请分段读取或改用更精确的方式。`,
        'UNKNOWN',
      );
    }
    return n.content;
  }

  async writeText(path: string, content: string): Promise<number> {
    const abs = this.resolve(path);
    const parent = this.parentOf(abs);
    const parentNode = this.nodes.get(parent);
    if (!parentNode) throw new FileSystemError(`上级目录不存在：${parent}`, 'NOT_FOUND');
    if (!parentNode.isDirectory) throw new FileSystemError(`上级不是目录：${parent}`, 'NOT_DIRECTORY');

    const existing = this.nodes.get(abs);
    if (existing?.isDirectory) throw new FileSystemError(`是目录：${abs}`, 'IS_DIRECTORY');

    this.clock += 1000;
    this.nodes.set(abs, { path: abs, isDirectory: false, content, modifiedAt: this.clock });
    return content.length;
  }

  async listDir(path: string): Promise<readonly DirEntry[]> {
    const abs = this.resolve(path);
    const n = this.nodes.get(abs);
    if (!n) throw new FileSystemError(`路径不存在：${path}`, 'NOT_FOUND');
    if (!n.isDirectory) throw new FileSystemError(`不是目录：${path}`, 'NOT_DIRECTORY');

    return [...this.nodes.values()]
      .filter((x) => x.path !== abs && this.parentOf(x.path) === abs)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((x) => ({
        name: x.path.slice(abs.length + 1),
        path: x.path,
        isDirectory: x.isDirectory,
        size: x.isDirectory ? 0 : x.content.length,
      }));
  }

  async mkdir(path: string): Promise<void> {
    this.seedDir(path);
  }

  async remove(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const abs = this.resolve(path);
    const n = this.nodes.get(abs);
    if (!n) throw new FileSystemError(`路径不存在：${path}`, 'NOT_FOUND');
    if (abs === this.root) throw new FileSystemError('不允许删除根目录', 'PERMISSION');

    if (n.isDirectory) {
      const children = [...this.nodes.keys()].filter((p) => p !== abs && p.startsWith(`${abs}/`));
      if (children.length > 0 && options?.recursive !== true) {
        throw new FileSystemError(
          `目录非空（${children.length} 项）。删除目录需显式递归。`,
          'EXISTS',
        );
      }
      for (const c of children) this.nodes.delete(c);
    }
    this.nodes.delete(abs);
  }

  async move(from: string, to: string): Promise<void> {
    const fromAbs = this.resolve(from);
    const toAbs = this.resolve(to);
    const n = this.nodes.get(fromAbs);
    if (!n) throw new FileSystemError(`路径不存在：${from}`, 'NOT_FOUND');

    const parent = this.parentOf(toAbs);
    if (!this.nodes.has(parent)) throw new FileSystemError(`目标上级目录不存在：${parent}`, 'NOT_FOUND');

    this.clock += 1000;
    // 移动目录时一并搬子树
    const affected = [...this.nodes.keys()].filter((p) => p === fromAbs || p.startsWith(`${fromAbs}/`));
    for (const p of affected) {
      const node = this.nodes.get(p);
      if (!node) continue;
      this.nodes.delete(p);
      const newPath = toAbs + p.slice(fromAbs.length);
      this.nodes.set(newPath, { ...node, path: newPath, modifiedAt: this.clock });
    }
  }

  private parentOf(abs: string): string {
    const idx = abs.lastIndexOf('/');
    return idx <= 0 ? '/' : abs.slice(0, idx);
  }
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}
