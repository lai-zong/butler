/**
 * 敏感域自主授权 —— 由管家自己判断"这一轮要不要读"
 *
 * 设计依据：用户确认的自主化策略（2026-11-11）
 *   「记忆完全由 AI 自主完成、自主授权；用户可以删除，但不参与决定。」
 *
 * ★ 要解决的具体问题（实测）：
 *   敏感域的读取规则是「必须先有未过期的任务授权」（`canRead`）。
 *   而授权的唯一来源是 `/api/memory/grant` —— 界面上**一次都没调用过**，
 *   手动审核与手动裁决接口也已经返回 410。
 *   于是：敏感域记忆对管家**永久不可读** —— 存得下、读不回。
 *
 * ★ 为什么不是"敏感域直接对管家放开"：
 *   产品判断（D-8）：隔离的对象从来不是"哪个执行者"，而是
 *   **"哪类任务该加载哪些记忆"** —— 心理记录不该出现在买菜建议的上下文里。
 *   所以自动放开必须带相关性门槛，而不是一律可见。
 *
 * ★ 判定方式：**内容相关性 + 名额上限 + 短 TTL**，全部在记忆层内完成
 *   （相似度计算不把内容送出本模块）：
 *     · 与当前用户消息的相似度低于门槛 → 不授权；
 *     · 每轮最多放开 N 条（按相似度排序）；
 *     · 授权绑定当前会话（taskId = sessionId），到期自动失效；
 *     · 每次授权都落 `grant.requested` / `grant.approved` 事件，可审计。
 *
 * ⚠️ 确定性：时间是注入的 `ClockPort`，不读 `Date.now()`；相似度是纯函数。
 */

import type { ClockPort } from '../ports/clock.js';
import type { MemoryStore } from './store.js';
import { similarity } from './sink.js';
import type { MemoryEntry } from './types.js';

export interface AutonomousAccessPolicy {
  /** 总开关。关掉后敏感域对管家完全不可见（回到手动授权时代的实际效果）。 */
  readonly enabled: boolean;
  /**
   * 语义门槛（余弦相似度，0—1）。有语义分时用它。
   *
   * 0.55 是保守取值：宁可漏放开（这轮读不到），也不要在无关任务里
   * 带出敏感内容。漏掉的代价是"这次没用上"，误放是"隐私进了不该进的上下文"。
   */
  readonly semanticFloor: number;
  /**
   * 没有语义分时的字面门槛（2-gram 相似度）。
   *
   * ⚠️ 为什么门槛更高：字面相似度对"同话题不同问法"极不敏感 ——
   *    "我下周要上台演讲很紧张" 与 "心理咨询：公开演讲焦虑" 只有 0.08。
   *    所以字面模式只在**近乎同句**时才放开（0.5），
   *    真实场景应配置本地嵌入模型（项目自带 BGE），走语义门槛。
   */
  readonly literalFloor: number;
  /** 每轮最多放开几条。防止一次性把敏感域全量拉进上下文。 */
  readonly maxPerTurn: number;
  /** 授权有效期（毫秒）。短 TTL 是"按任务失效"的兜底。 */
  readonly ttlMs: number;
}

/** 默认策略。 */
export const DEFAULT_AUTONOMOUS_ACCESS: AutonomousAccessPolicy = {
  enabled: true,
  semanticFloor: 0.55,
  literalFloor: 0.5,
  maxPerTurn: 3,
  ttlMs: 5 * 60 * 1000,
};

export interface AutonomousGrant {
  readonly memoryId: string;
  readonly similarity: number;
}

export interface AutonomousAccessOutcome {
  readonly granted: readonly AutonomousGrant[];
  /** 被跳过的原因（供测试与诊断；不写事件，避免噪音） */
  readonly skipped: readonly { readonly memoryId: string; readonly reason: string }[];
}

/** 该记忆是否已经有本会话的有效授权（避免每轮重复签发）。 */
function hasLiveGrant(entry: MemoryEntry, sessionId: string, now: number): boolean {
  return (entry.grants ?? []).some((g) => g.taskId === sessionId && g.expiresAt > now);
}

/**
 * 为一轮对话按相关性自主放开敏感域记忆。
 *
 * @param scores 语义分（记忆 id → 余弦相似度）。没有时退回字面匹配。
 * @returns 本轮新签发的授权（已过期/已存在的不会重复签发）
 */
export function unlockSensitiveForTurn(args: {
  readonly store: MemoryStore;
  readonly clock: ClockPort;
  readonly userId: string;
  readonly sessionId: string;
  readonly query: string;
  readonly scores?: ReadonlyMap<string, number>;
  readonly policy?: Partial<AutonomousAccessPolicy>;
}): AutonomousAccessOutcome {
  const policy: AutonomousAccessPolicy = { ...DEFAULT_AUTONOMOUS_ACCESS, ...args.policy };
  const skipped: { memoryId: string; reason: string }[] = [];
  if (!policy.enabled) return { granted: [], skipped };

  const query = args.query.trim();
  if (query.length === 0) return { granted: [], skipped };

  const now = args.clock.now();
  const candidates: { entry: MemoryEntry; score: number }[] = [];

  for (const entry of args.store.all()) {
    if (entry.memClass !== 'sensitive') continue;
    // 归档（含被遗忘的）不参与：那是"已经退出使用"的记忆
    if (entry.lifecycle === 'archived') continue;
    if (hasLiveGrant(entry, args.sessionId, now)) {
      skipped.push({ memoryId: entry.id, reason: 'already_granted' });
      continue;
    }

    // ★ 有语义分就用语义分（语义阈值），没有才退回字面（更高的字面阈值）。
    const semantic = args.scores?.get(entry.id);
    const score = semantic !== undefined ? semantic : similarity(query, entry.content);
    const floor = semantic !== undefined ? policy.semanticFloor : policy.literalFloor;
    if (score < floor) {
      skipped.push({ memoryId: entry.id, reason: 'below_floor' });
      continue;
    }
    candidates.push({ entry, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const picked = candidates.slice(0, policy.maxPerTurn);
  for (const rest of candidates.slice(policy.maxPerTurn)) {
    skipped.push({ memoryId: rest.entry.id, reason: 'over_turn_limit' });
  }

  const granted: AutonomousGrant[] = [];
  for (const { entry, score } of picked) {
    const res = args.store.grant({
      // ★ 由管家自己签发：actor 是 butler，不是 user —— 审计里能区分
      actor: { kind: 'butler', userId: args.userId },
      memoryId: entry.id,
      to: entry.domain ?? 'life',
      taskId: args.sessionId,
      purpose: `自主授权：本轮对话与该条相关（相似度 ${score.toFixed(2)}），${Math.round(
        policy.ttlMs / 60_000,
      )} 分钟后自动失效；用户可随时删除该记忆`,
      ttlMs: policy.ttlMs,
    });
    if (res.ok) granted.push({ memoryId: entry.id, similarity: Number(score.toFixed(3)) });
    else skipped.push({ memoryId: entry.id, reason: res.reason ?? 'grant_failed' });
  }

  return { granted, skipped };
}
