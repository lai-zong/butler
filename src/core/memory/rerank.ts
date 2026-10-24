/**
 * 语义召回第二阶段：LLM 精排。
 *
 * 只对已召回的少量候选排序，不重新扫全库：
 *   · 输入：query + recall 选出的候选（含硬约束）
 *   · 输出：候选 id 的相关性排序
 *
 * ⚠️ fail-open：模型失败、输出不合规、超时都保持原顺序。
 *    硬约束不交给模型排序 —— 它们由 recall 无条件带回，精排只处理非硬约束。
 */

import { z } from 'zod';

import { msg, type ModelPort, type ModelUsage } from '../ports/model.js';
import type { ScoredMemory } from './recall.js';

const rerankSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        relevance: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(20),
});

export interface RerankResult {
  readonly items: readonly ScoredMemory[];
  readonly used: boolean;
  /** 模型失败/未调用时的可读原因；成功时为 null */
  readonly fallbackReason: string | null;
  /** 实际模型调用的用量；未调用/失败时为 null */
  readonly usage: ModelUsage | null;
  /** 精排调用耗时（毫秒）；未调用时为 0 */
  readonly latencyMs: number;
}

const SYSTEM = `你是记忆召回的精排器。只做一件事：判断候选记忆与用户查询的相关性。
不要执行查询、不要回答用户、不要编造候选。只输出 JSON：
{"items":[{"id":"候选id","relevance":0到1之间的小数}]}

判断标准不是“文字相似”，而是：
- 这条记忆是否会改变给用户的建议、约束或执行方式？
- 只有查询明确涉及健康目标、禁忌或身体限制时，才把安全/健康约束排在口味偏好之前；
- 如果查询中的具体食物/活动与某条健康约束直接冲突（例如火锅高油 vs 减脂控油），即使没有明说“减脂”，也优先该健康约束；
- 泛泛推荐餐厅/口味时，不要用减脂记忆压过用户明确的口味偏好。
所有候选都必须出现一次；硬约束必须排在最前；不相关的可以给低分。`;

function promptFor(query: string, candidates: readonly ScoredMemory[]): string {
  const rows = candidates.map((c, i) => {
    const hard = c.memory.memClass === 'global_constraint' ? ' [硬约束]' : '';
    const content = c.memory.content.replace(/\s+/g, ' ').slice(0, 240);
    return `${i + 1}. id=${c.memory.id}${hard}\n   内容：${content}`;
  });
  return `用户查询：${query}\n\n候选记忆：\n${rows.join('\n')}\n\n输出 JSON。`;
}

export async function rerankRecall(args: {
  readonly model: ModelPort;
  readonly query: string;
  readonly candidates: readonly ScoredMemory[];
}): Promise<RerankResult> {
  if (args.candidates.length <= 1) {
    return {
      items: args.candidates,
      used: false,
      fallbackReason: null,
      usage: null,
      latencyMs: 0,
    };
  }

  const started = Date.now();
  let raw: z.infer<typeof rerankSchema>;
  let usage: ModelUsage | null = null;
  try {
    const res = await args.model.completeStructured({
      purpose: 'routing',
      schema: rerankSchema,
      schemaName: 'MemoryRerank',
      thinking: 'disabled',
      temperature: 0,
      maxOutputTokens: 800,
      messages: [msg.system(SYSTEM), msg.user(promptFor(args.query, args.candidates))],
    });
    raw = res.value;
    usage = res.usage;
  } catch (err) {
    return {
      items: args.candidates,
      used: false,
      fallbackReason: err instanceof Error ? err.message : String(err),
      usage: null,
      latencyMs: Date.now() - started,
    };
  }

  const byId = new Map(args.candidates.map((c) => [c.memory.id, c]));
  const ranked: ScoredMemory[] = [];
  const seen = new Set<string>();
  for (const item of raw.items) {
    if (seen.has(item.id)) continue;
    const candidate = byId.get(item.id);
    if (candidate === undefined) continue; // 模型编造的 id 不接受
    seen.add(item.id);
    ranked.push(candidate);
  }

  // 模型漏掉的候选保留在原顺序的末尾，不丢记忆。
  for (const c of args.candidates) {
    if (!seen.has(c.memory.id)) ranked.push(c);
  }

  // 硬约束必须最前，且不参与模型排序。
  const hard = ranked.filter((c) => c.memory.memClass === 'global_constraint');
  const soft = ranked.filter((c) => c.memory.memClass !== 'global_constraint');
  return {
    items: [...hard, ...soft],
    used: true,
    fallbackReason: null,
    usage,
    latencyMs: Date.now() - started,
  };
}
