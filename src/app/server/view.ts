/**
 * 服务端读模型 —— 把 core 的状态整理成界面能直接渲染的形状
 *
 * 设计依据：方案 § 13（界面与呈现）、ADR 0004（core 不依赖框架）
 *
 * ★ 为什么单独一层而不在 Route Handler 里现算：
 *   · 界面需要的是"**给用户看的形状**"（分组、标签、百分比），
 *     而 core 返回的是领域模型。混在一起会让两边都难改。
 *   · 这层是**只读投影** —— 不写任何状态，因此可以被任意次调用。
 *   · 界面改版时改这里，core 不动。
 *
 * ⚠️ 所有函数都是只读的。写操作走各自的 Route Handler。
 */

import type { BootstrapResult } from '@/core/runtime/bootstrap.js';
import { DOMAIN_DISCIPLINE, DOMAIN_IDS, domainName, type DomainId } from '@/core/domain/types.js';
import {
  CATEGORY_LABEL,
  PATTERN_KIND_LABEL,
  APPLIES_TO_LABEL,
  type ActivityCategory,
  type PatternKind,
  type TemporalPattern,
} from '@/core/activity/types.js';
import { principleStats } from '@/core/memory/principles.js';
import { PATH_LABEL, type ExecutionPath } from '@/core/memory/operation.js';
import { successRate, type OperationMemory } from '@/core/memory/operations.js';
import { STATE_LABEL } from '@/core/mcp/types.js';
import { TASK_LABEL } from '@/core/schedule/scheduler.js';
import { KIND_LABEL as ATTACH_KIND_LABEL } from '@/core/multimodal/attach.js';

// ═══════════════════════════════════════════════════════════
// 通用形状
// ═══════════════════════════════════════════════════════════

export interface MemoryCard {
  readonly id: string;
  readonly kind: string;
  readonly kindLabel: string;
  readonly memClass: string;
  readonly memClassLabel: string;
  readonly content: string;
  readonly lifecycle: string;
  readonly lifecycleLabel: string;
  /** 0—100 的整数，便于界面直接显示 */
  readonly fitnessPercent: number;
  readonly confidencePercent: number;
  readonly evidenceCount: number;
  readonly ownerLabel: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
  /** 原则专属 */
  readonly principle?: { readonly condition: string; readonly action: string };
  readonly effectiveness?: {
    readonly applied: number;
    readonly succeeded: number;
    readonly successPercent: number;
  };
  /** 是否由系统自主生效（而非用户审核） */
  readonly autonomous: boolean;
}

const LIFECYCLE_LABEL: Record<string, string> = {
  candidate: '待审核',
  active: '生效中',
  dormant: '已休眠',
  archived: '已归档',
};

const KIND_LABEL: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  principle: '原则',
};

const CLASS_LABEL: Record<string, string> = {
  global_constraint: '全局硬约束',
  global_shared: '全局共享',
  sensitive: '敏感域',
  domain: '领域记忆',
};

/** 把一条记忆整理成界面卡片。 */
export function toMemoryCard(
  entry: ReturnType<BootstrapResult['memory']['get']> & object,
  autonomousIds: ReadonlySet<string>,
): MemoryCard {
  const e = entry;
  const sv = e.domain ?? null;

  return {
    id: e.id,
    kind: e.kind,
    kindLabel: KIND_LABEL[e.kind] ?? e.kind,
    memClass: e.memClass,
    memClassLabel: CLASS_LABEL[e.memClass] ?? e.memClass,
    content: e.content,
    lifecycle: e.lifecycle,
    lifecycleLabel: LIFECYCLE_LABEL[e.lifecycle] ?? e.lifecycle,
    fitnessPercent: Math.round(e.fitness * 100),
    confidencePercent: Math.round(e.confidence * 100),
    evidenceCount: e.evidence.length,
    ownerLabel: sv !== null ? domainName(sv) : '管家（全局）',
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    version: e.version,
    ...(e.principle !== undefined
      ? { principle: { condition: e.principle.condition, action: e.principle.action } }
      : {}),
    ...(e.effectiveness !== undefined
      ? {
          effectiveness: {
            applied: e.effectiveness.applied,
            succeeded: e.effectiveness.succeeded,
            successPercent:
              e.effectiveness.applied === 0
                ? 0
                : Math.round((e.effectiveness.succeeded / e.effectiveness.applied) * 100),
          },
        }
      : {}),
    autonomous: autonomousIds.has(e.id),
  };
}

