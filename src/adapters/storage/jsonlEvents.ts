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

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

export interface LoadResult {
  readonly events: readonly SessionEvent[];
  /** 损坏的行数（跳过） */
  readonly badLines: number;
  /** 损坏行的行号（1 起），便于人工排查 */
  readonly badLineNumbers: readonly number[];
  /** 是否存在（首次运行时为 false） */
  readonly existed: boolean;
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
    return { events: [], badLines: 0, badLineNumbers: [], existed: false };
  }

  const raw = await readFile(file, 'utf8');
  const events: SessionEvent[] = [];
  const badLineNumbers: number[] = [];

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = (lines[i] ?? '').trim();
    if (text.length === 0) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isSessionEvent(parsed)) {
        events.push(parsed as SessionEvent);
      } else {
        badLineNumbers.push(i + 1);
      }
    } catch {
      badLineNumbers.push(i + 1);
    }
  }

  // ★ 按 seq 排序并去重 —— 追加写可能因为重试产生重复行。
  //   去重保留**先出现的**那条（同一 seq 内容应当相同）。
  const bySeq = new Map<number, SessionEvent>();
  for (const e of events) {
    if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  }
  const sorted = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  return {
    events: sorted,
    badLines: badLineNumbers.length,
    badLineNumbers,
    existed: true,
  };
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
    await writeFile(tmp, text, 'utf8');
    // Windows 上 rename 到已存在的文件会失败 —— 先删目标
    const { rm } = await import('node:fs/promises');
    await rm(this.file, { force: true });
    await rename(tmp, this.file);
  }

  private report(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.lastError = e;
    this.onError?.(e);
  }
}
