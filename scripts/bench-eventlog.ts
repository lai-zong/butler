/**
 * 事件流基准（手工运行，不进入单测）
 *
 * ⚠️ 分两层，不能混：
 *   · 内存 EventLog 追加 —— 只说明纯数组/对象开销；
 *   · JSONL 落盘 + 重新加载 —— 才代表真实持久化成本。
 *
 * 旧脚本只测第一层，100k 几十毫秒会被误读成“事件溯源很快”；
 * 这里把两层分开报，并给出文件大小/加载时间/内存占用。
 *
 * 运行：node --import tsx scripts/bench-eventlog.ts [n]
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlEventStore, loadEvents } from '../src/adapters/storage/jsonlEvents.js';
import { EventLog } from '../src/core/events/log.js';

const n = Number(process.argv[2] ?? 100_000);
if (!Number.isFinite(n) || n <= 0) throw new Error('n 必须是正整数');

const TEXT = '这是一条用于基准测试的事件负载，包含中文、数字 1234567890 和重复结构。'.repeat(2);

function fill(log: EventLog): { appendMs: number; readMs: number; bytes: number } {
  const started = performance.now();
  for (let i = 0; i < n; i++) {
    log.append({
      type: 'session.message',
      actor: 'user',
      payload: {
        sessionId: 'bench',
        messageId: `m_${i}`,
        role: 'user',
        text: TEXT,
        status: 'done',
      },
    });
  }
  const appendMs = performance.now() - started;

  const readStart = performance.now();
  let bytes = 0;
  for (const e of log.all()) {
    bytes += typeof e.payload === 'object' && e.payload !== null ? 1 : 0;
  }
  const readMs = performance.now() - readStart;
  return { appendMs, readMs, bytes };
}

const memoryLog = new EventLog('bench-memory');
const memory = fill(memoryLog);

const dir = await mkdtemp(join(tmpdir(), 'butler-bench-'));
const file = join(dir, 'events.jsonl');
// 与生产默认一致：先缓冲，到 500ms/200 条再刷；不是每条 fsync。
const store = new JsonlEventStore({ file, flushIntervalMs: 500 });
const diskLog = new EventLog('bench-disk');
diskLog.attachPersistence(store);

const diskFillStart = performance.now();
const diskFill = fill(diskLog);
const fillMs = performance.now() - diskFillStart;
const flushStart = performance.now();
await diskLog.flushPersistence();
const flushMs = performance.now() - flushStart;

const size = (await stat(file)).size;
const loadStart = performance.now();
const loaded = await loadEvents(file);
const loadMs = performance.now() - loadStart;

console.log(
  JSON.stringify(
    {
      events: n,
      textBytes: Buffer.byteLength(TEXT, 'utf8'),
      memory: {
        appendMs: Math.round(memory.appendMs),
        appendPerSec: Math.round((n / memory.appendMs) * 1000),
        readMs: Number(memory.readMs.toFixed(2)),
        rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
      },
      jsonl: {
        appendMs: Math.round(diskFill.appendMs),
        appendPerSec: Math.round((n / diskFill.appendMs) * 1000),
        fillAndBufferMs: Math.round(fillMs),
        flushMs: Math.round(flushMs),
        loadMs: Math.round(loadMs),
        fileMb: Number((size / 1024 / 1024).toFixed(2)),
        eventsLoaded: loaded.events.length,
        badLines: loaded.badLines,
      },
    },
    null,
    2,
  ),
);

await rm(dir, { recursive: true, force: true });
