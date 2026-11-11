/**
 * 记忆库重放 —— 从事件流重建状态
 *
 * 设计依据：方案 § 4.1（事件是唯一真相源）、§ 5.1（截断 + 重放）、ADR 0004（确定性）
 *
 * ★ 这个模块是**跨重启存活**的核心：
 *
 *   EventLog（追加写盘） ──重放──▶ MemoryStore（内存状态）
 *
 *   没有它，"渐进式记忆演化"里的"渐进"不成立 ——
 *   进程一重启，会话 50 就退回会话 1。
 *
 * ★ 三条纪律：
 *   ① **不发事件** —— 走 `restoreEntry` 注入路径。
 *      用 `create()` 重放会把历史事件再发一遍，事件流被污染。
 *   ② **完整状态来自事件** —— 只认 `memory.created` 与各状态事件的 `snapshot`，
 *      不做任何推断。推断会让重放结果与真实状态悄悄分叉。
 *   ③ **可验证** —— 重放结果能与原始状态做等价性比较（见 `diffStores`）。
 *
 * ⚠️ 一条重要限制：本重放**不重算适应度**。
 *    `fitness.updated` 事件里带的 `snapshot.fitness` 就是当时的真实值，
 *    重算会引入浮点差异且依赖演化历史。
 *    ——这与"重放应当确定"的要求一致：**重放是恢复，不是重新演化**。
 */

import type { SessionEvent } from '../events/types.js';
import type { MemoryStore } from './store.js';
import type { MemoryEntry, MemoryRevision } from './types.js';

// ═══════════════════════════════════════════════════════════
// 结果
// ═══════════════════════════════════════════════════════════

export interface ReplayMemoryResult {
  /** 重建出的条目（按 id 索引） */
  readonly entries: readonly MemoryEntry[];
  readonly revisions: readonly MemoryRevision[];
  /** 处理了多少条与记忆相关的事件 */
  readonly consumedEvents: number;
  /** 跳过了多少条（事件里信息不足以重建） */
  readonly skippedEvents: readonly { readonly seq: number; readonly type: string; readonly why: string }[];
  /** 重放过程中发现的异常（如引用了不存在的 id） */
  readonly anomalies: readonly string[];
}

// ═══════════════════════════════════════════════════════════
// 重放
// ═══════════════════════════════════════════════════════════

/** 与记忆状态相关的事件类型（其余事件重放时直接跳过）。 */
export const MEMORY_STATE_EVENTS: readonly string[] = [
  'memory.created',
  'memory.candidate',
  'memory.approved',
  'memory.rejected',
  'memory.revised',
  'memory.archived',
  'memory.restored',
  'memory.merged',
  'memory.dormant',
  'memory.revived',
  'fitness.updated',
  // ★ v9：遗忘必须参与重放。少了这一条，删除只活到下一次重启。
  'intervention.forgotten',
  'intervention.archivedOut',
];

/**
 * 从事件流重建记忆状态。
 *
 * ★ 纯函数：不碰 store、不发事件，只返回结果。
 *   调用方拿结果去 `store.restoreEntry()` 注入。
 *   这样重放本身可以**离线测试**（不需要 store、不需要 clock）。
 */
