/**
 * 事件流落盘 —— JSONL 追加写
 *
 * 设计依据：方案 § 4.1（事件是唯一真相源）
 *
 * ★ 为什么用 JSONL（一行一条）而不是单个 JSON 数组：
 *   · **追加写不必重写整个文件** —— 长驻进程每秒都可能写事件，
 *     覆盖写会让每次写入的代价正比于历史长度
 *   · **单行损坏不影响其它行** —— 跳过并计数，不让整个历史读不出来
 *   · 与「事件流是追加的」这一本质一致
 *
 * ★ 写入策略：**缓冲 + 定时刷盘**
 *   · `onAppend` 同步入缓冲，立刻返回（不阻塞编排）
 *   · 每 `FLUSH_INTERVAL_MS` 或缓冲超过 `MAX_BUFFER` 时刷一次
 *   · 进程退出前 `flush()` 刷干净
 *
 *   ⚠️ 为什么不用"每条都 fsync"：那会让每次事件产生都等磁盘，
 *      而事件产生在编排的热路径上。丢失最后几百毫秒的事件是可接受的
 *      （有截断保护，且用户看到的界面状态来自内存）；
 *      拖慢整个系统不可接受。
 */

import { appendFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { EventPersistencePort } from '../../core/events/log.js';
import type { SessionEvent } from '../../core/events/types.js';

/** 缓冲多久刷一次盘。 */
export const FLUSH_INTERVAL_MS = 500;
/** 缓冲到多少条就立刻刷（避免长时间不刷积太多）。 */
export const MAX_BUFFER = 200;

export interface JsonlEventStoreOptions {
  /** 事件文件路径 */
  readonly file: string;
  /**
   * 刷盘间隔（毫秒）。
   *
   * ⚠️ 测试里传 0 表示**每次追加都立即写** ——
   *    否则测试要等定时器，既慢又不确定。
   */
  readonly flushIntervalMs?: number;
  /** 刷盘失败时的回调（供界面提示"保存失败"） */
  readonly onError?: (err: Error) => void;
}

/** 读盘时发现的数据问题（不阻断启动，但**必须**能被看见）。 */
export interface LoadIssue {
  readonly kind: 'duplicateId' | 'seqRenumbered';
  /** 受影响的事件条数 */
  readonly count: number;
  readonly detail: string;
}

export interface LoadResult {
  readonly events: readonly SessionEvent[];
  /** 损坏的行数（跳过） */
  readonly badLines: number;
  /** 损坏行的行号（1 起），便于人工排查 */
  readonly badLineNumbers: readonly number[];
  /** 是否存在（首次运行时为 false） */
  readonly existed: boolean;
  /**
   * 读盘时修正过的问题。
   *
   * ⚠️ 加这个字段的直接原因：旧实现遇到 seq 重号**静默取第一条**，
   *    4,144 行历史被丢到只剩 2,458 条，而 `badLines` 仍然是 0 ——
   *    界面看不出任何异常。**静默的丢数据比报错严重得多。**
   */
  readonly issues: readonly LoadIssue[];
}

/**
 * 读取事件文件。
 *
 * ⚠️ 坏行**跳过并记录行号**而不是抛错：
 *    一个长驻系统的事件文件可能是几个月积累的，
 *    因为一行损坏就完全启动不了，比"少几条历史"糟糕得多。
 */
export async function loadEvents(file: string): Promise<LoadResult> {
  if (!existsSync(file)) {
    return { events: [], badLines: 0, badLineNumbers: [], existed: false, issues: [] };
  }

  const raw = await readFile(file, 'utf8');
  const parsed: SessionEvent[] = [];
  const badLineNumbers: number[] = [];

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = (lines[i] ?? '').trim();
    if (text.length === 0) continue;
    try {
      const value = JSON.parse(text) as unknown;
      if (isSessionEvent(value)) {
        parsed.push(value as SessionEvent);
      } else {
        badLineNumbers.push(i + 1);
      }
    } catch {
      badLineNumbers.push(i + 1);
    }
  }

  /**
   * ★ 去重键是 **id**，不是 seq。
   *
   *   旧实现按 seq 去重（`if (!bySeq.has(e.seq))`）。问题在于 seq 是
   *   **每次启动从 1 重新编号**的，于是两代数据里同一个 seq 承载的是
   *   **两条不同的事件** —— "去重"实际是在丢历史。
   *
   *   实测（本机真实数据）：4,144 行 / 884 个 seq 重号 / 97 个会话，
   *   加载后只剩 2,458 条，约 40% 的历史再也读不回来。
   *
   *   事件 id 是全局唯一的（实测 4,144 行 id 全不同），所以按 id 去重
   *   才是"去掉真正的重复行"，而不是"去掉编号撞车的历史"。
   */
  const seenIds = new Set<string>();
  const unique: SessionEvent[] = [];
  let duplicateIds = 0;
  for (const e of parsed) {
    if (seenIds.has(e.id)) {
      duplicateIds += 1;
      continue;
    }
    seenIds.add(e.id);
    unique.push(e);
  }

  /**
   * ★ 归一化：seq 恒等于它在文件里的位置（1 起）。
   *
   *   为什么必须重新编号，而不是原样保留：
   *     · `EventLog.truncateTo` 用 `slice(target.seq)` 按下标截断，
   *       它要求 seq 与数组下标严格一致；
   *     · 历史文件里 seq 既有重号也有缺口（实测 884 个重号、64 个缺口），
   *       原样保留会让回退切在错误的位置。
   *
   *   为什么重新编号不会改变因果顺序：
   *     文件是 append-only，**文件顺序就是事件产生的顺序**。
   *     按位置编号保留了这个顺序，只是把编号换成无空洞的连续值。
   *
   *   为什么这样做能止住丢数据：
   *     下次启动读回同一份文件时，重新编号的结果完全相同（幂等），
   *     新事件又总是从 `max(seq)+1` 往后接，不再与旧行撞号。
   */
  let renumbered = 0;
  const normalized = unique.map((e, i) => {
    const seq = i + 1;
    if (e.seq !== seq) {
      renumbered += 1;
      return { ...e, seq } as SessionEvent;
    }
    return e;
  });

  const issues: LoadIssue[] = [];
  if (duplicateIds > 0) {
    issues.push({
      kind: 'duplicateId',
      count: duplicateIds,
      detail: `${duplicateIds} 行事件的 id 重复（同一事件被写了两次），已各保留第一条`,
    });
  }
  if (renumbered > 0) {
    issues.push({
      kind: 'seqRenumbered',
      count: renumbered,
      detail:
        `${renumbered} 条事件的 seq 与文件位置不一致（历史上有重号/缺口），` +
        '已按文件顺序重新编号为 1 起连续值；事件顺序与内容不变',
    });
  }

  return {
    events: normalized,
    badLines: badLineNumbers.length,
    badLineNumbers,
    existed: true,
    issues,
  };
}

