/**
 * 导出/导入的单测（v8 · 方案 §5.5）
 *
 * ★ 这里重点覆盖 `validate:14` **没覆盖**的路径：
 *   · 导出时**真的扫到凭证**会怎样（validate:14 只验了"没有凭证"的正常路径）
 *   · 导入时遇到**未知事件类型**会怎样
 *   · 版本号缺失 / 非 JSON 等边界
 *
 * ⚠️ 为什么"扫到凭证"必须单独测：
 *   那是方案 §5.5 里唯一一条**安全**要求（导出文件会经过网盘/U 盘）。
 *   如果这条路径坏掉（比如扫到却照常导出），后果是密钥落到用户手里 ——
 *   而正常路径永远绿，看不出来。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { buildExport } from '../export.js';
import { describeRejection, parseImportDocument } from '../import.js';
import { EXPORT_SCHEMA } from '../schema.js';

const T0 = 1_760_000_000_000;

function logWith(...appends: Parameters<EventLog['append']>[0][]): EventLog {
  const log = new EventLog('__event_log__');
  for (const a of appends) log.append(a);
  return log;
}

const SAFE_EVENT = {
  type: 'session.ended',
  actor: 'butler',
  payload: {},
  createdAt: T0,
} as const;

describe('buildExport', () => {
  it('正常导出：事件一条不少，并显式声明不含凭证', () => {
    const log = logWith(SAFE_EVENT, { ...SAFE_EVENT, createdAt: T0 + 1 });
    const r = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });

    expect(r.doc).toBeDefined();
    expect(r.doc?.events).toHaveLength(2);
    expect(r.doc?.includesCredentials).toBe(false);
    expect(r.doc?.credentialScan).toEqual({ scannedEvents: 2, suspicious: 0 });
    expect(r.doc?.counts.lastSeq).toBe(2);
  });

  it('★★ payload 里出现密钥 → 拒绝导出（不写进文件、也不悄悄替换）', () => {
    /**
     * ⚠️ 为什么不脱敏后照常导出：
     *    脱敏会让导出文件与原文不一致，导回去之后行为可能变
     *    （某个工具参数被替换成 `***`）。宁可拒绝，也不制造"看着完整、其实被改过"的数据。
     */
    const log = logWith({
      type: 'tool.result',
      actor: 'butler',
      payload: { output: 'DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrstuvwxyz' },
      createdAt: T0,
    });

    const r = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });

    expect(r.doc).toBeUndefined();
    expect(r.rejection?.kind).toBe('credentials-found');
    expect(r.rejection?.where.length).toBeGreaterThan(0);
    // 位置信息要能指到具体事件，否则用户没法排查
    expect(r.rejection?.where[0]).toContain('tool.result');
  });

  it('嵌套结构里的密钥也能扫到（不是只看顶层）', () => {
    const log = logWith({
      type: 'mcp.serverAdded',
      actor: 'user',
      payload: { config: { env: { TOKEN: 'sk-abcdefghijklmnopqrstuvwxyz' } } },
      createdAt: T0,
    });

    const r = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });
    expect(r.rejection?.kind).toBe('credentials-found');
  });

  it('空事件流也能导出（0 条是合法状态，不是错误）', () => {
    const r = buildExport({ events: [], userId: 'local', appVersion: 'v8', now: T0 });
    expect(r.doc?.events).toHaveLength(0);
    expect(r.doc?.counts).toEqual({ events: 0, lastSeq: 0 });
  });
});

describe('parseImportDocument', () => {
  /** 造一份合法的导出文本 */
  function goodText(): string {
    const log = logWith(SAFE_EVENT);
    const r = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });
    return JSON.stringify(r.doc);
  }

  it('合法文档通过，并给出**强类型**的 events', () => {
    const r = parseImportDocument(goodText());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.candidate.eventCount).toBe(1);
      expect(r.candidate.events).toHaveLength(1);
      // 收窄后的 type 是 EventType，可用于 bootstrap
      expect(r.candidate.events[0]?.type).toBe('session.ended');
    }
  });

  it('非 JSON → 明确拒绝', () => {
    const r = parseImportDocument('not json at all');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.kind).toBe('not-json');
  });

  it('版本不符 → 拒绝，并说明文件版本与所需版本', () => {
    const doc = JSON.parse(goodText()) as Record<string, unknown>;
    doc['schema'] = 'butler-export@99';
    const r = parseImportDocument(JSON.stringify(doc));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.kind).toBe('schema-mismatch');
      const msg = describeRejection(r.rejection);
      expect(msg).toContain('butler-export@99');
      expect(msg).toContain(EXPORT_SCHEMA);
    }
  });

  it('★ 未知事件类型 → 拒绝（不许静默忽略）', () => {
    /**
     * ⚠️ 静默忽略的后果：事件是唯一真相源，丢一部分 = 导入后状态与导出时不一致，
     *    而用户看到的是"导入成功"。那是数据损坏，不是兼容。
     */
    const doc = JSON.parse(goodText()) as Record<string, unknown>;
    const events = doc['events'] as Record<string, unknown>[];
    if (events[0] !== undefined) events[0]['type'] = 'future.eventFromNewerVersion';

    const r = parseImportDocument(JSON.stringify(doc));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.kind).toBe('unknown-event-type');
      expect(describeRejection(r.rejection)).toContain('future.eventFromNewerVersion');
    }
  });

  it('schema 字段缺失 → 拒绝', () => {
    const doc = JSON.parse(goodText()) as Record<string, unknown>;
    delete doc['schema'];
    const r = parseImportDocument(JSON.stringify(doc));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.kind).toBe('schema-mismatch');
  });

  it('events 不是数组 → 结构错误', () => {
    const doc = JSON.parse(goodText()) as Record<string, unknown>;
    doc['events'] = 'nope';
    const r = parseImportDocument(JSON.stringify(doc));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.kind).toBe('malformed');
  });

  it('counts 与实际条数不一致 → 拒绝（文件被改过）', () => {
    const doc = JSON.parse(goodText()) as Record<string, unknown>;
    (doc['counts'] as Record<string, unknown>)['events'] = 42;
    const r = parseImportDocument(JSON.stringify(doc));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(describeRejection(r.rejection)).toContain('42');
  });

  it('seq 重复 → 拒绝', () => {
    const log = logWith(SAFE_EVENT, { ...SAFE_EVENT, createdAt: T0 + 1 });
    const built = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });
    const doc = JSON.parse(JSON.stringify(built.doc)) as Record<string, unknown>;
    const events = doc['events'] as Record<string, unknown>[];
    // 把第 2 条的 seq 改成与第 1 条相同
    if (events[1] !== undefined) events[1]['seq'] = 1;

    const r = parseImportDocument(JSON.stringify(doc));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.kind).toBe('seq-not-contiguous');
  });
});

describe('describeRejection 的文案', () => {
  it('每种拒绝都有中文说明（不许空字符串）', () => {
    const all = [
      { kind: 'not-json', detail: 'x' },
      { kind: 'schema-mismatch', got: 'a', want: 'b' },
      { kind: 'malformed', detail: 'x' },
      { kind: 'unknown-event-type', eventType: 't', seq: 1 },
      { kind: 'seq-not-contiguous', detail: 'x' },
      { kind: 'empty' },
    ] as const;

    for (const r of all) {
      const msg = describeRejection(r);
      expect(msg.length).toBeGreaterThan(0);
      // 纯英文/占位符不算"给用户看的说明"
      expect(/[\u4e00-\u9fa5]/.test(msg), `${r.kind} 的说明里没有中文`).toBe(true);
    }
  });
});
