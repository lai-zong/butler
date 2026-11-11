/**
 * 工作区文件回收站
 *
 * ★ 为什么需要它：模型替用户删文件时没有"撤销"。实测过的典型场景是
 *   「把临时文件清一下」，模型把路径算错，把资料目录整个删掉 ——
 *   找不回来。现在 `NodeFileSystem.remove()` 在配置了回收站时改为"移入"，
 *   这里负责列出 / 恢复 / 彻底清除。
 *
 * ⚠️ 与记忆存档区、文档存档区**互相独立**：文件是磁盘上的真实对象，
 *   迁移（导出）不会带上它，也不该带。
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface TrashItem {
  readonly id: string;
  /** 删除前的绝对路径 */
  readonly originalPath: string;
  /** 删除时的工作区根（恢复时校验用） */
  readonly root: string;
  readonly deletedAt: number;
  readonly isDirectory: boolean;
}

interface Sidecar extends TrashItem {}

export class TrashStore {
  constructor(private readonly dir: string) {}

  private sidecarOf(id: string): string {
    if (!/^trash_[A-Za-z0-9_]+$/.test(id)) throw new Error('非法回收站 id');
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<readonly TrashItem[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: TrashItem[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.dir, name), 'utf8');
        const parsed = JSON.parse(raw) as Sidecar;
        if (typeof parsed.id !== 'string' || typeof parsed.originalPath !== 'string') continue;
        out.push(parsed);
      } catch {
        // 单条损坏不影响其它
      }
    }
    out.sort((a, b) => b.deletedAt - a.deletedAt);
    return out;
  }

  /**
   * 恢复：把文件/目录移回原路径。
   *
   * 三道校验：原路径必须在**删除时的工作区**内；目标当前不存在；
   * 回收站里的实体还在。任何一条不满足都拒绝并说明原因。
   */
  async restore(id: string): Promise<{ ok: boolean; reason?: string; path?: string }> {
    let item: TrashItem;
    try {
      item = JSON.parse(await readFile(this.sidecarOf(id), 'utf8')) as Sidecar;
    } catch {
      return { ok: false, reason: 'not_found' };
    }

    const root = item.root.endsWith('/') || item.root.endsWith('\\')
      ? item.root.slice(0, -1)
      : item.root;
    if (!item.originalPath.startsWith(`${root}\\`) && !item.originalPath.startsWith(`${root}/`)) {
      return { ok: false, reason: 'outside_root' };
    }

    try {
      await stat(item.originalPath);
      return { ok: false, reason: 'target_exists' };
    } catch {
      // 目标不存在 → 可以恢复
    }

    const entity = join(this.dir, id);
    try {
      await stat(entity);
    } catch {
      return { ok: false, reason: 'payload_missing' };
    }

    const { rename } = await import('node:fs/promises');
    try {
      await rename(entity, item.originalPath);
    } catch {
      // 跨盘/权限问题：复制后删除
      const { cp } = await import('node:fs/promises');
      await cp(entity, item.originalPath, { recursive: true, force: true });
      await rm(entity, { recursive: true, force: true });
    }
    await rm(this.sidecarOf(id), { force: true });
    return { ok: true, path: item.originalPath };
  }

  async purge(id: string): Promise<boolean> {
    let exists = true;
    try {
      await stat(this.sidecarOf(id));
    } catch {
      exists = false;
    }
    if (!exists) return false;
    await rm(join(this.dir, id), { recursive: true, force: true });
    await rm(this.sidecarOf(id), { force: true });
    return true;
  }

  async purgeAll(): Promise<number> {
    const items = await this.list();
    for (const item of items) {
      await rm(join(this.dir, item.id), { recursive: true, force: true });
      await rm(this.sidecarOf(item.id), { force: true });
    }
    return items.length;
  }

  /** 占用（条数 + 字节数）；目录会递归统计，但有条目上限避免卡住界面。 */
  async stats(): Promise<{ readonly count: number; readonly bytes: number }> {
    const items = await this.list();
    let bytes = 0;
    let visited = 0;
    const walk = async (p: string): Promise<void> => {
      if (visited > 20_000) return;
      try {
        const st = await stat(p);
        visited += 1;
        if (st.isFile()) {
          bytes += st.size;
          return;
        }
        for (const child of await readdir(p)) await walk(join(p, child));
      } catch {
        // 读不到就跳过
      }
    };
    for (const item of items) await walk(join(this.dir, item.id));
    return { count: items.length, bytes };
  }
}
