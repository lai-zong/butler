/**
 * 适配器 · Node 文件系统
 *
 * 真实磁盘实现。core 层通过 `FileSystemPort` 使用它，不直接接触 `node:fs`。
 *
 * ⚠️ 这一层是**唯一**允许碰磁盘的地方（ADR 0004）。
 *    它不做权限判断 —— 权限由 ToolFramework 的闸门负责。
 *    两者职责不能混：适配器管"怎么读写"，闸门管"允不允许"。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  DEFAULT_MAX_READ_BYTES,
  FileSystemError,
  type DirEntry,
  type FileStat,
  type FileSystemPort,
} from '../../core/ports/fs.js';

export interface NodeFsOptions {
  /**
   * 工作根目录。所有相对路径基于它解析。
   *
   * ⚠️ 这不是沙箱 —— 绝对路径仍可访问。真沙箱需要容器或权限隔离，
   *    那属于部署层面的事，不在适配器的职责内。
   */
  readonly root: string;
}

export class NodeFileSystem implements FileSystemPort {
  private readonly root: string;

  constructor(opts: NodeFsOptions) {
    this.root = resolve(opts.root);
  }

  resolve(path: string): string {
    return isAbsolute(path) ? resolve(path) : resolve(this.root, path);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(path));
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat> {
    const abs = this.resolve(path);
    try {
      const st = await fs.stat(abs);
      return {
        path: abs,
        size: st.isDirectory() ? 0 : st.size,
        isDirectory: st.isDirectory(),
        modifiedAt: st.mtimeMs,
      };
    } catch (err) {
      throw this.translate(err, path);
    }
  }

  async readText(path: string, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<string> {
    const abs = this.resolve(path);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        throw new FileSystemError(`是目录而非文件：${path}`, 'IS_DIRECTORY');
      }
      if (st.size > maxBytes) {
        throw new FileSystemError(
          `文件 ${st.size} 字节，超过上限 ${maxBytes} 字节。请分段读取或用更精确的方式。`,
          'UNKNOWN',
        );
      }
      return await fs.readFile(abs, 'utf8');
    } catch (err) {
      if (err instanceof FileSystemError) throw err;
      throw this.translate(err, path);
    }
  }

  async writeText(path: string, content: string): Promise<number> {
    const abs = this.resolve(path);
    try {
      // 上级目录不存在时自动创建 —— 这是用户期待的默认行为
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return Buffer.byteLength(content, 'utf8');
    } catch (err) {
      throw this.translate(err, path);
    }
  }

  async listDir(path: string): Promise<readonly DirEntry[]> {
    const abs = this.resolve(path);
    try {
      const names = await fs.readdir(abs);
      const out: DirEntry[] = [];
      for (const name of names) {
        const child = resolve(abs, name);
        try {
          const st = await fs.stat(child);
          out.push({
            name,
            path: child,
            isDirectory: st.isDirectory(),
            size: st.isDirectory() ? 0 : st.size,
          });
        } catch {
          // 单个条目读不到（权限/竞态）不应让整个列举失败
          out.push({ name, path: child, isDirectory: false, size: 0 });
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      throw this.translate(err, path);
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await fs.mkdir(this.resolve(path), { recursive: true });
    } catch (err) {
      throw this.translate(err, path);
    }
  }

  /**
   * 删除。
   *
   * ⚠️ 递归必须显式声明 —— 与内存实现保持同一安全语义。
   *    目录非空且未声明递归时**拒绝**，而不是默默删掉。
   */
  async remove(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const abs = this.resolve(path);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        const children = await fs.readdir(abs);
        if (children.length > 0 && options?.recursive !== true) {
          throw new FileSystemError(
            `目录非空（${children.length} 项）。删除目录需显式递归。`,
            'EXISTS',
          );
        }
        await fs.rm(abs, { recursive: options?.recursive === true, force: false });
      } else {
        await fs.unlink(abs);
      }
    } catch (err) {
      if (err instanceof FileSystemError) throw err;
      throw this.translate(err, path);
    }
  }

  async move(from: string, to: string): Promise<void> {
    const fromAbs = this.resolve(from);
    const toAbs = this.resolve(to);
    try {
      await fs.mkdir(dirname(toAbs), { recursive: true });
      await fs.rename(fromAbs, toAbs);
    } catch (err) {
      // 跨设备重命名会失败（EXDEV），退化为复制 + 删除
      if ((err as { code?: string }).code === 'EXDEV') {
        await fs.cp(fromAbs, toAbs, { recursive: true });
        await fs.rm(fromAbs, { recursive: true, force: true });
        return;
      }
      throw this.translate(err, from);
    }
  }

  /** 供审计：路径的短哈希（避免日志里出现完整路径泄露目录结构）。 */
  hashPath(path: string): string {
    return createHash('sha256').update(this.resolve(path)).digest('hex').slice(0, 12);
  }

  /** 相对根目录的展示路径（界面显示用）。 */
  display(path: string): string {
    const abs = this.resolve(path);
    const rel = relative(this.root, abs);
    return rel.startsWith('..') ? abs : `.${sep}${rel}`;
  }

  private translate(err: unknown, path: string): FileSystemError {
    const code = (err as { code?: string }).code;
    switch (code) {
      case 'ENOENT':
        return new FileSystemError(`路径不存在：${path}`, 'NOT_FOUND');
      case 'EACCES':
      case 'EPERM':
        return new FileSystemError(`没有权限访问：${path}`, 'PERMISSION');
      case 'EISDIR':
        return new FileSystemError(`是目录而非文件：${path}`, 'IS_DIRECTORY');
      case 'ENOTDIR':
        return new FileSystemError(`不是目录：${path}`, 'NOT_DIRECTORY');
      case 'EEXIST':
        return new FileSystemError(`已存在：${path}`, 'EXISTS');
      default:
        return new FileSystemError(
          `文件系统错误（${String(code ?? '未知')}）：${err instanceof Error ? err.message : String(err)}`,
          'UNKNOWN',
        );
    }
  }
}
