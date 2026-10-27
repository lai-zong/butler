/**
 * 日记模型输出 schema。
 *
 * 一次调用同时产出「日记」和「候选记忆」；不做两段式总结。
 */

import { z } from 'zod';

export const diarySchema = z.object({
  diary: z
    .string()
    .min(1)
    .max(6000)
    .describe('当天经历的连贯叙述。只写实际发生的事，不写领域口号。'),
  items: z
    .array(
      z.object({
        kind: z
          .enum(['fact', 'preference', 'principle'])
          .describe('fact=可验证事实；preference=稳定偏好；principle=可复用行为原则'),
        stability: z
          .enum(['stable', 'temporary', 'unknown'])
          .optional()
          .describe('stable=长期稳定属性；temporary=只对本次任务有效；unknown=无法判断'),
        content: z.string().min(1).max(600),
        confidence: z.number().min(0).max(1),
        evidence: z
          .array(z.string().min(1))
          .min(1)
          .max(12)
          .describe('必须引用输入消息中的 [msg:...] id'),
        rationale: z.string().max(500).optional(),
        principleCondition: z.string().max(300).optional(),
        principleAction: z.string().max(300).optional(),
      }),
    )
    .max(8)
    .describe('只提取少量真正有长期价值的条目；没有就返回空数组。'),
});

export type DiaryModelOutput = z.infer<typeof diarySchema>;