export function replayMemory(events: readonly SessionEvent[]): ReplayMemoryResult {
  const entries = new Map<string, MemoryEntry>();
  const revisions: MemoryRevision[] = [];
  const skipped: { seq: number; type: string; why: string }[] = [];
  const anomalies: string[] = [];
  let consumed = 0;

  for (const e of events) {
    if (!MEMORY_STATE_EVENTS.includes(e.type)) continue;
    consumed += 1;

    const p = (e.payload ?? {}) as Record<string, unknown>;

    switch (e.type) {
      case 'memory.created': {
        const raw = p['entry'];
        const entry = parseEntry(raw);
        if (entry === null) {
          // ⚠️ 老事件没有 entry 字段（本字段是后加的）——
          //    如实记为"信息不足"，而不是猜一个出来。
          skipped.push({
            seq: e.seq,
            type: e.type,
            why: '事件里没有 entry 字段（可能是加字段之前写入的历史事件）',
          });
          continue;
        }
        entries.set(entry.id, entry);
        break;
      }

      case 'memory.revised': {
        const rev = parseRevision(p, e.seq, e.createdAt);
        if (rev === null) {
          skipped.push({ seq: e.seq, type: e.type, why: '缺少 version 或 patch' });
          continue;
        }
        revisions.push(rev);

        // 修订也带 snapshot 时直接替换（精确恢复）
        const snap = parseEntry(p['snapshot']);
        if (snap !== null) {
          if (!entries.has(snap.id) && p['memoryId'] !== undefined) {
            anomalies.push(
              `seq ${e.seq}：memory.revised 引用了不存在的记忆 ${String(p['memoryId'])}`,
            );
          }
          entries.set(snap.id, snap);
        }
        break;
      }

      case 'intervention.archivedOut':
      case 'intervention.forgotten': {
        /**
         * ★ v9：删除也参与重放。
         *
         *   没有这一支时：重启后 `memory.created` 会把条目建回来，
         *   用户在界面上看到的"已删除"只活到下一次打开应用。
         */
        const id = typeof p['memoryId'] === 'string' ? p['memoryId'] : '';
        if (id.length === 0) {
          skipped.push({
            seq: e.seq,
            type: e.type,
            why: '遗忘事件没有 memoryId，无法确定删的是哪条',
          });
          break;
        }
        if (!entries.has(id)) {
          // 删除一条本就不存在的记忆：如实记录，不编造状态
          anomalies.push(`seq ${e.seq}：遗忘事件引用了不存在的记忆 ${id}`);
          break;
        }
        entries.delete(id);
        break;
      }

      case 'memory.candidate':
      case 'memory.approved':
      case 'memory.rejected':
      case 'memory.archived':
      case 'memory.merged':
      case 'memory.dormant':
      case 'memory.revived':
      case 'fitness.updated': {
        // ★ 状态变更以 `snapshot` 为准（完整状态，精确恢复）
        const snap = parseEntry(p['snapshot']);
        const id = typeof p['memoryId'] === 'string' ? p['memoryId'] : undefined;

        if (snap !== null) {
          entries.set(snap.id, snap);
          break;
        }

        // 没有 snapshot → 该事件不足以恢复状态，只能如实记录
        if (id !== undefined && !entries.has(id)) {
          anomalies.push(`seq ${e.seq}：${e.type} 引用了不存在的记忆 ${id}`);
        }
        skipped.push({
          seq: e.seq,
          type: e.type,
          why: '事件里没有 snapshot 字段，无法恢复到该时刻的完整状态',
        });
        break;
      }
    }
  }

  return {
    entries: [...entries.values()],
    // 已删除记忆的版本历史不再返回 —— 否则界面/导出仍能拼回原文
    revisions: revisions.filter((r) => entries.has(r.memoryId)),
    consumedEvents: consumed,
    skippedEvents: skipped,
    anomalies,
  };
}

/**
 * 把重放结果注入一个空的 store。
 *
 * ⚠️ 必须注入到**空 store** —— 往已有状态的 store 里注入会让
 *    重放结果与既有状态混在一起，产生无法排查的差异。
 *    本函数会检查并拒绝非空 store。
 */
export function hydrateStore(args: {
  readonly store: MemoryStore;
  readonly result: ReplayMemoryResult;
}): { readonly ok: boolean; readonly reason?: string; readonly hydrated: number } {
  const existing = args.store.all();
  if (existing.length > 0) {
    return {
      ok: false,
      reason: `目标 store 非空（已有 ${existing.length} 条）—— 重放必须注入到空 store`,
      hydrated: 0,
    };
  }

  for (const e of args.result.entries) args.store.restoreEntry(e);
  for (const r of args.result.revisions) args.store.restoreRevision(r);

  return { ok: true, hydrated: args.result.entries.length };
}

// ═══════════════════════════════════════════════════════════
// 解析
// ═══════════════════════════════════════════════════════════

/**
 * 从事件 payload 里解析出一条完整条目。
 *
 * ⚠️ 逐字段收窄而不是整体强转 —— 事件来自磁盘，
 *    可能是旧版本写的、也可能被截断。强转会把坏数据带进状态。
 */
function parseEntry(raw: unknown): MemoryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const id = typeof o['id'] === 'string' ? o['id'] : null;
  const owner = o['owner'];
  if (id === null || typeof owner !== 'object' || owner === null) return null;

  const memClass = o['memClass'];
  if (typeof memClass !== 'string') return null;
  const kind = o['kind'];
  if (typeof kind !== 'string') return null;

  const entry: MemoryEntry = {
    id,
    owner: owner as MemoryEntry['owner'],
    memClass: memClass as MemoryEntry['memClass'],
    kind: kind as MemoryEntry['kind'],
    content: typeof o['content'] === 'string' ? o['content'] : '',
    ...opt('subject', o['subject'], (v) => typeof v === 'string'),
    confidence: num(o['confidence'], 0.5),
    evidence: Array.isArray(o['evidence']) ? (o['evidence'] as string[]) : [],
    fitness: num(o['fitness'], 0.5),
    lifecycle: (typeof o['lifecycle'] === 'string'
      ? o['lifecycle']
      : 'candidate') as MemoryEntry['lifecycle'],
    lastHitAt: numOrNull(o['lastHitAt']),
    hitCount: num(o['hitCount'], 0),
    // ⚠️ `snapshotOf` 把可选字段统一写成 `null`（为了让 JSON 往返后仍能区分
    //    "这个字段当时没有"与"忘了写"）。解析时必须把 `null` 与 `undefined`
    //    都当作**没有**：
    //      · 若当成"有值"，会把 null 塞进状态 → diffStores 报差异
    //      · 若忽略，则 `null` 正确落回 undefined ✓
    ...optNum('dormantSince', o['dormantSince']),
    ...optNum('archivedAt', o['archivedAt']),
    ...opt('mergedFrom', o['mergedFrom'], (v) => Array.isArray(v)),
    revivedCount: num(o['revivedCount'], 0),
    scope: (typeof o['scope'] === 'string' ? o['scope'] : 'global') as MemoryEntry['scope'],
    // ★ v7：领域标签（与 `snapshotOf` 的 `domain` 对应）
    ...opt('domain', o['domain'], (v) => typeof v === 'string'),
    version: num(o['version'], 1),
    ...opt('effectiveness', o['effectiveness'], isObject),
    ...opt('principle', o['principle'], isObject),
    ...opt('grants', o['grants'], (v) => Array.isArray(v)),
    ...opt('capability', o['capability'], isObject),
    createdAt: num(o['createdAt'], 0),
    updatedAt: num(o['updatedAt'], 0),
    useCount: num(o['useCount'], 0),
  };

  return entry;
}

