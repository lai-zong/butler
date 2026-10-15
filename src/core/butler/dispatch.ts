/**
 * 管家 · 任务分解与约束注入
 *
 * 设计依据：方案 § 2.2① ② 、§ 2.2⑥（约束注入可见）
 */

import { EventLog } from '../events/log.js';
import { msg, type ModelMessage, type ModelPort } from '../ports/model.js';
import { BUTLER_SYSTEM, dispatchTask, PROMPT_VERSIONS } from '../prompts/butler.js';
import { dispatchPlanSchema, type DispatchPlan } from '../prompts/schemas.js';
import type { Dispatch, DispatchStep, InjectedConstraint } from '../servants/types.js';
import type { ScoredMemory } from '../memory/recall.js';
import { isRelevant } from '../text/keywords.js';

/**
 * ⚠️ 原先这里自己定义了一个 `RecallResult`，与 `memory/recall.ts` 里的
 *    同名类型**撞名**，而且两处标注都不对 ——
 *    实际用法是 `r.memory` / `r.relevance`，那是 `ScoredMemory`。
 *
 *    现在统一用 `recall.ts` 的 `ScoredMemory`：
 *    召回的打分结果本来就只有一种形状，定义两份必然漂移。
 */

/**
 * 约束注入（方案 § 2.2⑥ 第 ③ 步）
 *
 * **仆人不是"读到了全局记忆"，而是管家按任务相关性注入了必要约束。**
 * 这既保证安全（硬约束一定送达），又避免仆人被无关信息干扰。
 *
 * 注入规则（两条，缺一不可）：
 *   ① **硬约束无条件注入** —— 安全不能靠相关性判断来省
 *   ② 其余约束**按与本次子任务指令的相关性**注入 ——
 *      既省 token，也避免让"时间安排"步骤去操心"3 公里内的餐厅"
 *
 * 注入过程本身可审计 —— 会写 constraint.injected 事件。
 */
export function injectConstraints(args: {
  readonly log: EventLog;
  readonly stepId: string;
  readonly servant: string;
  /** 本步骤的指令，用于相关性判定 */
  readonly instruction: string;
  readonly recalled: readonly ScoredMemory[];
  readonly now: number;
}): readonly InjectedConstraint[] {
  const injected: InjectedConstraint[] = [];

  // 管家自己执行的步骤（汇总类）不需要注入 ——
  // 它本来就持有全局记忆，注入只会产生重复事件、污染审计视图。
  if (args.servant === 'butler') return injected;

  for (const r of args.recalled) {
    const m = r.memory;
    const isHardConstraint = m.memClass === 'global_constraint';

    // ① 硬约束无条件送达
    // ② 软约束需同时满足"召回相关性达标"与"与本次指令相关"
    if (!isHardConstraint) {
      if (r.relevance < 0.5) continue;
      if (!isRelevant(args.instruction, m.content)) continue;
    }

    injected.push({
      memoryId: m.id,
      content: m.content,
      source: m.memClass,
      // 硬约束不可协商；其余冲突时上报用户裁决
      negotiable: !isHardConstraint,
    });

    // ★ 可审计：用户能看到"本次任务给这个仆人注入了哪些约束"
    args.log.append({
      type: 'constraint.injected',
      actor: 'butler',
      payload: {
        stepId: args.stepId,
        servant: args.servant,
        memoryId: m.id,
        content: m.content,
        source: m.memClass,
        negotiable: !isHardConstraint,
        reason: isHardConstraint ? '硬约束无条件注入' : '与本次指令相关',
      },
      createdAt: args.now,
    });
  }

  return injected;
}

export async function decompose(args: {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly sessionId: string;
  readonly userGoal: string;
  readonly primaryServant: string;
  readonly recalled: readonly ScoredMemory[];
  readonly now: number;
  /** 对话历史（供理解跨轮指代，如「那今晚就按你说的做」）*/
  readonly history?: readonly ModelMessage[];
}): Promise<{ readonly dispatch: Dispatch; readonly plan: DispatchPlan; readonly promptVersion: string }> {
  const result = await args.model.completeStructured({
    purpose: 'planning',
    schema: dispatchPlanSchema,
    schemaName: 'DispatchPlan',
    temperature: 0,
    maxOutputTokens: 1024,
    messages: [
      msg.system(BUTLER_SYSTEM),
      ...(args.history ?? []),
      msg.user(
        dispatchTask({
          userGoal: args.userGoal,
          primaryServant: args.primaryServant,
          recalledMemories: args.recalled.map((r) => ({
            id: r.memory.id,
            content: r.memory.content,
            memClass: r.memory.memClass,
          })),
        }),
      ),
    ],
  });

  const plan = result.value;

  // 校验依赖引用：dependsOn 必须指向本计划内已声明的 stepId
  const known = new Set(plan.steps.map((s) => s.stepId));
  for (const s of plan.steps) {
    for (const dep of s.dependsOn) {
      if (!known.has(dep)) {
        throw new Error(
          `任务分解不合法：步骤 ${s.stepId} 依赖了不存在的 ${dep}。` +
            `已知步骤：${[...known].join(', ')}`,
        );
      }
      if (dep === s.stepId) {
        throw new Error(`任务分解不合法：步骤 ${s.stepId} 依赖了自己`);
      }
    }
  }

  const steps: DispatchStep[] = plan.steps.map((s) => {
    const injected = injectConstraints({
      log: args.log,
      stepId: s.stepId,
      servant: s.servant,
      instruction: s.instruction,
      recalled: args.recalled,
      now: args.now,
    });
    return {
      stepId: s.stepId,
      servant: s.servant as DispatchStep['servant'],
      instruction: s.instruction,
      dependsOn: s.dependsOn,
      status: 'pending',
      injectedConstraints: injected,
    };
  });

  const dispatch: Dispatch = {
    id: `dsp_${args.sessionId}_${args.now.toString(36)}`,
    sessionId: args.sessionId,
    goal: args.userGoal,
    decomposition: steps,
    routingConfidence: 1,
    createdAt: args.now,
  };

  args.log.append({
    type: 'dispatch.created',
    actor: 'butler',
    payload: {
      dispatchId: dispatch.id,
      goal: args.userGoal,
      steps: steps.map((s) => ({
        stepId: s.stepId,
        servant: s.servant,
        instruction: s.instruction,
        dependsOn: s.dependsOn,
        injectedCount: s.injectedConstraints.length,
      })),
      reasoning: plan.reasoning,
      promptVersion: PROMPT_VERSIONS.dispatchTask,
    },
    createdAt: args.now,
  });

  return { dispatch, plan, promptVersion: PROMPT_VERSIONS.dispatchTask };
}