/**
 * 把临时文件的内容真正刷到磁盘。
 *
 * ★ 为什么 rename 之前必须 fsync：
 *   rename 只保证"文件名指向哪个 inode"，不保证 inode 的内容已经落盘。
 *   断电后可能出现"新文件名 + 空内容/半截内容"—— 比没替换更糟。
 *   先 fsync 临时文件，再 rename，才满足"要么旧文件完好、要么新文件完整"。
 *
 * ⚠️ 只在整体重写（抹除/回退）路径上调用：那是低频且破坏性的操作，
 *    值得付这个代价。热路径的追加写仍是缓冲 + 批量刷盘，不做逐条 fsync。
 */
function fsyncFileSync(file: string): void {
  const fd = openSync(file, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 基本形状校验（不深究 payload）。 */
function isSessionEvent(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['sessionId'] === 'string' &&
    typeof o['seq'] === 'number' &&
    typeof o['type'] === 'string' &&
    typeof o['actor'] === 'string' &&
    typeof o['createdAt'] === 'number'
  );
}

/**
 * JSONL 事件持久化。
 *
 * 用法：
 *   const store = new JsonlEventStore({ file });
 *   log.attachPersistence(store);
 *   // …产生事件…
 *   await log.flushPersistence();   // 退出前
 */
export class JsonlEventStore implements EventPersistencePort {
  private buffer: SessionEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private lastError: Error | null = null;
  /** 已确认落盘的最大 seq。 */
  private durableSeq = 0;

  private readonly file: string;
  private readonly flushIntervalMs: number;
  private readonly onError: ((err: Error) => void) | undefined;

  constructor(opts: JsonlEventStoreOptions) {
    this.file = opts.file;
    this.flushIntervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.onError = opts.onError;
  }

  onAppend(events: readonly SessionEvent[]): void {
    this.buffer.push(...events);

    // flushIntervalMs = 0 → 立即写（测试用）
    if (this.flushIntervalMs === 0 || this.buffer.length >= MAX_BUFFER) {
      void this.flush();
      return;
    }
    this.schedule();
  }

  /**
   * 事件流被截断：重写文件到 `keepSeq` 为止。
   *
   * ⚠️ 必须先刷掉缓冲 —— 否则缓冲里可能有**已被截断**的事件，
   *    刷下去会把回退掉的历史又写回磁盘。
   */
  onTruncate(keepSeq: number): void {
    // 丢弃缓冲里超过 keepSeq 的
    this.buffer = this.buffer.filter((e) => e.seq <= keepSeq);

    this.flushing = this.flushing
      .then(async () => {
        await this.rewriteTo(keepSeq);
        this.durableSeq = keepSeq;
      })
      .catch((err: unknown) => this.report(err));
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) {
      await this.flushing;
      return;
    }

    const batch = this.buffer;
    this.buffer = [];

    this.flushing = this.flushing
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const text = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await appendFile(this.file, text, 'utf8');
        const maxSeq = batch.reduce((m, e) => Math.max(m, e.seq), this.durableSeq);
        this.durableSeq = maxSeq;
      })
      .catch((err: unknown) => {
        // ⚠️ 写失败时把批次放回缓冲（下次重试），而不是丢掉
        this.buffer.unshift(...batch);
        this.report(err);
      });

    await this.flushing;
  }

  /** 已确认落盘到哪个 seq。 */
  durableUpTo(): number {
    return this.durableSeq;
  }

  /** 缓冲里还有几条（界面"未落盘"用）。 */
  pending(): number {
    return this.buffer.length;
  }

  /**
   * 整体重写（遗忘权抹除内容后调用）。
   *
   * ★ 顺序：先 `flush()` 把缓冲写掉，再**同步**取全量并原子替换。
   *   `flush()` 之后到 `writeAllSync()` 之间没有 await ——
   *   事件循环不会插进新的 append，因此不会丢事件。
   */
  async rewrite(getEvents: () => readonly SessionEvent[]): Promise<void> {
    await this.flush();
    const ordered = [...getEvents()].sort((a, b) => a.seq - b.seq);
    this.writeAllSync(ordered);
    this.buffer = [];
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private writeAllSync(events: readonly SessionEvent[]): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true });

    const tmp = `${this.file}.tmp`;
    const text = events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');

    /**
     * ★ 原子替换：写临时文件 → fsync → rename 覆盖。
     *
     *   两处旧实现都是错的：
     *
     *   ① 先 `rmSync(this.file)` 再 `renameSync` —— 目标文件被删掉的那一刻，
     *      真相源就不存在了。中间断电/进程被杀，重启后整个事件流消失。
     *      Windows 的 rename 本来就能覆盖已存在文件（MoveFileEx +
     *      MOVEFILE_REPLACE_EXISTING），那个 rm 纯属自找风险。
     *
     *   ② 抹除前 `copyFileSync(this.file, .bak)` —— 备份里是**抹除前**的
     *      完整历史，等于把用户要求删掉的内容又留了一份，而且全代码库
     *      没有任何地方清理它。实测：主文件已经变成 `[已遗忘]`，
     *      `.bak` 里原文仍然完好。删除承诺因此不成立。
     */
    writeFileSync(tmp, text, 'utf8');
    fsyncFileSync(tmp);
    renameSync(tmp, this.file);
    this.durableSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
  }

  lastFlushError(): Error | null {
    return this.lastError;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
    // 不阻止进程退出（退出前应显式 flush）
    this.timer.unref?.();
  }

  /**
   * 原子重写到 `keepSeq`。
   *
   * ★ 用「写临时文件 → rename」而不是直接覆盖：
   *   直接覆盖时若中途崩溃，文件会只剩半截 —— 那是**数据丢失**。
   *   rename 在同一文件系统上是原子的：要么旧文件完好，要么新文件完整。
   */
  private async rewriteTo(keepSeq: number): Promise<void> {
    const loaded = await loadEvents(this.file);
    const kept = loaded.events.filter((e) => e.seq <= keepSeq);

    const tmp = `${this.file}.tmp`;
    const text = kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length > 0 ? '\n' : '');
    await mkdir(dirname(this.file), { recursive: true });
    // ★ 与 writeAllSync 同一套纪律：写 tmp → fsync → rename 覆盖。
    //   旧实现先 `rm(this.file)` 再 rename，同样制造了"目标已消失"的窗口。
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.file);
  }

  private report(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.lastError = e;
    this.onError?.(e);
  }
}
