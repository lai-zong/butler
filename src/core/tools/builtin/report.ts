/**
 * 内置工具 · 提交结构化汇报
 *
 * 设计依据：方案 § 2.2②（仆人汇报）
 *
 * ★ 为什么把"汇报"做成一个工具：
 *   仆人现在既能调工具、又要交结构化汇报。如果让模型用自由文本兼顾两件事，
 *   它很容易在工具调用中间写一段散文，导致结构化解析失败。
 *
 *   做成工具之后流程变得确定：
 *     调工具 → 看结果 → 再调工具 → … → **调用 submit_report 结束**。
 *   循环以"模型调用了这个工具"作为终止信号，汇报内容天然是结构化的。
 *
 *   `tier: readOnly` —— 提交汇报不产生任何外部副作用。
 */

import { servantReportSchema } from '../../prompts/schemas.js';
import type { ToolSpec } from '../types.js';

export function submitReportTool(): ToolSpec {
  return {
    name: 'submit_report',
    description:
      '提交你的最终汇报并结束本次任务。**这是你完成任务的方式** —— ' +
      '不要用普通文本回答，而要调用这个工具提交结构化汇报。调用后本次任务即结束。',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['done', 'failed', 'blocked'],
          description: '完成填 done；无法完成填 failed；被约束卡住填 blocked',
        },
        artifacts: {
          type: 'array',
          description:
            '你的产出物。必须给**可核对的实质内容** —— 菜单要列具体菜名与配料，' +
            '清单要列具体条目与数量。只写标题、不写内容等于没做。',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['text', 'list', 'plan'] },
              content: { type: 'string', description: '内容；list/plan 用换行分隔条目' },
            },
            required: ['kind', 'content'],
          },
        },
        uncertainties: {
          type: 'array',
          items: { type: 'string' },
          description: '你确实不确定的地方。**如实填写比编一个完整答案更有价值。**',
        },
        findings: {
          type: 'array',
          description:
            '你发现的、需要管家知道的事。**只陈述发现与证据，不要做裁决** —— ' +
            '判定与拦截由管家的校验层负责，你没有否决权。',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['constraintRef', 'risk', 'alternative'],
                description: 'constraintRef=指向某条约束；risk=风险提示；alternative=备选方案',
              },
              statement: { type: 'string', description: '一句话说清发现了什么' },
              evidence: { type: 'array', items: { type: 'string' }, description: '支撑证据' },
              constraintRef: { type: 'string', description: '当 kind=constraintRef 时指向约束' },
            },
            required: ['kind', 'statement'],
          },
        },
        needsButlerDecision: {
          type: 'string',
          description: '需要管家裁决的问题（可选）',
        },
      },
      required: ['status', 'artifacts', 'uncertainties', 'findings'],
    },
    tier: 'readOnly',
    summarize: (args) => {
      const a = args as { status?: unknown; artifacts?: unknown };
      const n = Array.isArray(a?.artifacts) ? a.artifacts.length : 0;
      return `提交汇报（状态 ${String(a?.status ?? '?')}，${n} 项产出）`;
    },
    async execute(args, ctx) {
      const started = ctx.clock.now();
      const parsed = servantReportSchema.safeParse(args);

      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        return {
          ok: false,
          output: `汇报格式不合规：${issues}\n请修正后重新调用 submit_report。`,
          isError: true,
          durationMs: ctx.clock.now() - started,
        };
      }

      return {
        ok: true,
        output: '汇报已提交，本次任务结束。',
        data: parsed.data,
        durationMs: ctx.clock.now() - started,
      };
    },
  };
}

/** 从工具调用轨迹里取出最后一份成功的汇报。 */
export function extractReport(
  traces: readonly {
    readonly toolName: string;
    readonly ok: boolean;
    readonly args: unknown;
  }[],
): unknown | undefined {
  // 取**最后一次**成功的 submit_report —— 模型可能先提交过一份不合规的
  for (let i = traces.length - 1; i >= 0; i--) {
    const t = traces[i];
    if (t && t.toolName === 'submit_report' && t.ok) return t.args;
  }
  return undefined;
}
