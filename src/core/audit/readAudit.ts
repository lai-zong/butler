/**
 * 审计视图 —— 把事件流里的"依据"读成人能看的东西
 *
 * 设计依据：方案 § 4.1 事件族表格
 *
 *   | 事件族 | 支撑什么 |
 *   | `route.*` / `dispatch.*` / `constraint.injected` |
 *   |   **管家-仆人编排的可审计性（含约束注入可见）** |
 *
 * 自查清单也写明：
 *   · 「`constraint.injected` 事件可查——**用户能看到某任务注入了哪些约束**」
 *   · 「`grant.*` 事件可查——敏感域授权与使用全程留痕」
 *
 * ★★ 为什么要单独做这一层：
 *
 *   之前所有事件**都落了盘**（召回带 relevance、注入带 reason、
 *   硬约束校验带 unhandledBy），但**界面一条都看不到**。
 *
 *   而"可审计"是本项目唯一的差异化卖点 ——
 *   **审计证据用户看不见，等于没有审计。**
 *
 *   数据已经在了，缺的只是"读出来"。
 *
 * ★ 三条纪律：
 *   ① **只读** —— 不产生任何事件，可以被任意次调用
 *   ② **不解释、只呈现** —— 不替事件流做推断（那是分析层的事）
 *   ③ **解释"为什么"** —— 每条依据都带上它的事件来源，
 *      用户点开能追到原始事件（这才叫可审计，而不是"给你看个结论"）
 */

import type { EventLog } from '../events/log.js';
import type { SessionEvent } from '../events/types.js';

// ═══════════════════════════════════════════════════════════
// 形状
// ═══════════════════════════════════════════════════════════

/** 一条召回记录。 */
export interface RecallEvidence {
  readonly seq: number;
  readonly at: number;
  readonly count: number;
  readonly items: readonly {
    readonly memoryId: string;
    readonly memClass: string;
    readonly memClassLabel: string;
    readonly relevance: number;
    /** 相关度百分比（界面直接用） */
    readonly relevancePercent: number;
    /** 是不是硬约束（恒为 1.0，不参与相关性筛选） */
    readonly forced: boolean;
  }[];
}

/** 一条约束注入记录 —— 用户最关心的"你到底给它看了什么"。 */
export interface InjectionEvidence {
  readonly seq: number;
  readonly at: number;
  readonly stepId: string;
  readonly servant: string;
  readonly servantLabel: string;
  readonly memoryId: string;
  readonly content: string;
  readonly source: string;
  readonly sourceLabel: string;
  readonly negotiable: boolean;
  readonly reason: string;
}

/** 一次硬约束校验的结果。 */
export interface HardCheckEvidence {
  readonly seq: number;
  readonly at: number;
  readonly outcome: 'blocked' | 'passed';
  readonly content: string;
  readonly constraintId: string;
  /** 哪些仆人没有处理它 */
  readonly unhandledBy: readonly string[];
  readonly unhandledByLabels: readonly string[];
  /** 是不是确定性判定（非模型）—— 这一点对答辩很重要 */
  readonly deterministic: boolean;
  readonly note: string;
}

/** 一次敏感域授权。 */
export interface GrantEvidence {
  readonly seq: number;
  readonly at: number;
  readonly kind: 'requested' | 'approved' | 'denied' | 'used' | 'expired';
  readonly kindLabel: string;
  readonly memoryId: string;
  readonly toServant: string;
  readonly toServantLabel: string;
  readonly taskId: string;
  readonly reason: string;
  /** 已过期？ */
  readonly expired: boolean;
}

/** 一次越权写入尝试（应当全部被拒）。 */
export interface WriteAttemptEvidence {
  readonly seq: number;
  readonly at: number;
  readonly actor: string;
  readonly memoryId: string;
  readonly reason: string;
  readonly rejected: boolean;
}

/** 一轮对话的完整依据。 */
export interface TurnAudit {
  /** 这一轮的边界（事件 seq 区间） */
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly recalls: readonly RecallEvidence[];
  readonly injections: readonly InjectionEvidence[];
  readonly hardChecks: readonly HardCheckEvidence[];
  readonly grants: readonly GrantEvidence[];
  readonly writeAttempts: readonly WriteAttemptEvidence[];
  /** 一句话摘要 */
  readonly summary: string;
}

// ═══════════════════════════════════════════════════════════
// 标签
// ═══════════════════════════════════════════════════════════

