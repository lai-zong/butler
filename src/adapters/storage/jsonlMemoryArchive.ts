/**
 * 记忆存档区 · JSONL 落盘实现
 *
 * 一行一条 `ArchivedMemoryRecord`，与事件流同一套写入纪律：
 * 追加写、坏行跳过、整体重写时先写临时文件再 rename。
 *
 * ⚠️ 与事件流的区别：**这里允许物理删除**。
 *    "彻底删除"就是要把这条记录从存档里拿掉（重写文件），
 *    而事件流是 append-only 的真相源，只能抹字段、不能删行。
 */

import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  ArchivedMemoryRecord,
  MemoryArchivePort,
} from '../../core/memory/archive.js';

export interface JsonlMemoryArchiveOptions {
  /** 数据目录（与 `.butler-data` 同源）；实际文件落在 `<dir>/archive/memories.jsonl` */
  readonly dataDir: string;
}

export class JsonlMemoryArchive implements MemoryArchivePort {
  private readonly file: string;
  private readonly dir: string;

  constructor(opts: JsonlMemoryArchiveOptions) {
    this.dir = join(opts.dataDir, 'archive');
    this.file = join(this.dir, 'memories.jsonl');
  }

  async append(record: ArchivedMemoryRecord): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async list(): Promise<readonly ArchivedMemoryRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    // 同一个 archiveId 后写的覆盖先写的（重写失败时的重试可能留下重复行）
    const byId = new Map<string, ArchivedMemoryRecord>();
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (text.length === 0) continue;
      try {
        const parsed = JSON.parse(text) as ArchivedMemoryRecord;
        if (typeof parsed.archiveId !== 'string' || typeof parsed.memory !== 'object') continue;
        byId.set(parsed.archiveId, parsed);
      } catch {
        // 单行损坏不影响其它记录
      }
    }
    return [...byId.values()].sort((a, b) => b.archivedAt - a.archivedAt);
  }

  async get(archiveId: string): Promise<ArchivedMemoryRecord | null> {
    const all = await this.list();
    return all.find((r) => r.archiveId === archiveId) ?? null;
  }

  async remove(archiveId: string): Promise<boolean> {
    const all = await this.list();
    const kept = all.filter((r) => r.archiveId !== archiveId);
    if (kept.length === all.length) return false;

    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const body = kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length > 0 ? '\n' : '');
    // 与事件落盘同一条纪律：写临时文件 → rename 覆盖，避免中途崩溃留下半截
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, this.file);
    return true;
  }

  async stats(): Promise<{ readonly count: number; readonly bytes: number }> {
    let bytes = 0;
    try {
      bytes = (await stat(this.file)).size;
    } catch {
      bytes = 0;
    }
    const count = (await this.list()).length;
    return { count, bytes };
  }

  /** 清空存档区（用户在界面上显式确认后才调用）。返回清掉的条数。 */
  async clear(): Promise<number> {
    const count = (await this.list()).length;
    await rm(this.file, { force: true });
    return count;
  }
}
