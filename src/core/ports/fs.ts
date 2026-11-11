/**
 * 端口 · 文件系统
 *
 * 设计依据：ADR 0004（核心层框架无关）
 *
 * 核心层要做文件操作，但不能直接 import `node:fs` ——
 * 那样它就无法在浏览器里跑（本地优先架构下，界面侧也要能读写文件）。
 *
 * 所以用端口把"文件系统"抽象出来：
 *   · Node 侧由 adapters/fs/node.ts 实现（真实磁盘）
 *   · 浏览器侧由 adapters/fs/browser.ts 实现（File System Access API 或 IndexedDB）
 *   · 测试用 adapters/fs/memory.ts（内存实现）
 */

export interface FileStat {
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
  readonly modifiedAt: number;
}

export interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size: number;
  /**
   * 是否符号链接 / junction / 快捷方式。
   *
   * ★ 遍历类工具（grep/glob）必须跳过它：`fs.stat` 会跟随链接，
   *   一个指向 `C:\Windows` 的 junction 就能让"在工作区里搜一下"
   *   变成整盘扫描，而且结果里全是工作区外的文件。
   */
  readonly isSymbolicLink?: boolean;
}

/** 文件系统错误，带可判定的原因（供工具层转成可读消息）。 */
export class FileSystemError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'PERMISSION' | 'IS_DIRECTORY' | 'NOT_DIRECTORY' | 'EXISTS' | 'UNKNOWN',
  ) {
    super(message);
    this.name = 'FileSystemError';
  }
}

export interface FileSystemPort {
  /** 读文本。超过 maxBytes 时抛错，避免把巨型文件读进上下文。 */
  readText(path: string, maxBytes?: number): Promise<string>;

  /** 写文本。返回写入字节数。 */
  writeText(path: string, content: string): Promise<number>;

  /** 列出目录内容（不递归）。 */
  listDir(path: string): Promise<readonly DirEntry[]>;

  stat(path: string): Promise<FileStat>;

  exists(path: string): Promise<boolean>;

  /** 创建目录（递归）。 */
  mkdir(path: string): Promise<void>;

  /** 删除文件。目录删除必须显式声明 recursive —— 这是安全边界。 */
  remove(path: string, options?: { readonly recursive?: boolean }): Promise<void>;

  /** 移动/重命名。 */
  move(from: string, to: string): Promise<void>;

  /** 把相对路径解析为绝对路径（供界面显示与审计）。 */
  resolve(path: string): string;
}

/** 默认读取上限：1 MiB。超过就该用别的手段（分段读、搜索），而不是灌进上下文。 */
export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