const CLASS_LABEL: Record<string, string> = {
  global_constraint: '全局硬约束',
  global_shared: '全局共享',
  sensitive: '敏感域',
  domain: '领域记忆',
};

const SERVANT_LABEL: Record<string, string> = {
  life: '生活仆人',
  health: '健康仆人',
  study: '学习仆人',
  work: '办公仆人',
  code: '代码仆人',
  butler: '管家',
};

const GRANT_LABEL: Record<string, string> = {
  requested: '请求授权',
  approved: '授权通过',
  denied: '授权被拒',
  used: '使用授权',
  expired: '授权过期',
};

/**
 * ★ 为什么每个都带 `Label` 字段：
 *   界面不该自己维护一份枚举翻译 —— 那必然与领域层漂移，
 *   而漂移的表现是"界面显示 global_constraint"这种原始值。
 */
function servantLabel(id: string): string {
  return SERVANT_LABEL[id] ?? id;
}

// ═══════════════════════════════════════════════════════════
// 读取
// ═══════════════════════════════════════════════════════════

/**
 * 读取一段事件区间里的全部依据。
 *
 * ★ 为什么按 **seq 区间**而不是"按消息 id"：
 *   事件流是**线性**的，一轮对话对应一段连续 seq。
 *   用消息 id 去关联需要额外的映射表，而那张表本身也会成为
 *   需要维护和可能出错的东西（"这条注入属于哪一轮"没有唯一答案时怎么办）。
 *
 *   seq 区间是**由事件流结构本身给出的**，不需要额外记账。
 */
export function readTurnAudit(
  log: EventLog,
  range: { readonly fromSeq: number; readonly toSeq: number },
): TurnAudit {
  const events = log.range(range.fromSeq, range.toSeq);

  const recalls: RecallEvidence[] = [];
  const injections: InjectionEvidence[] = [];
  const hardChecks: HardCheckEvidence[] = [];
  const grants: GrantEvidence[] = [];
  const writeAttempts: WriteAttemptEvidence[] = [];

  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;

    switch (e.type) {
      case 'memory.recalled': {
        const raw = Array.isArray(p['items']) ? (p['items'] as Record<string, unknown>[]) : [];
        recalls.push({
          seq: e.seq,
          at: e.createdAt,
          count: typeof p['count'] === 'number' ? p['count'] : raw.length,
          items: raw.map((it) => {
            const memClass = typeof it['memClass'] === 'string' ? it['memClass'] : '';
            const relevance = typeof it['relevance'] === 'number' ? it['relevance'] : 0;
            return {
              memoryId: typeof it['id'] === 'string' ? it['id'] : '',
              memClass,
              memClassLabel: CLASS_LABEL[memClass] ?? memClass,
              relevance,
              relevancePercent: Math.round(relevance * 100),
              // ★ 硬约束恒为 1.0 —— 界面上要标出来"它是被强制带回的"
              forced: memClass === 'global_constraint',
            };
          }),
        });
        break;
      }

      case 'constraint.injected': {
        const servant = typeof p['servant'] === 'string' ? p['servant'] : '';
        const source = typeof p['source'] === 'string' ? p['source'] : '';
        injections.push({
          seq: e.seq,
          at: e.createdAt,
          stepId: typeof p['stepId'] === 'string' ? p['stepId'] : '',
          servant,
          servantLabel: servantLabel(servant),
          memoryId: typeof p['memoryId'] === 'string' ? p['memoryId'] : '',
          content: typeof p['content'] === 'string' ? p['content'] : '',
          source,
          sourceLabel: CLASS_LABEL[source] ?? source,
          negotiable: p['negotiable'] === true,
          reason: typeof p['reason'] === 'string' ? p['reason'] : '',
        });
        break;
      }

      case 'constraint.hardBlocked': {
        const unhandled = Array.isArray(p['unhandledBy'])
          ? (p['unhandledBy'] as string[])
          : [];
        hardChecks.push({
          seq: e.seq,
          at: e.createdAt,
          outcome: 'blocked',
          content: typeof p['content'] === 'string' ? p['content'] : '',
          constraintId: typeof p['constraintId'] === 'string' ? p['constraintId'] : '',
          unhandledBy: unhandled,
          unhandledByLabels: unhandled.map(servantLabel),
          deterministic: p['deterministic'] === true,
          note: typeof p['note'] === 'string' ? p['note'] : '',
        });
        break;
      }

      case 'grant.requested':
      case 'grant.approved':
      case 'grant.denied':
      case 'grant.used':
      case 'grant.expired': {
        const kindRaw = e.type.split('.')[1] ?? '';
        const kind = (
          ['requested', 'approved', 'denied', 'used', 'expired'].includes(kindRaw)
            ? kindRaw
            : 'requested'
        ) as GrantEvidence['kind'];
        const expiresAt = typeof p['expiresAt'] === 'number' ? p['expiresAt'] : 0;
        const toServant = typeof p['toServant'] === 'string' ? p['toServant'] : '';
        grants.push({
          seq: e.seq,
          at: e.createdAt,
          kind,
          kindLabel: GRANT_LABEL[kind] ?? kind,
          memoryId: typeof p['memoryId'] === 'string' ? p['memoryId'] : '',
          toServant,
          toServantLabel: servantLabel(toServant),
          taskId: typeof p['taskId'] === 'string' ? p['taskId'] : '',
          reason: typeof p['reason'] === 'string' ? p['reason'] : '',
          expired: expiresAt > 0 && expiresAt < Date.now(),
        });
        break;
      }

      case 'memory.writeAttempted': {
        writeAttempts.push({
          seq: e.seq,
          at: e.createdAt,
          actor: typeof p['actor'] === 'string' ? p['actor'] : '',
          memoryId: typeof p['memoryId'] === 'string' ? p['memoryId'] : '',
          reason: typeof p['reason'] === 'string' ? p['reason'] : '',
          // ★ 方案 § 2.2⑥：全局层仅管家可写 —— 仆人的写入尝试**应全部被拒**
          rejected: p['rejected'] !== false,
        });
        break;
      }

      default:
        break;
    }
  }

  return {
    fromSeq: range.fromSeq,
    toSeq: range.toSeq,
    recalls,
    injections,
    hardChecks,
    grants,
    writeAttempts,
    summary: summarize(recalls, injections, hardChecks, grants, writeAttempts),
  };
}

