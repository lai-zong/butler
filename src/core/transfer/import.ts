/**
 * 导入（v8 · 方案 §5.5）
 *
 * ★ 纯逻辑：只做"这份文档能不能导"的判定与归一化。
 *   **写文件与重建运行时都在 API 层** —— 因为那两步会动真实状态，
 *   不该混在可单测的纯函数里。
 *
 * ★★ 为什么不兼容时必须**明确拒绝**（方案 §5.5 原话）：
 *
 *   导入是"把整份历史换成另一份"。如果字段语义猜错，
 *   结果是**数据看起来在、但行为不一致** —— 比导不进来糟糕得多。
 *   所以这里对版本做**精确匹配**，不做"尽力兼容"。
 *
 * ⚠️ 一个真实事故的约束（`bootstrap.ts` 注释）：
 *   导入**绝不能**往运行中的 `EventLog` 追加 —— 那会让 seq 撞号，
 *   磁盘上出现两个 `seq=1`，读回时按 seq 去重**历史悄悄少一条**。
 *   所以导入路径必须是：校验 → 写文件 → 重置运行时 → 重新 bootstrap。
 */

import { ALL_EVENT_TYPES, type EventType, type SessionEvent } from '../events/types.js';
import { exportDocumentSchema, EXPORT_SCHEMA, type ImportCandidate, type ImportRejection } from './schema.js';

/**
 * 已知事件类型集合。
 *
 * ★ 用途：导入时**必须**拒绝不认识的事件类型。
 *
 *   ⚠️ 为什么不能"忽略不认识的事件继续导入"：
 *      事件是唯一真相源。丢掉一部分事件 = 导入后的状态与导出时**不一致**，
 *      而用户看到的是"导入成功"。那是数据损坏，不是兼容。
 *
 *   ⚠️ 为什么不能 `as EventType` 强转：
 *      强转只贴标签不检查，于是未知类型会流进重放逻辑 ——
 *      重放的 `default: break` 会**静默忽略**它，同样造成"少了一部分历史"。
 */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(ALL_EVENT_TYPES);

/** 类型守卫：已校验成员关系，谓词成立 */
function isKnownEventType(s: string): s is EventType {
  return KNOWN_EVENT_TYPES.has(s);
}

export type ImportResult =
  | { readonly ok: true; readonly candidate: ImportCandidate }
  | { readonly ok: false; readonly rejection: ImportRejection };

/**
 * 校验并归一化一份导入文档。
 *
 * 判定顺序（**先便宜后贵**，也让报错尽量具体）：
 *   ① 能不能解析成 JSON
 *   ② schema 版本是否精确匹配
 *   ③ 结构是否符合
 *   ④ 有没有事件
 *   ⑤ seq 是否 1..N 连续（事件日志的不变量 I1）
 */
export function parseImportDocument(raw: string): ImportResult {
  // ① JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      rejection: { kind: 'not-json', detail: err instanceof Error ? err.message : String(err) },
    };
  }

  // ② 版本：**精确匹配**，不兼容就明确说清楚"文件是哪一版、程序要哪一版"
  const schemaField =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['schema']
      : undefined;
  if (schemaField !== EXPORT_SCHEMA) {
    return {
      ok: false,
      rejection: {
        kind: 'schema-mismatch',
        got: typeof schemaField === 'string' ? schemaField : '（缺失）',
        want: EXPORT_SCHEMA,
      },
    };
  }

  // ③ 结构
  const result = exportDocumentSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    return {
      ok: false,
      rejection: {
        kind: 'malformed',
        detail:
          first !== undefined
            ? `${first.path.join('.') || '(根)'}：${first.message}`
            : '文档结构不符合导出格式',
      },
    };
  }
  const doc = result.data;

  // ④ 空文档
  if (doc.events.length === 0) {
    return { ok: false, rejection: { kind: 'empty' } };
  }

  // ⑤ seq 连续（不变量 I1：从 1 开始、单调递增、无空洞）
  //
  // ⚠️ 为什么必须校验这条：事件日志按 seq 去重与截断回退。
  //    有空洞或重复时，重放会**静默丢事件** —— 数据看起来在，实际少了。
  const seqs = doc.events.map((e) => e.seq).sort((a, b) => a - b);
  for (let i = 0; i < seqs.length; i++) {
    const expected = i + 1;
    if (seqs[i] !== expected) {
      return {
        ok: false,
        rejection: {
          kind: 'seq-not-contiguous',
          detail: `第 ${i + 1} 条事件的 seq 应为 ${expected}，实际 ${String(seqs[i])}`,
        },
      };
    }
  }

  // ⑥ 事件类型必须都认识（见 `KNOWN_EVENT_TYPES` 的说明）
  //
  // ★ 这一步同时完成**类型收窄**：通过之后，`e.type` 已经是 `EventType`，
  //   下面构造 `SessionEvent` 时不需要任何 `as` 强转。
  const events: SessionEvent[] = [];
  for (const e of doc.events) {
    if (!isKnownEventType(e.type)) {
      return {
        ok: false,
        rejection: { kind: 'unknown-event-type', eventType: e.type, seq: e.seq },
      };
    }
    events.push({
      id: e.id,
      sessionId: e.sessionId,
      seq: e.seq,
      type: e.type,
      actor: e.actor as SessionEvent['actor'],
      createdAt: e.createdAt,
      payload: e.payload,
      ...(e.parentEventId !== undefined ? { parentEventId: e.parentEventId } : {}),
      ...(e.servantId !== undefined ? { servantId: e.servantId } : {}),
    });
  }

  // counts 自洽性（导出时写的统计与内容必须一致，否则文件被改过）
  if (doc.counts.events !== doc.events.length) {
    return {
      ok: false,
      rejection: {
        kind: 'malformed',
        detail: `counts.events=${doc.counts.events} 与实际事件数 ${doc.events.length} 不一致`,
      },
    };
  }
  const lastSeq = seqs[seqs.length - 1] ?? 0;
  if (doc.counts.lastSeq !== lastSeq) {
    return {
      ok: false,
      rejection: {
        kind: 'malformed',
        detail: `counts.lastSeq=${doc.counts.lastSeq} 与实际最大 seq ${lastSeq} 不一致`,
      },
    };
  }

  return { ok: true, candidate: { doc, eventCount: doc.events.length, events } };
}

/** 把拒绝原因转成**给用户看的中文说明**（API 层直接用）*/
export function describeRejection(r: ImportRejection): string {
  switch (r.kind) {
    case 'not-json':
      return '这不是一个合法的 JSON 文件。';
    case 'schema-mismatch':
      return `导出文件格式不兼容：文件是 ${r.got}，本程序需要 ${r.want}。请用它导出时的同一版本导入，或重新导出。`;
    case 'malformed':
      return `导出文件结构有问题：${r.detail}`;
    case 'unknown-event-type':
      return `导出文件里有本程序不认识的事件类型「${r.eventType}」（seq ${r.seq}）。多半是更新版本导出的文件，请用同一版本导入。已拒绝以避免丢掉这部分历史。`;
    case 'seq-not-contiguous':
      return `导出文件的事件序号不连续：${r.detail}。文件可能被修改过，已拒绝导入以免丢历史。`;
    case 'empty':
      return '导出文件里没有任何事件，没有可导入的内容。';
  }
}
