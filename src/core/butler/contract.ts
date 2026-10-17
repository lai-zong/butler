/**
 * 任务契约 —— 「管家自己干」之前先写下"要做什么"
 *
 * ★★ 这是 v7 架构改造的**核心新概念**（方案 D-5），
 *    替代旧的 `decompose()`（把任务拆成多步、每步派给一个仆人）。
 *
 * ═══ 为什么要有契约 ═══
 *
 *   旧架构靠"两个仆人互相矛盾"来发现问题。实测证明那条路走不通：
 *   唯一一次 `crossServant` 检查报的是「结论一致、无实质冲突」。
 *   原因很实际 —— 两个 Agent 都被要求"只提交发现、不做裁决"，
 *   它们会各自说得保守，**反而不冲突**。
 *
 *   契约把"对立"从**偶然**变成**必然**：
 *     · 契约是一份**成文**的东西（写下来，不是想的）
 *     · 所以它可以被**逐条核对**：你答应的做到了没
 *     · 于是"答非所问"这类错误第一次能被查出来
 *
 *   ⚠️ 一个必须说清的盲区：
 *     旧的交叉检查**查不出"答非所问"** ——
 *     两个仆人都答对了各自的题，但整体答偏了，这种错没人看得见。
 *     契约为监督员提供了**核对标准**，这个盲区才补上。
 *
 * ═══ 契约里有什么 ═══
 *
 *   ```
 *   要做什么   —— 一句话说清交付物是什么
 *   判据       —— 怎样算做好了（可逐条核对）
 *   必须遵守   —— 硬约束（过敏原这类，不可协商）
 *   涉及领域   —— 供监督员选纪律、供反思划分作用域
 *   ```
 *
 *   ⚠️ 刻意**不写"分几步、每步谁做"** —— 那是旧派发模型的东西。
 *     只有一个执行者，拆步骤没有意义（反而会让模型以为自己在指挥别人）。
 */

import { msg, type ModelMessage, type ModelPort } from '../ports/model.js';
import type { EventLog } from '../events/log.js';
import type { ScoredMemory } from '../memory/recall.js';
import { inferDomains, type DomainId } from '../domain/types.js';
import { contractSchema, type TaskContractPlan } from '../prompts/schemas.js';
import { BUTLER_SYSTEM, contractTask, PROMPT_VERSIONS } from '../prompts/butler.js';

/** 契约（内部形态，含领域标签）。 */
export interface TaskContract {
  /** 要做什么 —— 交付物是什么（一句话） */
  readonly deliverable: string;
  /** 判据 —— 怎样算做好了，逐条可核对 */
  readonly criteria: readonly string[];
  /** 必须遵守 —— 硬约束，不可协商 */
  readonly mustObey: readonly string[];
  /** 涉及领域 —— 供监督员选纪律、供反思划分作用域 */
  readonly domains: readonly DomainId[];
  /** 原始模型产出（审计用） */
  readonly raw: TaskContractPlan;
}

