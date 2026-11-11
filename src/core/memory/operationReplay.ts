/**
 * 操作记忆快照与重放 —— 让"越做越快越准"跨重启成立
 *
 * 设计依据：方案 § 6.3（记忆化执行，**差异化核心**）
 *
 * ★ 为什么操作记忆必须持久化：
 *   方案的原话是「**同一个任务做得越多越快越准**」。
 *
 *   这个主张的全部价值在**跨会话的积累**：
 *     第 1 次：试 UI 失败 → 改用 COM 成功
 *     第 5 次：**直接走 COM**
 *
 *   如果进程重启就把"COM 可行、UI 不可行"忘掉，
 *   那第 5 次还是从零试 —— **差异化主张不成立**。
 *
 * ⚠️ 与记忆库/产出物同一套约定：状态以事件里的 `snapshot` 为准，
 *    重放不发事件、不做推断。
 */

import type { SessionEvent } from '../events/types.js';
import type { OperationMemory } from './operation.js';

/**
 * 把一条操作记忆压成可重建的完整状态。
 *
 * ⚠️ 与 `OperationMemory` 的字段集保持一致；
 *    新增可影响状态的字段时这里要同步加，否则重放会丢字段
 *    （而丢字段不会报错，只会让"越做越准"悄悄失效）。
 */
export function operationSnapshotOf(m: OperationMemory | undefined): Record<string, unknown> | null {
  if (!m) return null;
  return {
    id: m.id,
    userId: m.userId,
    kind: m.kind,
    taskSignature: m.taskSignature,
    taskLabel: m.taskLabel,
    content: m.content,
    path: m.path ?? null,
    // ⚠️ 新增字段必须在这里同步 —— 漏了会让"按应用聚合"在重放后静默失效
    app: m.app ?? null,
    effectiveness: m.effectiveness ?? null,
    confidence: m.confidence,
    evidence: m.evidence,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export interface ReplayOperationResult {
  readonly operations: readonly OperationMemory[];
  readonly consumedEvents: number;
  readonly skippedEvents: readonly { readonly seq: number; readonly type: string; readonly why: string }[];
}

/**
 * 从事件流重建操作记忆。
 *
 * 事件类型用 `fitness.updated`（操作记忆与记忆库共用它，
 * 靠 payload 里的 `kind` 区分 —— 操作记忆的都是 `kind: 'operation'`）。
 */
export function replayOperations(events: readonly SessionEvent[]): ReplayOperationResult {
  const byId = new Map<string, OperationMemory>();
  const skipped: { seq: number; type: string; why: string }[] = [];
  let consumed = 0;

  for (const e of events) {
    if (e.type !== 'fitness.updated') continue;

    const p = (e.payload ?? {}) as Record<string, unknown>;
    /**
     * ⚠️ 必须先认领：记忆库与"状态字段更新"的 `fitness.updated` 也走这个类型，
     *    不筛选就会把它们当成操作记忆解析。
     *
     * ★ 认领范围**不止 operation**：
     *   偏好（preference）与环境（environment）是另外两个 kind。
     *   旧实现只认 `operation`，于是这两类记忆根本没进重放器 ——
     *   重启后整体消失，`relevantGuidance()` 返回空（实测 2 条 → 0 条）。
     *
     *   注意：`operationMemoryId` 才是可靠的判据（记忆库的写法用 `memoryId`）。
     */
    const kind = p['kind'];
    const isOperationLike =
      typeof p['operationMemoryId'] === 'string' &&
      (kind === 'operation' || kind === 'preference' || kind === 'environment');
    if (!isOperationLike) continue;
    consumed += 1;

    const parsed = parseOperation(p['snapshot']);
    if (parsed === null) {
      skipped.push({
        seq: e.seq,
        type: e.type,
        why: '事件里没有可用的 snapshot 字段',
      });
      continue;
    }
    byId.set(parsed.id, parsed);
  }

  return {
    operations: [...byId.values()],
    consumedEvents: consumed,
    skippedEvents: skipped,
  };
}

/** 把重放结果注入一个空的操作记忆仓储。 */
export function hydrateOperationStore(args: {
  readonly store: { all(): readonly OperationMemory[]; restoreOperation(m: OperationMemory): void };
  readonly result: ReplayOperationResult;
}): { readonly ok: boolean; readonly reason?: string; readonly hydrated: number } {
  const existing = args.store.all();
  if (existing.length > 0) {
    return {
      ok: false,
      reason: `目标 store 非空（已有 ${existing.length} 条操作记忆）—— 重放必须注入到空 store`,
      hydrated: 0,
    };
  }

  for (const m of args.result.operations) args.store.restoreOperation(m);
  return { ok: true, hydrated: args.result.operations.length };
}

// ═══════════════════════════════════════════════════════════
// 解析
// ═══════════════════════════════════════════════════════════

function parseOperation(raw: unknown): OperationMemory | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const id = typeof o['id'] === 'string' ? o['id'] : null;
  const taskSignature = typeof o['taskSignature'] === 'string' ? o['taskSignature'] : null;
  if (id === null || taskSignature === null) return null;

  const kind = o['kind'];
  if (kind !== 'method' && kind !== 'preference' && kind !== 'environment') return null;

  return {
    id,
    userId: typeof o['userId'] === 'string' ? o['userId'] : '',
    kind,
    taskSignature,
    taskLabel: typeof o['taskLabel'] === 'string' ? o['taskLabel'] : '',
    content: typeof o['content'] === 'string' ? o['content'] : '',
    ...(typeof o['path'] === 'string'
      ? { path: o['path'] as NonNullable<OperationMemory['path']> }
      : {}),
    // ★ 旧事件没有 app 字段 → 不写（回退到从签名解析，见 byApp）
    ...(typeof o['app'] === 'string' ? { app: o['app'] } : {}),
    ...(typeof o['effectiveness'] === 'object' && o['effectiveness'] !== null
      ? { effectiveness: o['effectiveness'] as NonNullable<OperationMemory['effectiveness']> }
      : {}),
    confidence: num(o['confidence'], 0.5),
    evidence: Array.isArray(o['evidence']) ? (o['evidence'] as string[]) : [],
    createdAt: num(o['createdAt'], 0),
    updatedAt: num(o['updatedAt'], 0),
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 比较两份操作记忆状态（重放正确性的验收标准）。
 *
 * ⚠️ 不能直接 `JSON.stringify(a) === JSON.stringify(b)`：
 *    两者字段语义相同、但**键顺序**可能不同（建档路径与重放路径的对象字面量顺序不同），
 *    于是验证 7 会把"完全一致"误报成差异（实测：唯一差异是 app/content 的先后）。
 *    这里按 key 排序后再比较。
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** 比较两份操作记忆状态（重放正确性的验收标准）。 */
export function diffOperations(
  a: readonly OperationMemory[],
  b: readonly OperationMemory[],
): { readonly identical: boolean; readonly differing: readonly string[] } {
  if (a.length !== b.length) return { identical: false, differing: ['(数量不同)'] };
  const mapB = new Map(b.map((x) => [x.id, x]));
  const differing: string[] = [];
  for (const ea of a) {
    const eb = mapB.get(ea.id);
    if (!eb || stableJson(ea) !== stableJson(eb)) differing.push(ea.id);
  }
  return { identical: differing.length === 0, differing };
}
