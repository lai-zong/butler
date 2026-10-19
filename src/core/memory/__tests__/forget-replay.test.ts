/**
 * 遗忘权（v9）回归测试
 *
 * 三条主张，对应三个曾经真实存在的缺口：
 *   ① 删除必须**扛过重启** —— 重放要看 `intervention.forgotten`
 *   ② 删除必须**抹掉历史原文** —— 审计/导出里不能再搜到内容
 *   ③ 旧数据（只删了内存、没抹原文）启动时要被**幂等**补抹
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonlEventStore, loadEvents } from '../../../adapters/storage/jsonlEvents.js';
import { EventLog } from '../../events/log.js';
import { FORGOTTEN_PLACEHOLDER } from '../../events/scrub.js';
import type { SessionEvent } from '../../events/types.js';
import { FixedClock } from '../../ports/clock.js';
import { buildExport } from '../../transfer/export.js';
import { parseImportDocument } from '../../transfer/import.js';
import { MemoryStore } from '../store.js';
import { replayMemory } from '../replay.js';
import { repairForgottenContent } from '../repair.js';

const T0 = 1_760_000_000_000;
const USER = 'u_forget';
const butler = { kind: 'butler', userId: USER } as const;

function tempFile(): { readonly dir: string; readonly file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'butler-forget-'));
  return { dir, file: join(dir, 'events.jsonl') };
}

function makeStore(log: EventLog): MemoryStore {
  return new MemoryStore(log, new FixedClock(T0), USER);
}

function createMemory(store: MemoryStore, id: string, content: string): void {
  const r = store.create(butler, {
    id,
    memClass: 'domain',
    kind: 'fact',
    content,
    confidence: 0.8,
    evidence: ['测试'],
    lifecycle: 'active',
    domain: 'life',
  });
  if (!r.ok) throw new Error(`create 失败：${r.reason}`);
}

describe('遗忘：状态与历史同时消失', () => {
  it('删除后：内存没有、事件文件里也没有原文，并且墓碑带内容哈希', async () => {
    const { file } = tempFile();
    const log = new EventLog('s_forget');
    log.attachPersistence(new JsonlEventStore({ file, flushIntervalMs: 0 }));
    const store = makeStore(log);

    createMemory(store, 'mem_keep', '我每周三晚上打球');
    createMemory(store, 'mem_del', '我的手机号是 13812345678，方便时联系我');

    const r = store.forget(butler, 'mem_del');
    expect(r.ok).toBe(true);
    await log.flushPersistence();

    // ① 内存：删掉了
    expect(store.get('mem_del')).toBeUndefined();
    expect(store.all().map((e) => e.id)).toEqual(['mem_keep']);

    // ② 文件：原文不在，占位符在
    const raw = readFileSync(file, 'utf8');
    expect(raw.includes('13812345678')).toBe(false);
    expect(raw).toContain(FORGOTTEN_PLACEHOLDER);

    // ③ 墓碑：有哈希、没有原文
    const tombstone = (await loadEvents(file)).events.find((e) => e.type === 'intervention.forgotten');
    expect(tombstone).toBeDefined();
    const payload = tombstone?.payload as Record<string, unknown>;
    expect(payload['memoryId']).toBe('mem_del');
    expect(typeof payload['contentHash']).toBe('string');
    expect(JSON.stringify(payload).includes('13812345678')).toBe(false);
  });

  it('重放（等价于重启）：删除依然成立，且不再返回被删记忆的版本历史', () => {
    const { file } = tempFile();
    const log = new EventLog('s_replay');
    log.attachPersistence(new JsonlEventStore({ file, flushIntervalMs: 0 }));
    const store = makeStore(log);

    createMemory(store, 'mem_keep', '我每周三晚上打球');
    createMemory(store, 'mem_del', '我不吃香菜');
    store.forget(butler, 'mem_del');

    const replayed = replayMemory(log.all());
    expect(replayed.entries.map((e) => e.id)).toEqual(['mem_keep']);
    expect(replayed.revisions.filter((r) => r.memoryId === 'mem_del')).toEqual([]);
  });

  it('导出 → 导入：文件里没有原文，导入重放后也不复活', () => {
    const { file } = tempFile();
    const log = new EventLog('s_export');
    log.attachPersistence(new JsonlEventStore({ file, flushIntervalMs: 0 }));
    const store = makeStore(log);

    createMemory(store, 'mem_keep', '我每周三晚上打球');
    createMemory(store, 'mem_del', '我的住址是某某小区 3 号楼');
    store.forget(butler, 'mem_del');

    const doc = buildExport({
      events: log.all(),
      userId: USER,
      appVersion: 'test',
      now: T0 + 10,
    });
    const text = JSON.stringify(doc);
    expect(text.includes('某某小区 3 号楼')).toBe(false);
    expect(text).toContain(FORGOTTEN_PLACEHOLDER);

    const imported = parseImportDocument(text);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.candidate.events.some((e) => e.type === 'intervention.forgotten')).toBe(true);
    expect(replayMemory(imported.candidate.events).entries.map((e) => e.id)).toEqual(['mem_keep']);
  });

  it('旧数据迁移：只有删除事件、没有抹除时，启动补齐且幂等', async () => {
    const { file } = tempFile();

    // 造一份"旧版本"数据：created 带原文 + forgotten 只有 id
    const seedLog = new EventLog('s_legacy');
    const seedStore = makeStore(seedLog);
    createMemory(seedStore, 'mem_legacy', '我的住址是某某小区 3 号楼');
    const created = seedLog.all()[0];
    if (created === undefined) throw new Error('种子事件缺失');
    const forgotten: SessionEvent = {
      id: 'evt_forgotten',
      sessionId: 's_legacy',
      seq: 2,
      type: 'intervention.forgotten',
      actor: 'user',
      payload: { memoryId: 'mem_legacy', memClass: 'domain', hardConstraint: false },
      createdAt: T0 + 1,
    };
    writeFileSync(file, [created, forgotten].map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    // 启动：读盘 → 灌入 → 挂持久化 → 迁移
    const loaded = await loadEvents(file);
    const log = new EventLog('s_legacy');
    log.appendMany(
      loaded.events.map((e) => ({
        type: e.type,
        actor: e.actor,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
    );
    log.attachPersistence(new JsonlEventStore({ file, flushIntervalMs: 0 }));

    const repaired = repairForgottenContent(log);
    expect(repaired.memories).toBe(1);
    await log.flushPersistence();

    expect(readFileSync(file, 'utf8').includes('某某小区 3 号楼')).toBe(false);
    expect(readFileSync(file, 'utf8')).toContain(FORGOTTEN_PLACEHOLDER);

    // 幂等：再跑一次不应再改
    const again = repairForgottenContent(log);
    expect(again.memories).toBe(0);
  });
});