/** 写契约的结果。 */
export interface WriteContractResult {
  readonly contract: TaskContract;
  /** 注入给管家的约束（硬约束 + 相关软约束） */
  readonly constraints: readonly {
    readonly memoryId: string;
    readonly content: string;
    readonly source: 'global_constraint' | 'global_shared' | 'sensitive' | 'domain';
    readonly negotiable: boolean;
  }[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly promptVersion: string;
}

/**
 * 写契约。
 *
 * ★ 这一步替代了两件旧事：
 *   ① `route()`  —— 判断该派给谁（D-3 砍掉：实测 4/4 全判同一个，没信息量）
 *   ② `decompose()` —— 拆成多步派发（D-2 砍掉：只有一个执行者）
 *
 *   ★ 但它**保留了 `decompose` 里真正有价值的那部分**：
 *     按相关性筛选要注入的约束（`injectConstraints` 的逻辑）——
 *     管家自己干同样需要知道"哪些约束与这件事有关"。
 *
 * ⚠️ 领域判断：模型给的主领域 + `inferDomains` 的启发式**取并集**。
 *    理由：模型可能只报一个领域，而跨领域任务的监督需要看到全部。
 *    并集比任何一方单独更全，且都能追溯到来源。
 */
export async function writeContract(args: {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly sessionId: string;
  readonly userGoal: string;
  readonly recalled: readonly ScoredMemory[];
  readonly now: number;
  /** 对话历史（供理解跨轮指代，如「那今晚就按你说的做」）*/
  readonly history?: readonly ModelMessage[];
}): Promise<WriteContractResult> {
  const result = await args.model.completeStructured({
    purpose: 'planning',
    schema: contractSchema,
    schemaName: 'TaskContract',
    // ⚠️ 结构化调用关思考 —— 思考会吃掉 max_tokens 导致 JSON 截断
    //    （实测：1024 token + 默认思考 → 重试 3 次全截断，任务失败）
    thinking: 'disabled',
    temperature: 0,
    maxOutputTokens: 1_200,
    messages: [
      msg.system(BUTLER_SYSTEM),
      ...(args.history ?? []),
      msg.user(
        contractTask({
          userGoal: args.userGoal,
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

  // ── 领域：模型的判断 ∪ 启发式的补充 ──
  const fromModel = plan.domains.filter((d): d is DomainId => d !== 'none');
  const fromHeuristic = inferDomains(args.userGoal);
  const domains = [...new Set([...fromModel, ...fromHeuristic])];

  // ── 约束注入：硬约束无条件，其余按相关性 （保留 decompose 的这部分逻辑）──
  const constraints = args.recalled
    .filter((r) => {
      if (r.memory.memClass === 'global_constraint') return true;
      // 非硬约束：与本次目标相关才注入（relevance 由 recall 已算出）
      return r.relevance > 0;
    })
    .map((r) => {
      const isHard = r.memory.memClass === 'global_constraint';

      /**
       * ★★ 可审计：每条注入的约束都落一个事件。
       *
       * ⚠️ 这一点我第一次漏了 —— 旧 `injectConstraints` 会发 `constraint.injected`，
       *    我重写时没带上，结果 `validate:8` 报「硬约束被注入给仆人 — 0 次」。
       *
       *    ★ 为什么不能省：用户要能看到「这次任务给执行注入了哪些约束」。
       *      没有这条事件，"过敏原被考虑到了"就只是我们的说法，不是证据。
       */
      args.log.append({
        type: 'constraint.injected',
        actor: 'butler',
        payload: {
          // v7：没有"步骤"了，用 sessionId 定位这次注入
          stepId: args.sessionId,
          domains,
          memoryId: r.memory.id,
          content: r.memory.content,
          source: r.memory.memClass,
          negotiable: !isHard,
          reason: isHard ? '硬约束无条件注入' : '与本次目标相关',
        },
        createdAt: args.now,
      });

      return {
        memoryId: r.memory.id,
        content: r.memory.content,
        source: r.memory.memClass,
        negotiable: !isHard,
      };
    });

  // ★ 必须落事件 —— 契约是监督员核对的**唯一标准**，它本身要可审计
  args.log.append({
    type: 'contract.written',
    actor: 'butler',
    payload: {
      sessionId: args.sessionId,
      deliverable: plan.deliverable,
      criteria: plan.criteria,
      mustObey: plan.mustObey,
      domains,
      domainsFromModel: fromModel,
      domainsFromHeuristic: fromHeuristic,
      injectedConstraints: constraints.length,
      promptVersion: PROMPT_VERSIONS.contractTask,
      usage: result.usage,
    },
    createdAt: args.now,
  });

  return {
    contract: {
      deliverable: plan.deliverable,
      criteria: plan.criteria,
      mustObey: plan.mustObey,
      domains,
      raw: plan,
    },
    constraints,
    usage: result.usage,
    promptVersion: PROMPT_VERSIONS.contractTask,
  };
}

/**
 * 把契约渲染成**给监督员看的核对清单**。
 *
 * ★ 为什么要单独一个渲染函数：
 *   监督员的提示词里必须看到契约的**原文条目**，而不是一句"按契约核对" ——
 *   否则它没有可依据的标准，只能凭感觉评价（那正是旧 `supervise()` 的问题）。
 */
export function renderContractForReview(contract: TaskContract): string {
  const lines: string[] = [];
  lines.push('## 交付物（必须给出）');
  lines.push(contract.deliverable);
  lines.push('');
  lines.push('## 判据（逐条核对，未满足的要指名）');
  contract.criteria.forEach((c, i) => {
    lines.push(`${i + 1}. ${c}`);
  });
  if (contract.mustObey.length > 0) {
    lines.push('');
    lines.push('## 必须遵守（硬约束，违反即不合格）');
    contract.mustObey.forEach((c, i) => {
      lines.push(`${i + 1}. ${c}`);
    });
  }
  return lines.join('\n');
}
