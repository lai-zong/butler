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
- 它是否包含用户明确说过的偏好、事实、限制或长期目标，并且与当前请求直接相关？
- 只是主题相近、但不会影响本次回答或行动的记忆，应给低分。
- 信息不足、语义模糊、需要猜测才能关联的记忆，应给低分；宁可漏掉，不要放大噪声。

打分建议（必须按此量级，不要全部给高分）：
- 0.8—1.0：直接改变本次建议/约束/执行方式；
- 0.5—0.7：明确相关，但只是补充背景；
- 0.2—0.4：主题相近，不能确定会改变行动；
- 0.0—0.1：无关。

所有候选都必须出现一次；硬约束必须排在最前；不相关的给低分。`;

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
  /**
   * 是否按模型分数**过滤**候选，而不只是排序。
   *
   * ⚠️ 默认 false：保持旧调用方的“只排序、不丢记忆”语义。
   *    生产聊天与 top-k 实验显式传 true；没有精排时绝不能靠它兜底。
   */
  readonly filter?: boolean;
  /** 过滤阈值；只在 filter=true 时生效。 */
  readonly minRelevance?: number;
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
  const scoreById = new Map<string, number>();
  const ranked: ScoredMemory[] = [];
  const seen = new Set<string>();
  for (const item of raw.items) {
    if (seen.has(item.id)) continue;
    const candidate = byId.get(item.id);
    if (candidate === undefined) continue; // 模型编造的 id 不接受
    seen.add(item.id);
    scoreById.set(item.id, item.relevance);
    ranked.push(candidate);
  }

  /**
   * 没有任何有效 id：这是模型输出不可信，不是“全部不相关”。
   * 如实回退原顺序，让调用方走无精排路径，而不是把记忆全删掉。
   */
  if (ranked.length === 0) {
    return {
      items: args.candidates,
      used: false,
      fallbackReason: '精排未返回任何有效候选 id',
      usage,
      latencyMs: Date.now() - started,
    };
  }

  // 模型漏掉的候选：只在“只排序”语义下追加到末尾；过滤模式不保留未评分项。
  const missing = args.candidates.filter((c) => !seen.has(c.memory.id));
  if (args.filter !== true) {
    ranked.push(...missing);
  }

  /**
   * 硬约束必须最前，且不参与模型排序。
   *
   * ⚠️ 过滤模式下即使模型漏掉了硬约束，也必须从**原始候选**里带回来：
   *    模型漏项是模型的问题，不是“这条约束不相关”的证据。
   */
  const hard =
    args.filter === true
      ? args.candidates.filter((c) => c.memory.memClass === 'global_constraint')
      : ranked.filter((c) => c.memory.memClass === 'global_constraint');
  let soft = ranked.filter((c) => c.memory.memClass !== 'global_constraint');

  if (args.filter === true) {
    const min = Math.min(1, Math.max(0, args.minRelevance ?? 0.5));
    soft = soft
      .filter((c) => (scoreById.get(c.memory.id) ?? 0) >= min)
      .sort(
        (a, b) =>
          (scoreById.get(b.memory.id) ?? 0) - (scoreById.get(a.memory.id) ?? 0) ||
          a.memory.id.localeCompare(b.memory.id),
      );
  }

  return {
    items: [...hard, ...soft],
    used: true,
    fallbackReason: null,
    usage,
    latencyMs: Date.now() - started,
  };
}
