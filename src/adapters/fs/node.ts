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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
   *
   * ⚠️⚠️ 但**受保护路径是另一回事**，见 `protectedPaths`。
   */
  readonly root: string;
  /**
   * ★★ 受保护路径 —— 模型**不得**读写的前缀。
   *
   * ★ 为什么必须有它（实测暴露的问题，不是预防性设计）：
   *
   *   `WORKSPACE_ROOT` 默认是项目根目录，而系统自己的数据目录
   *   `.butler-data/` 就在它里面。于是模型可以读 `events.jsonl` ——
   *   而那是**整个系统的真相源**，里面有全部记忆内容（含敏感域）、
   *   全部对话、全部内部状态。
   *
   *   实测后果（一次真实对话）：
   *     · 模型调 `read_file {"path":".butler-data/events.jsonl"}`
   *     · 然后说出「系统本次未召回任何用户健康记忆
   *       （memory.recalled count = 0）」—— **它通过读事件文件
   *       推断出了内部状态**
   *
   *   ⚠️ 这同时击穿了三条设计：
   *     ① **记忆分权** —— 敏感域隔离与逐次授权全部失效
   *        （它直接读原始事件，绕过了 `canRead`）
   *     ② **审计** —— 读文件不产生 `memory.recalled`，
   *        但内容一样拿到了
   *     ③ **提示隔离** —— 它能看到系统写给自己的内部诊断
   *
   *   ★ 所以这里做的是**结构性防护**：按解析后的绝对路径前缀拒绝，
   *     而不是靠"模型应该不会去读"。安全不能靠自觉。
   */
  readonly protectedPaths?: readonly string[];
  /**
   * 回收站目录（可选）。
   *
   * 给定时 `remove()` **不再物理删除**，而是把目标移进这里并写一份
   * `<id>.json` 元数据（原路径、删除时间）。不给则保持原来的真删行为
   * （验证脚本/测试用）。
   *
   * ★ 为什么不直接 rm：模型替用户删文件时没有回收站，误删就找不回。
   *   实测场景：用户说"清理一下临时文件"，模型把路径算错，把资料目录删了。
   */
  readonly trashDir?: string;
}

export class NodeFileSystem implements FileSystemPort {
  private readonly root: string;
  private readonly protectedAbs: readonly string[];
  private readonly trashDir: string | undefined;

  constructor(opts: NodeFsOptions) {
    this.root = resolve(opts.root);
    this.trashDir = opts.trashDir === undefined ? undefined : resolve(opts.trashDir);
    this.protectedAbs = (opts.protectedPaths ?? []).map((p) =>
      isAbsolute(p) ? resolve(p) : resolve(this.root, p),
    );
  }

  resolve(path: string): string {
    return isAbsolute(path) ? resolve(path) : resolve(this.root, path);
  }

