/**
 * plan_task —— 由模型决定是否写任务契约。
 *
 * 它不是意图分类器，也不是用户开关：
 *   · 闲聊/简单只读可以直接回答；
 *   · 需要修改文件、执行命令、多步任务时，模型调用它；
 *   · 有副作用的工具由 ToolFramework 的 planGuard 拦住，直到契约存在。
 */

import { contractSchema } from '../../prompts/schemas.js';
import type { TaskContract } from '../../butler/contract.js';
import type { DomainId } from '../../domain/types.js';
import { ToolError, type ToolSpec } from '../types.js';

export interface TaskPlanState {
  contract: TaskContract | null;
}

export function createTaskPlanState(): TaskPlanState {
  return { contract: null };
}

const DOMAINS = ['life', 'health', 'study', 'work', 'code', 'none'] as const;

export function planTaskTool(state: TaskPlanState): ToolSpec {
  return {
    name: 'plan_task',
    description:
      '在需要修改文件、执行命令、生成交付物或完成多步任务前调用。' +
      '闲聊、简单问答和只读查询不要调用。调用后得到任务契约，后续有副作用的工具才允许执行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deliverable: {
          type: 'string',
          description: '一句话说清最终交付物。不要写过程，写结果。',
        },
        criteria: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: { type: 'string' },
          description: '怎样算完成；每条都应能逐条核对。',
        },
        mustObey: {
          type: 'array',
          maxItems: 6,
          items: { type: 'string' },
          description: '必须遵守的硬约束；没有就填空数组。',
        },
        domains: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', enum: [...DOMAINS] },
          description: '涉及领域；判不出填 none。',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '对理解用户目标的置信度。',
        },
        clarifyingQuestion: {
          type: 'string',
          description: '可选：置信度低时想向用户确认的问题。',
        },
      },
      required: ['deliverable', 'criteria', 'mustObey', 'domains', 'confidence'],
    },
    tier: 'readOnly',
    summarize: () => '写任务契约',
    async execute(args) {
      const parsed = contractSchema.safeParse(args);
      if (!parsed.success) {
        throw new ToolError(
          `任务契约参数不合法：${parsed.error.issues[0]?.message ?? '参数错误'}`,
          'invalid_args',
        );
      }
      const plan = parsed.data;
      const contract: TaskContract = {
        deliverable: plan.deliverable,
        criteria: plan.criteria,
        mustObey: plan.mustObey,
        domains: plan.domains.filter((d): d is DomainId => d !== 'none'),
        confidence: plan.confidence,
        ...(plan.clarifyingQuestion !== undefined
          ? { clarifyingQuestion: plan.clarifyingQuestion }
          : {}),
        raw: plan,
      };
      state.contract = contract;
      return {
        ok: true,
        output: `任务契约已记录。交付物：${contract.deliverable}`,
        data: {
          deliverable: contract.deliverable,
          criteria: contract.criteria,
          mustObey: contract.mustObey,
          domains: contract.domains,
          confidence: contract.confidence,
        },
        durationMs: 0,
      };
    },
  };
}
