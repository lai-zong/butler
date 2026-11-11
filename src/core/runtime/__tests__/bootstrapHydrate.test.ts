/**
 * 启动灌入历史 —— 不再丢事件（2026-11-11）
 *
 * ★ 这里钉住的是**端到端**行为，不是某个函数的实现细节：
 *   读盘 → bootstrap 灌历史 → 继续产生事件 → 重启读回。
 *
 *   旧实现在这条链上会丢：bootstrap 丢掉 id/seq 把历史重新编号成 1..N，
 *   磁盘上仍留着上一代的高编号行；新事件撞上旧行，下次加载被当成重复丢掉。
 *   实测：追加 100 条，重启后只剩 36 条。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonlEventStore, loadEvents } from '../../../adapters/storage/jsonlEvents.js';
import { SystemClock } from '../../../adapters/clock/system.js';
import { SeededRandom } from '../../ports/clock.js';
import { EventLog, type AppendInput } from '../../events/log.js';
import { EventInvariantError, type SessionEvent } from '../../events/types.js';
import { bootstrap } from '../bootstrap.js';

const T0 = 1_760_000_000_000;

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'butler-boot-')), 'events.jsonl');
}

/** 造一份"上一代"数据：seq 从 1 起，带自己的 id。 */
function seed(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt_seed_${i + 1}`,
    sessionId: `s_old`,
    seq: i + 1,
    type: 'thought.done' as const,
    actor: 'butler' as const,
    payload: { seed: i + 1 },
    createdAt: T0 + i,
  }));
}

function probe(i: number): AppendInput {
  return {
    type: 'thought.done',
    actor: 'butler',
    payload: { probe: i },
    createdAt: T0 + 10_000 + i,
  };
}

async function boot(file: string) {
  const loaded = await loadEvents(file);
  const store = new JsonlEventStore({ file, flushIntervalMs: 0 });
  return bootstrap({
    sessionId: `s_boot_${Date.now().toString(36)}`,
    userId: 'u1',
    clock: new SystemClock(),
    random: new SeededRandom(1),
    historicalEvents: loaded.events,
    persistence: store,
  });
}

describe('重启不再丢事件', () => {
  it('追加 100 条 → 重启读回 100 条（旧实现只剩 36 条）', async () => {
    const file = tempFile();
    writeFileSync(file, seed(3).map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const rt = await boot(file);
    for (let i = 0; i < 100; i++) rt.log.append(probe(i));
    await rt.log.flushPersistence();

    const reloaded = await loadEvents(file);

    expect(reloaded.events).toHaveLength(103);
    expect(reloaded.events.filter((e) => (e.payload as { probe?: number }).probe !== undefined))
      .toHaveLength(100);
    expect(reloaded.events.map((e) => e.seq)).toEqual(
      Array.from({ length: 103 }, (_, i) => i + 1),
    );
  });

  it('连续重启两次，事件数只增不减', async () => {
    const file = tempFile();
    writeFileSync(file, seed(2).map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const first = await boot(file);
    for (let i = 0; i < 10; i++) first.log.append(probe(i));
    await first.log.flushPersistence();
    const afterFirst = (await loadEvents(file)).events.length;

    const second = await boot(file);
    for (let i = 10; i < 20; i++) second.log.append(probe(i));
    await second.log.flushPersistence();
    const afterSecond = (await loadEvents(file)).events.length;

    expect(afterFirst).toBe(12);
    expect(afterSecond).toBe(22);
  });

  it('bootstrap 保留历史事件的 id（不再重新生成）', async () => {
    const file = tempFile();
    writeFileSync(file, seed(3).map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const rt = await boot(file);

    expect(rt.log.all().map((e) => e.id)).toEqual(['evt_seed_1', 'evt_seed_2', 'evt_seed_3']);
    expect(rt.log.nextSeq()).toBe(4);
  });
});

describe('EventLog.hydrate', () => {
  it('拒绝不连续的 seq（会让 truncateTo 切错位置）', () => {
    const log = new EventLog('s');
    const broken = [
      { ...seed(1)[0]! },
      { ...seed(2)[1]!, seq: 5 },
    ];
    expect(() => log.hydrate(broken)).toThrow(EventInvariantError);
  });

  it('拒绝注入到非空日志', () => {
    const log = new EventLog('s');
    log.hydrate(seed(1));
    expect(() => log.hydrate(seed(2))).toThrow(EventInvariantError);
  });

  it('注入后 nextSeq 接在历史之后', () => {
    const log = new EventLog('s');
    log.hydrate(seed(5));
    expect(log.nextSeq()).toBe(6);
  });
});

describe('truncateTo 之后 seq 不跳号', () => {
  it('截断到 2 再追加，新事件 seq = 3', () => {
    const log = new EventLog('s');
    log.append(probe(1));
    log.append(probe(2));
    log.append(probe(3));

    log.truncateTo({ sessionId: 's', seq: 2, reason: '测试回退' });
    const next = log.append(probe(4));

    expect(next.seq).toBe(3);
    expect(log.all().map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