// ═══════════════════════════════════════════════════════════
// 总览
// ═══════════════════════════════════════════════════════════

export interface OverviewData {
  readonly resume: {
    readonly resumed: boolean;
    readonly historicalEvents: number;
    readonly restored: BootstrapResult['restored'];
    readonly issues: number;
    readonly badLines: number;
    readonly summary: string;
  };
  readonly memory: {
    readonly total: number;
    readonly byLifecycle: Readonly<Record<string, number>>;
    readonly byKind: Readonly<Record<string, number>>;
    readonly byClass: Readonly<Record<string, number>>;
    /** 待审核条数 —— 界面上要给用户一个明确的"有事待办" */
    readonly pendingReview: number;
    /** 系统自主生效的条数 */
    readonly autonomous: number;
  };
  readonly principles: {
    readonly total: number;
    readonly active: number;
    readonly everApplied: number;
    readonly applied: number;
    readonly succeeded: number;
    readonly avgSuccessPercent: number;
  };
  /**
   * ⚠️ 字段名仍是 `servants`（遗留，界面阶段统一改）。
   *    但内容语义已改为**领域分布**：`DomainId` + 领域名 + 专业纪律条数。
   *
   * ★ v8（P3）：`test` 字段已删除 —— 那是旧架构的「路由判据」
   *   （"什么请求归这个仆人"），而 A1 的 `DOMAIN_INFO` **已刻意不给 test**：
   *   没路由了，判据没有边界可划。界面继续显示它等于展示一个不存在的概念。
   *   改为 `disciplineCount`：领域现在真正的用途之一（监督员据此选纪律）。
   */
  readonly domains: readonly {
    readonly id: DomainId;
    readonly name: string;
    /** 这个领域的专业纪律条数（监督员复核时会用这几条） */
    readonly disciplineCount: number;
    readonly memories: number;
    readonly principles: number;
  }[];
  readonly patterns: {
    readonly total: number;
    readonly observedDays: number;
    readonly list: readonly {
      readonly id: string;
      readonly kind: string;
      readonly kindLabel: string;
      readonly pattern: string;
      readonly confidencePercent: number;
      readonly appliesToLabel: string;
      readonly observedDays: number;
    }[];
  };
  readonly operations: readonly {
    readonly id: string;
    readonly task: string;
    readonly pathLabel: string;
    readonly attempts: number;
    readonly succeeded: number;
    readonly successPercent: number;
    readonly avgDurationMs: number;
    readonly lastFailure?: string;
  }[];
  readonly artifacts: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: string;
    readonly status: string;
    readonly currentVersion: number;
    readonly versionCount: number;
  }[];
  readonly mcp: readonly {
    readonly id: string;
    readonly name: string;
    readonly transport: string;
    readonly stateLabel: string;
    readonly toolCount: number;
    readonly policyLevel: string;
  }[];
  readonly schedule: readonly {
    readonly kind: string;
    readonly label: string;
    readonly lastRunAt: number;
    readonly lastOutcome: string | null;
    readonly totalRuns: number;
    readonly failedRuns: number;
    readonly costsTokens: boolean;
  }[];
  readonly checkpoints: number;
  readonly model: { readonly configured: boolean; readonly name: string | null };
}

/** 从一次会话的事件流里抽出「哪些记忆是系统自主生效的」。 */
export function autonomousIdsOf(rt: BootstrapResult): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of rt.log.byType('memory.approved')) {
    const p = e.payload as { memoryId?: string; decidedBy?: string; audit?: string };
    if (p.decidedBy === 'system' && p.audit === 'autoAdmission' && p.memoryId !== undefined) {
      out.add(p.memoryId);
    }
  }
  return out;
}

