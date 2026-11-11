/**
 * 记忆存档区（两步删除）
 *
 * ★ 用户确认的规则：
 *   ① 记忆页「删除」→ 移入存档区，可恢复；
 *   ② 存档区「彻底删除」→ 抹除原文，只留指纹。
 *
 * 这里钉住四件事：落盘往返、移出后不再可见、恢复后回到活跃、重放能跟上。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonlMemoryArchive } from '../../../adapters/storage/jsonlMemoryArchive.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../store.js';
import { hydrateStore, replayMemory } from '../replay.js';
import type { ArchivedMemoryRecord } from '../archive.js';

const T0 = 1_760_000_000_000;
const USER = 'u_archive';
const butler = { kind: 'butler', userId: USER } as const;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'butler-archive-'));
}

describe('存档区落盘', () => {
  it('写入 / 读取 / 删除往返正常', async () => {
    const archive = new JsonlMemoryArchive({ dataDir: tempDir() });
    const clock = new FixedClock(T0);
    const log = new EventLog('s_a');
    const store = new MemoryStore(log, clock, USER);
    const created = store.create(butler, {
      id: 'mem_1',
      memClass: 'global_shared',
      kind: 'fact',
      content: '我周末通常十点起床',
      confidence: 0.9,
      evidence: ['e1'],
    });
    if (!created.ok) throw new Error('建档失败');

    const record: ArchivedMemoryRecord = {
      archiveId: 'arc_1',
      memory: created.entry,
      reason: '删错了',
      archivedAt: T0,
    };
    await archive.append(record);

    expect((await archive.list()).map((r) => r.archiveId)).toEqual(['arc_1']);
    expect((await archive.get('arc_1'))?.memory.content).toBe('我周末通常十点起床');

    expect(await archive.remove('arc_1')).toBe(true);
    expect(await archive.remove('arc_1')).toBe(false);
    expect(await archive.list()).toEqual([]);
  });

  it('坏行不影响其它记录', async () => {
    const dir = tempDir();
    const archive = new JsonlMemoryArchive({ dataDir: dir });
    const clock = new FixedClock(T0);
    const log = new EventLog('s_b');
    const store = new MemoryStore(log, clock, USER);
    const created = store.create(butler, {
      id: 'mem_2',
      memClass: 'global_shared',
      kind: 'fact',
      content: '我喜欢喝无糖豆浆',
      confidence: 0.9,
      evidence: [],
    });
    if (!created.ok) throw new Error('建档失败');
    await archive.append({
      archiveId: 'arc_ok',
      memory: created.entry,
      reason: 'r',
      archivedAt: T0,
    });
    // 手动塞一行坏数据
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(dir, 'archive', 'memories.jsonl'), '{坏行\n', 'utf8');

    const list = await archive.list();
    expect(list.map((r) => r.archiveId)).toEqual(['arc_ok']);
  });
});

describe('两步删除', () => {
  it('第一步：移出记忆库、事件留指纹、重放后确实不在', () => {
    const clock = new FixedClock(T0);
    const log = new EventLog('s_c');
    const store = new MemoryStore(log, clock, USER);
    store.create(butler, {
      id: 'mem_3',
      memClass: 'global_shared',
      kind: 'fact',
      content: '我的午休时间是 13 点',
      confidence: 0.9,
      evidence: [],
    });

    const res = store.takeOutForArchive({ actor: butler, id: 'mem_3', archiveId: 'arc_3' });
    expect(res.ok).toBe(true);
    expect(res.entry?.content).toBe('我的午休时间是 13 点');
    expect(store.get('mem_3')).toBeUndefined();

    const out = log.byType('intervention.archivedOut');
    expect(out).toHaveLength(1);
    expect(out[0]?.payload).toMatchObject({ memoryId: 'mem_3', archiveId: 'arc_3' });
    // 事件里不能有原文
    expect(JSON.stringify(out[0]?.payload)).not.toContain('午休时间');

    const replayed = replayMemory(log.all());
    const fresh = new MemoryStore(new EventLog('s_c2'), clock, USER);
    hydrateStore({ store: fresh, result: replayed });
    expect(fresh.get('mem_3')).toBeUndefined();
  });

  it('第二步恢复：回到记忆库且状态为活跃', () => {
    const clock = new FixedClock(T0);
    const log = new EventLog('s_d');
    const store = new MemoryStore(log, clock, USER);
    store.create(butler, {
      id: 'mem_4',
      memClass: 'global_shared',
      kind: 'fact',
      content: '我不吃香菜',
      confidence: 0.9,
      evidence: [],
    });
    const taken = store.takeOutForArchive({ actor: butler, id: 'mem_4', archiveId: 'arc_4' });
    if (taken.entry === undefined) throw new Error('取回失败');

    expect(store.restoreFromArchive({ kind: 'user', userId: USER }, taken.entry)).toBe(true);
    expect(store.get('mem_4')?.lifecycle).toBe('active');
    expect(log.byType('memory.restored')).toHaveLength(1);

    // 重复恢复会被拒绝
    expect(store.restoreFromArchive({ kind: 'user', userId: USER }, taken.entry)).toBe(false);
  });

  it('硬约束不允许走存档（必须显式确认后直删）', () => {
    const clock = new FixedClock(T0);
    const log = new EventLog('s_e');
    const store = new MemoryStore(log, clock, USER);
    store.create(butler, {
      id: 'mem_5',
      memClass: 'global_constraint',
      kind: 'fact',
      content: '我对花生严重过敏',
      confidence: 1,
      evidence: [],
    });

    const res = store.takeOutForArchive({ actor: butler, id: 'mem_5', archiveId: 'arc_5' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('hard_constraint_requires_confirmation');
    expect(store.get('mem_5')).toBeDefined();
  });
});
