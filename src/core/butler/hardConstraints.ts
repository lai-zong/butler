/**
 * 管家 · 硬约束机械校验（确定性，不依赖模型）
 *
 * 设计依据：方案 § 2.1
 *
 * > "硬约束的拦截**不是某个仆人的权力**，而是**管家对全局层第 1 类记忆的机械校验**。"
 *
 * 这条设计说明要求：硬约束的判定**必须是确定性代码**，不能交给 LLM 的严重性判断。
 *
 * 实测教训（验证 1）：场景是"花生严重过敏"，health 仆人正确识别了交叉污染风险，
 * 但把 severity 判成了 `info`，于是 supervisor 只提示不拦截。
 * 若真按此执行，用户可能吃到交叉污染的食物。
 * **这就是"把安全判定交给模型"的典型失败模式。**
 *
 * 因此这里做两层：
 *   ① 确定性校验（本文件）—— 硬约束是否被每个产出方处理过，纯代码判定
 *   ② LLM 监督（supervisor.ts）—— 负责软约束、跨领域矛盾等需要理解力的判断
 */

import type { EventLog } from '../events/log.js';
import { coreOf, hasAnyNgram } from '../text/keywords.js';
import type { ScoredMemory } from '../memory/recall.js';
import type { ExecutionReport } from '../execution/types.js';

export interface HardConstraintVerdict {
  readonly constraintId: string;
  readonly content: string;
  /** 该约束是否被每个产出方都处理过 */
  readonly satisfied: boolean;
  /** 哪些仆人没有处理它 */
  readonly unhandledBy: readonly string[];
}

export interface HardConstraintReport {
  readonly verdicts: readonly HardConstraintVerdict[];
  /** 存在未处理的硬约束 → 必须拦截 */
  readonly mustBlock: boolean;
}

/**
 * 判断某个仆人的产出是否"处理过"某条硬约束。
 *
 * 判定规则刻意保守但可解释：
 *   ① 提交了指向该约束的 finding（kind=constraintRef）→ 已处理
 *   ② 产出物文本中提到了约束的实词片段 → 已处理
 *
 * 这是启发式，目标是**抓住"完全没提"的情况**，而不是做精确的语义匹配。
 * 方向性取舍：宁可漏报（交由 LLM 监督补位），也不误伤（把正常产出拦下来）。
 */
function handledBy(report: ExecutionReport, constraintContent: string, constraintId: string): boolean {
  // ① finding 明确指向该约束
  const refsIt = (report.findings ?? []).some(
    (f) =>
      f.kind === 'constraintRef' &&
      (f.constraintRef === constraintId || mentions(f.statement, constraintContent)),
  );
  if (refsIt) return true;

  // ② 产出物中提到了相关关键词
  const haystack = report.artifacts
    .map((a) => (Array.isArray(a.content) ? a.content.join('\n') : String(a.content)))
    .join('\n');
  return mentions(haystack, constraintContent);
}

/**
 * 文本是否提到约束内容。
 *
 * 做法：把约束剥虚词、去标点后得到核心串，
 * 检查它**任意一个长度 ≥2 的连续片段**是否出现在文本中。
 *
 * 例：「你对花生严重过敏」→ 核心串「花生过敏」
 *      → 候选片段 {花生, 花生过, 花生过敏, 生过, 生过敏, 过敏}
 *      → 产出里出现「花生」即命中。
 *
 * 不再按固定 2-gram 切分 —— 那会切出「生过」这种跨词边界的片段，
 * 容易被"产生过敏反应"之类的无关文本误命中（实测踩过这个坑）。
 */
function mentions(text: string, constraint: string): boolean {
  const core = coreOf(constraint);
  if (core.length < 2) return true; // 提不出实词 → 不拦，避免误伤
  return hasAnyNgram(text, core, 2);
}

/**
 * 从约束文本提取候选片段（供日志与调试展示）。
 *
 * ⚠️ 与实际判定逻辑（`mentions`）不同：这里给的是**可读的候选项**。
 */
export function extractKeywords(constraint: string): readonly string[] {
  const core = coreOf(constraint);
  if (core.length < 2) return [];
  const out = new Set<string>();
  for (let len = core.length; len >= 2; len--) {
    for (let i = 0; i + len <= core.length; i++) out.add(core.slice(i, i + len));
  }
  return [...out];
}

/**
 * 对全部产出方逐条校验硬约束。
 *
 * @param hardConstraints 来自全局层的 global_constraint 类记忆
 * @param reports         本次所有仆人的汇报
 */
export function verifyHardConstraints(args: {
  readonly log: EventLog;
  readonly hardConstraints: readonly ScoredMemory[];
  readonly reports: readonly ExecutionReport[];
  readonly now: number;
}): HardConstraintReport {
  const verdicts: HardConstraintVerdict[] = [];

  for (const hc of args.hardConstraints) {
    const unhandledBy: string[] = [];
    for (const rep of args.reports) {
      // 状态为 failed 的仆人没有产出，不算"未处理"
      if (rep.status === 'failed') continue;
      if (!handledBy(rep, hc.memory.content, hc.memory.id)) unhandledBy.push(rep.domain ?? '未标注领域');
    }

    const satisfied = unhandledBy.length === 0;
    verdicts.push({
      constraintId: hc.memory.id,
      content: hc.memory.content,
      satisfied,
      unhandledBy,
    });

    // ★ 机械拦截：确定性判定，不看模型怎么想
    if (!satisfied) {
      args.log.append({
        type: 'constraint.hardBlocked',
        actor: 'supervisor',
        payload: {
          constraintId: hc.memory.id,
          content: hc.memory.content,
          unhandledBy,
          reason: `该硬约束未被处理：${unhandledBy.join(', ')}`,
          deterministic: true,
          note: '机械校验判定，非模型裁决',
        },
        createdAt: args.now,
      });
    }
  }

  return {
    verdicts,
    mustBlock: verdicts.some((v) => !v.satisfied),
  };
}
