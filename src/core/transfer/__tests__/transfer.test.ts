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
    const doc = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });

    expect(doc.events).toHaveLength(2);
    expect(doc.includesCredentials).toBe(false);
    expect(doc.sanitization).toMatchObject({ policy: 'auto', redacted: 0, pii: 0 });
    expect(doc.containsPII).toBe(false);
    expect(doc.counts.lastSeq).toBe(2);
  });

  it('★★ payload 里出现密钥 → **自动脱敏并写清单**（不再拒绝导出）', () => {
    /**
     * v1 的行为是"扫到就拒绝"，但事件流 append-only、用户无法清理历史：
     * 一旦说过一次手机号/密钥，导出就永久 400（实测）。
     * v2 改为自动替换 + 清单，用户始终能拿到一份可导入的备份。
     */
    const log = logWith({
      type: 'tool.result',
      actor: 'butler',
      payload: { output: 'DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrstuvwxyz' },
      createdAt: T0,
    });

    const doc = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });

    const text = JSON.stringify(doc);
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(text).toContain('[已脱敏');
    expect(doc.sanitization.redacted).toBeGreaterThan(0);
    // 位置信息要能指到具体事件，否则用户没法核对
    expect(doc.sanitization.fields[0]?.path).toContain('tool.result');
    expect(doc.includesCredentials).toBe(false);
  });

  it('嵌套结构里的密钥也能脱敏（不是只看顶层）', () => {
    const log = logWith({
      type: 'mcp.serverAdded',
      actor: 'user',
      payload: { config: { env: { TOKEN: 'sk-abcdefghijklmnopqrstuvwxyz' } } },
      createdAt: T0,
    });

    const doc = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });
    expect(JSON.stringify(doc)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(doc.sanitization.redacted).toBeGreaterThan(0);
  });

  it('★ 手机号属于个人信息：保留但标记，不再导致导出失败', () => {
    const log = logWith({
      type: 'memory.created',
      actor: 'butler',
      payload: { entry: { id: 'm1', content: '我的手机号是 13812345678' } },
      createdAt: T0,
    });

    const doc = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });
    expect(JSON.stringify(doc)).toContain('13812345678');
    expect(doc.containsPII).toBe(true);
    expect(doc.sanitization.pii).toBeGreaterThan(0);
    expect(doc.sanitization.redacted).toBe(0);
  });

  it('练习答案不进入导出文件（但题目保留）', () => {
    const log = logWith({
      type: 'quiz.created',
      actor: 'butler',
      payload: {
        taskId: 'chat_1',
        artifactIndex: 0,
        questions: [{ id: 'q1', stem: '哪种用油最少？', options: ['油炸', '清蒸'] }],
        answers: [{ id: 'q1', correct: 'B' }],
      },
      createdAt: T0,
    });

    const doc = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });
    const text = JSON.stringify(doc);
    expect(text).not.toContain('"answers"');
    expect(text).not.toContain('"correct"');
    expect(text).toContain('哪种用油最少');
    expect(doc.sanitization.fields.some((f) => f.kind === 'quiz.answers')).toBe(true);
  });

  it('空事件流也能导出（0 条是合法状态，不是错误）', () => {
    const doc = buildExport({ events: [], userId: 'local', appVersion: 'v8', now: T0 });
    expect(doc.events).toHaveLength(0);
    expect(doc.counts).toEqual({ events: 0, lastSeq: 0 });
  });
});

describe('parseImportDocument', () => {
  /** 造一份合法的导出文本 */
  function goodText(): string {
    const log = logWith(SAFE_EVENT);
    const doc = buildExport({ events: log.all(), userId: 'local', appVersion: 'v8', now: T0 + 10 });
    return JSON.stringify(doc);
  }

  it('v1 旧备份仍可导入（升级不把旧文件挡在门外）', () => {
    const legacy = {
      schema: 'butler-export@1',
      exportedAt: T0,
      userId: 'local',
      appVersion: 'v8',
      counts: { events: 1, lastSeq: 1 },
      includesCredentials: false,
      credentialScan: { scannedEvents: 1, suspicious: 0 },
      events: [
        {
          id: 'evt_1',
          sessionId: 's_1',
          seq: 1,
          type: 'session.ended',
          actor: 'butler',
          createdAt: T0,
          payload: {},
        },
      ],
    };
    const r = parseImportDocument(JSON.stringify(legacy));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.candidate.doc.schema).toBe(EXPORT_SCHEMA);
      expect(r.candidate.doc.sanitization.redacted).toBe(0);
    }
  });

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
    const doc = JSON.parse(JSON.stringify(built)) as Record<string, unknown>;
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
