/**
 * 事件文件读取 —— 丢历史的回归测试（2026-11-11）
 *
 * ★ 事故记录（真实数据，不是构造场景）：
 *   `.butler-data/events.jsonl` 4,144 行、97 个历史会话、884 个 seq 重号，
 *   加载后只剩 **2,458 条**，而且 `badLines` 仍然是 0 —— 界面完全看不出异常。
 *
 *   根因有两个，缺一不可：
 *     ① `EventLog.nextSeq() = events.length + 1` —— 隐含假设"下标 + 1 就是 seq"，
 *        有缺口时算出的编号比磁盘上已有的最大 seq 还小，新事件直接撞号；
 *     ② `loadEvents` 按 **seq** 去重，而 seq 是每次启动从 1 重新编的 ——
 *        同一个 seq 在两代数据里是两条不同事件，"去重"实际是丢历史。
 *
 *   后果：每重启一次就静默丢一截，且永远不报错。
 *   这个文件把这些行为钉住，防止再退回去。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadEvents } from '../jsonlEvents.js';
import type { SessionEvent } from '../../../core/events/types.js';

const T0 = 1_760_000_000_000;

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'butler-load-')), 'events.jsonl');
}

function makeEvent(args: {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly type?: SessionEvent['type'];
  readonly payload?: unknown;
}): SessionEvent {
  return {
    id: args.id,
    sessionId: args.sessionId,
    seq: args.seq,
    type: args.type ?? 'thought.done',
    actor: 'butler',
    payload: args.payload ?? { note: args.id },
    createdAt: T0 + args.seq,
  } as SessionEvent;
}

function write(file: string, events: readonly SessionEvent[]): void {
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

describe('loadEvents：不再按 seq 丢历史', () => {
  it('两代数据 seq 撞号时，两条都保留（旧实现会丢一条）', async () => {
    const file = tempFile();
    write(file, [
      // 第一代：seq 1..3
      makeEvent({ id: 'evt_a1', sessionId: 's_old', seq: 1 }),
      makeEvent({ id: 'evt_a2', sessionId: 's_old', seq: 2 }),
      makeEvent({ id: 'evt_a3', sessionId: 's_old', seq: 3 }),
      // 第二代：重启后序号从 1 重来，撞上第一代
      makeEvent({ id: 'evt_b1', sessionId: 's_new', seq: 1 }),
      makeEvent({ id: 'evt_b2', sessionId: 's_new', seq: 2 }),
    ]);

    const loaded = await loadEvents(file);

    expect(loaded.events.map((e) => e.id)).toEqual([
      'evt_a1',
      'evt_a2',
      'evt_a3',
      'evt_b1',
      'evt_b2',
    ]);
    expect(loaded.badLines).toBe(0);
  });

  it('归一化：seq 恒为文件位置 1..N，且顺序不变', async () => {
    const file = tempFile();
    write(file, [
      makeEvent({ id: 'evt_1', sessionId: 's', seq: 10 }),
      makeEvent({ id: 'evt_2', sessionId: 's', seq: 10 }),
      makeEvent({ id: 'evt_3', sessionId: 's', seq: 4 }),
    ]);

    const loaded = await loadEvents(file);

    expect(loaded.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(loaded.events.map((e) => e.id)).toEqual(['evt_1', 'evt_2', 'evt_3']);
    expect(loaded.issues.some((i) => i.kind === 'seqRenumbered')).toBe(true);
  });

  it('同一 id 的重复行只保留第一条（真正的重复才丢）', async () => {
    const file = tempFile();
    const e = makeEvent({ id: 'evt_same', sessionId: 's', seq: 1 });
    write(file, [e, e, makeEvent({ id: 'evt_other', sessionId: 's', seq: 2 })]);

    const loaded = await loadEvents(file);

    expect(loaded.events.map((x) => x.id)).toEqual(['evt_same', 'evt_other']);
    expect(loaded.issues.find((i) => i.kind === 'duplicateId')?.count).toBe(1);
  });

  it('坏行仍然跳过并计数，不阻断读取', async () => {
    const file = tempFile();
    writeFileSync(
      file,
      [
        JSON.stringify(makeEvent({ id: 'evt_ok', sessionId: 's', seq: 1 })),
        '{ 这不是 JSON',
        JSON.stringify(makeEvent({ id: 'evt_ok2', sessionId: 's', seq: 2 })),
      ].join('\n') + '\n',
      'utf8',
    );

    const loaded = await loadEvents(file);

    expect(loaded.events).toHaveLength(2);
    expect(loaded.badLines).toBe(1);
    expect(loaded.badLineNumbers).toEqual([2]);
  });

  it('归一化是幂等的：同一份文件读两次结果相同', async () => {
    const file = tempFile();
    write(file, [
      makeEvent({ id: 'evt_x', sessionId: 's', seq: 7 }),
      makeEvent({ id: 'evt_y', sessionId: 's', seq: 7 }),
    ]);

    const first = await loadEvents(file);
    const second = await loadEvents(file);
    expect(second.events.map((e) => e.seq)).toEqual(first.events.map((e) => e.seq));
    expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
  });
});

describe('loadEvents：真实事件文件（本机存在时才跑）', () => {
  const realFile = resolve(process.cwd(), '.butler-data', 'events.jsonl');

  it.skipIf(!exists(realFile))('4,144 行进、4,144 条出（不按 seq 丢）', async () => {
    const raw = readFileSync(realFile, 'utf8');
    const lineCount = raw.split('\n').filter((l) => l.trim().length > 0).length;
    const distinctIds = new Set(
      raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => (JSON.parse(l) as { id: string }).id),
    ).size;

    const loaded = await loadEvents(realFile);

    expect(distinctIds).toBe(lineCount);
    expect(loaded.events).toHaveLength(distinctIds);
    expect(loaded.events.map((e) => e.seq)).toEqual(
      Array.from({ length: distinctIds }, (_, i) => i + 1),
    );
    expect(loaded.badLines).toBe(0);
  });
});

function exists(file: string): boolean {
  try {
    readFileSync(file, 'utf8');
    return true;
  } catch {
    return false;
  }
}
