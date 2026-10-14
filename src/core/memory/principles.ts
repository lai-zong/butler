/**
 * 原则的注入与违背检测
 *
 * 设计依据：方案 § 3.2（效果验证）、§ 2.2③（原则违背检查）、§ 8.8
 *
 * ★ 这个模块补的是一个**真闭环缺口**：
 *   反思能产出原则、用户能审核生效，但**执行时从不注入它们** ——
 *   `principle.applied` 事件从来没被发出过。
 *   等于"学了但不用"，创新点 ② 的"效果验证"也就无从谈起。
 *
 * 闭环应该是：
 *   反思产出候选 → 用户审核生效 → **执行时按条件注入**（applied +1）
 *   → 事后检查是否被遵守（succeeded +1 或记违背）→ 效果差自动降权
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import type { MemoryStore } from './store.js';
import { isRelevant } from '../text/keywords.js';
import type { MemoryEntry } from './types.js';

// ═══════════════════════════════════════════════════════════
// 候选筛选与排序
// ═══════════════════════════════════════════════════════════

export interface PrincipleCandidate {
  readonly principle: MemoryEntry;
  /** 与本次任务的相关度 */
  readonly relevance: number;
  /** 为什么选它（供审计与界面展示） */
  readonly why: string;
}

/** 一次任务最多注入几条原则 —— 太多会淹没任务本身。 */
export const MAX_PRINCIPLES_PER_TASK = 3;

/**
 * 挑出本次任务该用的原则。
 *
 * 只考虑 `kind === 'principle'` 且**已生效**（active）的记忆。
 *
 * 排序依据（体现"优胜劣汰"）：
 *   ① 条件与任务的相关性 —— 不相关的不该注入
 *   ② 效果好的优先 —— succeeded / applied 高的排前面
 *   ③ 适应度作为兜底
 *
 * ⚠️ 效果差的原则会被**降权而非排除**：它仍然可能被注入（否则永远无法翻身），
 *    但排序靠后。这是"渐变"而非"一刀切"。
 */
export function selectPrinciples(args: {
  readonly store: MemoryStore;
  /** 本次任务指令 / 用户目标 */
  readonly task: string;
  /** 偏好的仆人领域（该领域的领域原则优先） */
  readonly servant?: string;
  readonly limit?: number;
}): readonly PrincipleCandidate[] {
  const limit = args.limit ?? MAX_PRINCIPLES_PER_TASK;

  const all = args.store
    .all()
    .filter((m) => m.kind === 'principle' && m.lifecycle === 'active');

  const scored: PrincipleCandidate[] = [];

  for (const p of all) {
    // 匹配文本：优先用结构化的 condition，退化到 content
    const matchText = p.principle?.condition ?? p.content;
    const relates = isRelevant(args.task, matchText);
    if (!relates) continue;

    const eff = p.effectiveness;
    const applied = eff?.applied ?? 0;
    const succeeded = eff?.succeeded ?? 0;
    // 无反馈时给中性值，不让新原则一上来就被压到底
    const successRate = applied === 0 ? 0.5 : succeeded / applied;

    // 该领域的领域原则额外加权（领域原则本来就为该领域场景提炼）
    const domainBonus =
      args.servant !== undefined &&
      p.memClass === 'domain' &&
      p.owner.kind === 'servant' &&
      p.owner.servant === args.servant
        ? 0.15
        : 0;

    const relevance = Math.min(1, 0.6 + 0.25 * successRate + domainBonus);

    const why =
      applied === 0
        ? '条件与本次任务相关；尚无应用记录'
        : `条件与本次任务相关；历史应用 ${applied} 次、奏效 ${succeeded} 次` +
          (successRate < 0.5 ? '（效果不佳，排序靠后但仍保留机会）' : '');

    scored.push({ principle: p, relevance, why });
  }

  return scored
    .sort((a, b) => {
      const ea = a.principle.effectiveness;
      const eb = b.principle.effectiveness;
      const ra = ea && ea.applied > 0 ? ea.succeeded / ea.applied : 0.5;
      const rb = eb && eb.applied > 0 ? eb.succeeded / eb.applied : 0.5;
      if (rb !== ra) return rb - ra;
      return b.principle.fitness - a.principle.fitness;
    })
    .slice(0, limit);
}

// ═══════════════════════════════════════════════════════════
// 注入（applied +1）
// ═══════════════════════════════════════════════════════════

export interface PrincipleInjection {
  readonly principles: readonly PrincipleCandidate[];
}

/**
 * 记录"这些原则被注入了本次任务"。
 *
 * ⚠️ 只有真的注入进 prompt 才记 —— 否则 applied 这个数字没有意义。
 *
 * ⚠️ 计数基准必须**现取**，不能用候选里的快照：
 *    `selectPrinciples` 返回的候选携带的是**选择那一刻**的 effectiveness，
 *    若拿它来算 applied+1，第二次注入会把计数覆盖回 1（实测踩过）。
 */