export function buildOverview(rt: BootstrapResult, opts: { readonly model: string | null }): OverviewData {
  const all = rt.memory.all();
  const autonomous = autonomousIdsOf(rt);

  const count = <T extends string>(items: readonly T[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const i of items) out[i] = (out[i] ?? 0) + 1;
    return out;
  };

  const stats = principleStats(rt.memory);

  // 时间维度规律（从事件流里取最近一次派生结果）
  const patternEvents = rt.log.byType('pattern.derived');
  const seen = new Set<string>();
  const patternList: OverviewData['patterns']['list'][number][] = [];
  let observedDays = 0;
  for (const e of patternEvents) {
    const p = e.payload as {
      patternId?: string;
      kind?: string;
      pattern?: string;
      confidence?: number;
      observedDays?: number;
      appliesTo?: string;
    };
    if (p.patternId === undefined || seen.has(p.patternId)) continue;
    seen.add(p.patternId);
    observedDays = Math.max(observedDays, p.observedDays ?? 0);
    patternList.push({
      id: p.patternId,
      kind: p.kind ?? 'routine',
      kindLabel: PATTERN_KIND_LABEL[(p.kind ?? 'routine') as PatternKind] ?? p.kind ?? '',
      pattern: p.pattern ?? '',
      confidencePercent: Math.round((p.confidence ?? 0) * 100),
      appliesToLabel:
        APPLIES_TO_LABEL[(p.appliesTo ?? 'all') as keyof typeof APPLIES_TO_LABEL] ?? '每天',
      observedDays: p.observedDays ?? 0,
    });
  }
  patternList.sort((a, b) => b.confidencePercent - a.confidencePercent);

  return {
    resume: {
      resumed: rt.resumed,
      historicalEvents: rt.historicalEvents,
      restored: rt.restored,
      issues: rt.issues.length,
      badLines: rt.badLines,
      summary: '',
    },
    memory: {
      total: all.length,
      byLifecycle: count(all.map((m) => m.lifecycle)),
      byKind: count(all.map((m) => m.kind)),
      byClass: count(all.map((m) => m.memClass)),
      pendingReview: all.filter((m) => m.lifecycle === 'candidate').length,
      autonomous: all.filter((m) => autonomous.has(m.id)).length,
    },
    principles: {
      total: stats.total,
      active: stats.active,
      everApplied: stats.everApplied,
      applied: stats.applied,
      succeeded: stats.succeeded,
      avgSuccessPercent: Math.round(stats.avgSuccessRate * 100),
    },
    domains: DOMAIN_IDS.map((id) => {
      const mine = all.filter((m) => m.memClass === 'domain' && m.domain === id);
      return {
        id,
        name: domainName(id),
        disciplineCount: DOMAIN_DISCIPLINE[id].length,
        memories: mine.length,
        principles: mine.filter((m) => m.kind === 'principle').length,
      };
    }),
    patterns: { total: patternList.length, observedDays, list: patternList.slice(0, 12) },
    operations: rt.operations.all().map((m: OperationMemory) => ({
      id: m.id,
      task: m.taskLabel,
      pathLabel: m.path !== undefined ? PATH_LABEL[m.path as ExecutionPath] : '—',
      attempts: m.effectiveness?.attempts ?? 0,
      succeeded: m.effectiveness?.succeeded ?? 0,
      successPercent: Math.round(successRate(m) * 100),
      avgDurationMs: Math.round(m.effectiveness?.avgDurationMs ?? 0),
      ...(m.effectiveness?.lastFailure !== undefined
        ? { lastFailure: m.effectiveness.lastFailure }
        : {}),
    })),
    artifacts: rt.artifacts.all().map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      status: a.status,
      currentVersion: a.currentVersion,
      versionCount: rt.artifacts.revisions(a.id).length,
    })),
    mcp: rt.mcp.listServers().map((s) => ({
      id: s.config.id,
      name: s.config.name,
      transport: s.config.transport,
      stateLabel: STATE_LABEL[s.state],
      toolCount: s.tools.length,
      policyLevel: s.config.policy.level,
    })),
    schedule: rt.scheduler.overview().map((t) => ({
      kind: t.kind,
      label: TASK_LABEL[t.kind],
      lastRunAt: t.lastRunAt,
      lastOutcome: t.lastOutcome,
      totalRuns: t.totalRuns,
      failedRuns: t.failedRuns,
      costsTokens: t.costsTokens,
    })),
    checkpoints: rt.checkpoints.all().length,
    model: { configured: opts.model !== null, name: opts.model },
  };
}

/** 活动分类标签（供界面复用）。 */
export function activityCategoryLabel(c: ActivityCategory): string {
  return CATEGORY_LABEL[c];
}

/** 附件类型标签（供界面复用）。 */
export function attachmentKindLabel(k: keyof typeof ATTACH_KIND_LABEL): string {
  return ATTACH_KIND_LABEL[k];
}

export type { TemporalPattern };