/**
 * 处理"可能是 null 的可选字段"。
 *
 * `null` 与 `undefined` 都表示"没有这个字段"，一律**不写入**。
 */
function opt<K extends string>(
  key: K,
  value: unknown,
  check: (v: unknown) => boolean,
): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (!check(value)) return {};
  return { [key]: value };
}

function optNum<K extends string>(key: K, value: unknown): Record<string, unknown> {
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {};
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `null` 与 `undefined` 都算"没有"。 */
function isObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null;
}

function parseRevision(
  payload: Record<string, unknown>,
  _seq: number,
  createdAt: number,
): MemoryRevision | null {
  const memoryId = payload['memoryId'];
  const version = payload['version'];
  if (typeof memoryId !== 'string' || typeof version !== 'number') return null;

  return {
    memoryId,
    version,
    at: createdAt,
    // patch 的形状由 store.revise 决定，这里原样保留
    patch: (payload['patch'] ?? {}) as MemoryRevision['patch'],
    reason: typeof payload['reason'] === 'string' ? payload['reason'] : '',
  } as MemoryRevision & { readonly at: number };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ═══════════════════════════════════════════════════════════
// 等价性校验
// ═══════════════════════════════════════════════════════════

export interface StoreDiff {
  readonly onlyInA: readonly string[];
  readonly onlyInB: readonly string[];
  readonly differing: readonly {
    readonly id: string;
    readonly fields: readonly string[];
  }[];
  readonly identical: boolean;
}

/**
 * 比较两份记忆状态。
 *
 * ★ 用途：验证"重放出的状态 == 原始状态"。
 *   这是**重放正确性的验收标准** —— 没有它，重放错了也没人知道。
 *
 * ⚠️ 暂不比较 `lastHitAt` / `useCount` / `updatedAt`：
 *    它们是**使用痕迹**，重放时若事件里没带就恢复不出来。
 *    这类字段应当在 `fitness.updated` 的 snapshot 里带全
 *    （见 evolution.ts 的 snapshotOf）。比较时会如实列出差异字段名。
 */
export function diffStores(
  a: readonly MemoryEntry[],
  b: readonly MemoryEntry[],
): StoreDiff {
  const mapA = new Map(a.map((e) => [e.id, e]));
  const mapB = new Map(b.map((e) => [e.id, e]));

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const differing: { id: string; fields: string[] }[] = [];

  for (const [id] of mapA) if (!mapB.has(id)) onlyInA.push(id);
  for (const [id] of mapB) if (!mapA.has(id)) onlyInB.push(id);

  for (const [id, ea] of mapA) {
    const eb = mapB.get(id);
    if (!eb) continue;

    const fields: string[] = [];
    for (const key of COMPARE_FIELDS) {
      const va = (ea as unknown as Record<string, unknown>)[key];
      const vb = (eb as unknown as Record<string, unknown>)[key];
      if (!sameValue(va, vb)) fields.push(key);
    }
    if (fields.length > 0) differing.push({ id, fields });
  }

  return {
    onlyInA,
    onlyInB,
    differing,
    identical: onlyInA.length === 0 && onlyInB.length === 0 && differing.length === 0,
  };
}

/** 参与等价性比较的字段。 */
const COMPARE_FIELDS: readonly string[] = [
  'memClass',
  'kind',
  'content',
  'subject',
  'confidence',
  'evidence',
  'owner',
  'lifecycle',
  'fitness',
  'dormantSince',
  'archivedAt',
  'revivedCount',
  'mergedFrom',
  'effectiveness',
  'principle',
  'createdAt',
  'updatedAt',
  'version',
];

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || a === null) return b === undefined || b === null;
  if (b === undefined || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