export function recordInjection(args: {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  readonly taskId: string;
  readonly candidates: readonly PrincipleCandidate[];
}): void {
  for (const c of args.candidates) {
    // 现取当前值，不用候选里的旧快照
    const current = args.store.get(c.principle.id);
    if (!current) continue;

    const eff = current.effectiveness ?? { applied: 0, succeeded: 0, lastAppliedAt: 0 };
    const next = {
      applied: eff.applied + 1,
      succeeded: eff.succeeded,
      lastAppliedAt: args.clock.now(),
    };

    args.store.setEffectiveness(current.id, next);

    args.log.append({
      type: 'principle.applied',
      actor: 'butler',
      payload: {
        memoryId: current.id,
        taskId: args.taskId,
        content: current.content,
        condition: current.principle?.condition ?? null,
        action: current.principle?.action ?? null,
        memClass: current.memClass,
        appliedTotal: next.applied,
        why: c.why,
      },
      createdAt: args.clock.now(),
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 违背检测
// ═══════════════════════════════════════════════════════════

export interface PrincipleCheck {
  readonly principleId: string;
  readonly content: string;
  readonly action: string;
  /** 产出是否遵守了它 */
  readonly satisfied: boolean;
  /** 判定依据（关键词命中情况） */
  readonly evidence: string;
}

export interface PrincipleCheckReport {
  readonly checks: readonly PrincipleCheck[];
  readonly violated: readonly PrincipleCheck[];
}

/**
 * 检查仆人产出是否遵守了注入的原则。
 *
 * ⚠️ **这是确定性初筛，不是最终判定。**
 *    关键词命中只能说明"产出里提到了相关概念"，说明不了"真的做到了"。
 *    所以：
 *      · 命中 → 认为遵守（乐观，避免大量误报拖垮用户体验）
 *      · 未命中 → 报告为"疑似违背"，交由 **LLM 监督层**复核
 *
 *    这个分工与硬约束校验一致：确定性的部分用代码，
 *    需要理解力的部分交给模型，但**最终判定权在管家**。
 */
export function checkPrinciples(args: {
  readonly injected: readonly PrincipleCandidate[];
  readonly reports: readonly {
    readonly servant: string;
    readonly text: string;
  }[];
}): PrincipleCheckReport {
  const checks: PrincipleCheck[] = [];

  for (const c of args.injected) {
    const p = c.principle;
    const action = p.principle?.action ?? p.content;

    // 用动作要求里的实词去产出里找
    const hit = args.reports.some((r) => isRelevant(r.text, action));

    checks.push({
      principleId: p.id,
      content: p.content,
      action,
      satisfied: hit,
      evidence: hit
        ? '产出中提到了该原则要求的内容'
        : '产出中未见该原则要求的内容（疑似违背，交由监督层复核）',
    });
  }

  return { checks, violated: checks.filter((c) => !c.satisfied) };
}

/**
 * 记录原则违背。
 *
 * 与 `principle.effectMeasured` 配对：
 *   · 违背 → 记 `supervisor.principleViolated`，且 succeeded 不增加
 *   · 遵守 → 记 `principle.effectMeasured(effective: true)`
 */
export function recordViolation(args: {
  readonly log: EventLog;
  readonly taskId: string;
  readonly check: PrincipleCheck;
  readonly clock: ClockPort;
}): void {
  args.log.append({
    type: 'supervisor.principleViolated',
    actor: 'supervisor',
    payload: {
      memoryId: args.check.principleId,
      taskId: args.taskId,
      content: args.check.content,
      action: args.check.action,
      evidence: args.check.evidence,
      note: '关键词初筛未命中，需监督层复核后才算最终判定',
    },
    createdAt: args.clock.now(),
  });
}

/**
 * 记录原则被遵守（succeeded +1）。
 *
 * @param effective 是否奏效。用户纠正时传 false —— 那时 declined 而非 succeeded。
 */
export function recordEffect(args: {
  readonly log: EventLog;
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  readonly taskId: string;
  readonly principleId: string;
  readonly effective: boolean;
  readonly note?: string;
}): void {
  const p = args.store.get(args.principleId);
  if (!p) return;

  const eff = p.effectiveness ?? { applied: 0, succeeded: 0, lastAppliedAt: 0 };
  args.store.setEffectiveness(p.id, {
    applied: eff.applied,
    succeeded: eff.succeeded + (args.effective ? 1 : 0),
    lastAppliedAt: eff.lastAppliedAt,
  });

  args.log.append({
    type: 'principle.effectMeasured',
    actor: args.effective ? 'butler' : 'user',
    payload: {
      memoryId: p.id,
      taskId: args.taskId,
      effective: args.effective,
      note: args.note ?? null,
      applied: eff.applied,
      succeeded: eff.succeeded + (args.effective ? 1 : 0),
    },
    createdAt: args.clock.now(),
  });
}

// ═══════════════════════════════════════════════════════════
// 效果统计（供界面与成长对比）
// ═══════════════════════════════════════════════════════════

export interface PrincipleStats {
  readonly total: number;
  readonly active: number;
  readonly everApplied: number;
  /** 全局应用次数与奏效次数（界面"成长对比"用） */
  readonly applied: number;
  readonly succeeded: number;
  readonly avgSuccessRate: number;
}

export function principleStats(store: MemoryStore): PrincipleStats {
  const principles = store.all().filter((m) => m.kind === 'principle');
  const active = principles.filter((m) => m.lifecycle === 'active');
  const applied = principles.reduce((s, m) => s + (m.effectiveness?.applied ?? 0), 0);
  const succeeded = principles.reduce((s, m) => s + (m.effectiveness?.succeeded ?? 0), 0);

  return {
    total: principles.length,
    active: active.length,
    everApplied: principles.filter((m) => (m.effectiveness?.applied ?? 0) > 0).length,
    applied,
    succeeded,
    avgSuccessRate: applied === 0 ? 0 : succeeded / applied,
  };
}