/** 会话级的审计总览（用户想一次看完"它到底用过什么"）。 */
export function readSessionAudit(log: EventLog): TurnAudit {
  const all = log.all();
  const first = all[0]?.seq ?? 1;
  const last = all[all.length - 1]?.seq ?? 1;
  return readTurnAudit(log, { fromSeq: first, toSeq: last });
}

// ═══════════════════════════════════════════════════════════
// 摘要
// ═══════════════════════════════════════════════════════════

/**
 * ★ 摘要的价值：用户不该为了知道"有没有异常"而逐条读事件。
 *
 * ⚠️ 只报**需要动作**的事（拦截、拒绝、过期授权），
 *    正常的召回与注入不占摘要 —— 否则摘要会变成噪音，
 *    用户会学会忽略它。
 */
function summarize(
  recalls: readonly RecallEvidence[],
  injections: readonly InjectionEvidence[],
  hardChecks: readonly HardCheckEvidence[],
  grants: readonly GrantEvidence[],
  writeAttempts: readonly WriteAttemptEvidence[],
): string {
  const parts: string[] = [];

  const recallCount = recalls.reduce((n, r) => n + r.count, 0);
  if (recallCount > 0) parts.push(`召回 ${recallCount} 条记忆`);
  if (injections.length > 0) parts.push(`注入 ${injections.length} 条约束`);

  if (hardChecks.length > 0) parts.push(`⛔ ${hardChecks.length} 处硬约束未被处理`);

  const rejectedWrites = writeAttempts.filter((w) => w.rejected).length;
  if (rejectedWrites > 0) parts.push(`${rejectedWrites} 次越权写入被拒`);

  const activeGrants = grants.filter((g) => g.kind === 'approved' && !g.expired).length;
  if (activeGrants > 0) parts.push(`${activeGrants} 项授权在用`);

  return parts.length > 0 ? parts.join(' · ') : '本轮没有产生需要审计的动作';
}

/** 供界面判断"这轮值不值得展开"。 */
export function hasAuditContent(audit: TurnAudit): boolean {
  return (
    audit.recalls.length > 0 ||
    audit.injections.length > 0 ||
    audit.hardChecks.length > 0 ||
    audit.grants.length > 0 ||
    audit.writeAttempts.length > 0
  );
}

export type { SessionEvent };
