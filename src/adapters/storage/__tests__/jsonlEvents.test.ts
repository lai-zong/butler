/**
 * 落盘缓冲与整体重写的测试（v9）
 *
 * 两个曾经错过的点：
 *   ① `pendingPersistence()` 把启动时灌入的历史也算进去 → 设置页显示
 *      "待落盘 45 条"，其实全在磁盘上；
 *   ② `rewrite()` 是遗忘权抹除后的必要能力，必须保证"全量、原子、缓冲清空"。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../../core/events/log.js';
import { JsonlEventStore, loadEvents } from '../jsonlEvents.js';

const T0 = 1_760_000_000_000;

function setup(): { readonly log: EventLog; readonly store: JsonlEventStore; readonly file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'butler-jsonl-'));
  const file = join(dir, 'events.jsonl');
  const store = new JsonlEventStore({ file, flushIntervalMs: 60_000 });
  const log = new EventLog('s_buf');
  log.attachPersistence(store);
  return { log, store, file };
}

function append(log: EventLog, text: string): void {
  log.append({ type: 'session.message', actor: 'user', payload: { text }, createdAt: T0 });
}

describe('落盘缓冲计数', () => {
  it('启动灌入历史不算"未落盘"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-jsonl-boot-'));
    const file = join(dir, 'events.jsonl');
    const store = new JsonlEventStore({ file, flushIntervalMs: 60_000 });
    const log = new EventLog('s_boot');

    // bootstrap 的顺序：先 appendMany 历史，再 attach 持久化
    log.appendMany([
      { type: 'session.ended', actor: 'butler', payload: {}, createdAt: T0 },
      { type: 'session.ended', actor: 'butler', payload: {}, createdAt: T0 + 1 },
    ]);
    log.attachPersistence(store);

    expect(log.pendingPersistence()).toBe(0);
  });

  it('追加后计数增长，flush 后归零', async () => {
    const { log } = setup();
    expect(log.pendingPersistence()).toBe(0);
    append(log, 'a');
    append(log, 'b');
    expect(log.pendingPersistence()).toBe(2);
    await log.flushPersistence();
    expect(log.pendingPersistence()).toBe(0);
  });
});

describe('整体重写', () => {
  it('重写后文件是给定全量事件（顺序按 seq），缓冲清空', async () => {
    const { log, store, file } = setup();
    append(log, 'a');
    append(log, 'b');

    const events = log.all().map((e) => (e.seq === 1 ? { ...e, payload: { text: 'scrubbed' } } : e));
    await store.rewrite(() => events);

    const loaded = await loadEvents(file);
    expect(loaded.events).toHaveLength(2);
    expect((loaded.events[0]?.payload as { text?: string }).text).toBe('scrubbed');
    expect(store.pending()).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('scrubbed');
  });
});