  /**
   * 该路径是否受保护。
   *
   * ⚠️ 判据是**解析后的绝对路径前缀**，不是字符串匹配 ——
   *    否则 `./x/../.butler-data/events.jsonl` 这类写法就能绕过。
   *
   * ★ 同时比较 realpath：工作区里的符号链接如果指向 `.butler-data`，
   *   只做字面 resolve 是挡不住的。
   */
  private async checkProtected(path: string): Promise<void> {
    const abs = this.resolve(path);
    const candidates = new Set<string>([abs]);
    try {
      candidates.add(await fs.realpath(abs));
    } catch {
      /**
       * 目标还不存在（例如新建文件）：解析**父目录**的 realpath。
       * 否则「工作区里的符号链接目录 → .butler-data」可以绕过写保护。
       */
      try {
        const realParent = await fs.realpath(dirname(abs));
        candidates.add(resolve(realParent, basename(abs)));
      } catch {
        // 父目录也不存在：只比较字面值
      }
    }
    const normalize = (p: string): string =>
      process.platform === 'win32' ? p.toLowerCase() : p;
    for (const protectedPath of this.protectedAbs) {
      const forms = new Set<string>([normalize(protectedPath)]);
      try {
        forms.add(normalize(await fs.realpath(protectedPath)));
      } catch {
        // 受保护路径不存在时保留字面值
      }
      for (const form of forms) {
        for (const candidate of candidates) {
          const normalizedCandidate = normalize(candidate);
          if (
            normalizedCandidate === form ||
            normalizedCandidate.startsWith(form + sep)
          ) {
            throw new FileSystemError(
              `路径受保护，拒绝访问：${path}（这是系统内部数据，不属于工作区）`,
              'PERMISSION',
            );
          }
        }
      }
    }
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
    await this.checkProtected(path);
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
    await this.checkProtected(path);
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
    await this.checkProtected(path);
    const abs = this.resolve(path);
    try {
      // 上级目录不存在时自动创建 —— 这是用户期待的默认行为
      await fs.mkdir(dirname(abs), { recursive: true });
      /**
       * ★ 先写临时文件再 rename（同目录、同盘）。
       *
       *   直接 `writeFile` 覆盖已有文件时，写到一半崩溃/磁盘满会把目标文件
       *   截成半截 —— 旧内容也没了。rename 是原子的：要么旧文件完好，
       *   要么新文件完整。与事件落盘（jsonlEvents）用同一套纪律。
       */
      const tmp = `${abs}.writing-${process.pid}-${Date.now().toString(36)}`;
      try {
        await fs.writeFile(tmp, content, 'utf8');
        await fs.rename(tmp, abs);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      return Buffer.byteLength(content, 'utf8');
    } catch (err) {
      throw this.translate(err, path);
    }
  }

  async listDir(path: string): Promise<readonly DirEntry[]> {
    await this.checkProtected(path);
    const abs = this.resolve(path);
    try {
      const names = await fs.readdir(abs);
      const out: DirEntry[] = [];
      for (const name of names) {
        const child = resolve(abs, name);
        try {
          /**
           * ⚠️ 必须用 lstat：`stat` 会跟随符号链接/junction，
           *    于是"工作区里的一个链接"会被当成普通目录继续往下扫。
           *    lstat 看到的是链接本身，再用 isSymbolicLink 标出来。
           */
          const st = await fs.lstat(child);
          const isLink = st.isSymbolicLink();
          out.push({
            name,
            path: child,
            isDirectory: isLink ? false : st.isDirectory(),
            size: st.isDirectory() ? 0 : st.size,
            ...(isLink ? { isSymbolicLink: true } : {}),
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
    await this.checkProtected(path);
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
    await this.checkProtected(path);
    const abs = this.resolve(path);
    /**
     * ★ 工作区根目录本身不可删除。
     *
     *   路径守卫把 `resolve(root, ".") === root` 视为"在工作区内"（这是对的，
     *   否则连相对路径都没法用），于是 `remove_path {"path":".","recursive":true}`
     *   会一路走到这里，把整个工作区目录删掉 —— 之后所有任务都报"工作区不存在"。
     *   内存实现（`memory.ts`）本来就有这道保护，文件实现漏了。
     *
     *   注意：这里比的是**解析后的绝对路径**，`"./sub/.."` 这类写法也拦得住。
     */
    if (abs === resolve(this.root)) {
      throw new FileSystemError('不能删除工作区根目录本身。', 'PERMISSION');
    }

    /**
     * ★ 配了回收站就不再物理删除。
     *
     *   模型替用户删文件时没有"撤销"，误删只能靠备份。
     *   移进回收站 + 写一份原路径元数据，界面可以列出来让用户恢复。
     */
    if (this.trashDir !== undefined) {
      let exists = true;
      try {
        await fs.lstat(abs);
      } catch {
        exists = false;
      }
      if (!exists) return;
      await this.moveToTrash(abs);
      return;
    }

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
    // ★ 移动是双向的：既不能从受保护路径搬走，也不能把东西搬进受保护路径。
    await this.checkProtected(from);
    await this.checkProtected(to);
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

  /**
   * 把目标移进回收站，并写下原路径元数据。
   *
   * ⚠️ 跨盘（EXDEV）时 rename 会失败，回退成"复制 + 删除"。
   */
  private async moveToTrash(abs: string): Promise<void> {
    const trash = this.trashDir;
    if (trash === undefined) return;
    await fs.mkdir(trash, { recursive: true });

    let isDirectory = false;
    try {
      isDirectory = (await fs.lstat(abs)).isDirectory();
    } catch {
      return;
    }

    const id = `trash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const dest = join(trash, id);
    try {
      await fs.rename(abs, dest);
    } catch {
      await fs.cp(abs, dest, { recursive: true, force: true });
      await fs.rm(abs, { recursive: true, force: true });
    }

    /**
     * 元数据一定要写成功后，原文件才真正"可见地被删"。
     * 反过来的话，回收站里会有一条没有原路径的孤儿文件，恢复不了。
     */
    await fs.writeFile(
      join(trash, `${id}.json`),
      `${JSON.stringify({
        id,
        originalPath: abs,
        root: this.root,
        deletedAt: Date.now(),
        isDirectory,
      })}\n`,
      'utf8',
    );
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
