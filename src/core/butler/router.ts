/**
 * 管家 · 路由
 *
 * 设计依据：方案 § 2.2① 路由与任务分解
 *
 * 关键纪律：**置信度不足时不猜测，转入澄清提问。**
 * 这是多 Agent 系统第一大故障（路由错配）的第一道防线。
 */

import { msg, type ModelMessage, type ModelPort } from '../ports/model.js';
import { routingConfig } from '../config/env.js';
import { BUTLER_SYSTEM, PROMPT_VERSIONS, routerTask } from '../prompts/butler.js';
import { routingSchema, type RoutingDecision } from '../prompts/schemas.js';

export interface RouteResult {
  readonly decision: RoutingDecision;
  /** 置信度是否达到阈值。false 时应向用户澄清，而不是继续派发 */
  readonly confident: boolean;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly attempts: number;
  readonly promptVersion: string;
}

export async function route(args: {
  readonly model: ModelPort;
  readonly userGoal: string;
  readonly threshold?: number;
  /**
   * 对话历史（供理解指代）。
   *
   * ⚠️ 不给则模型只看得到本轮 —— 那样「那今晚就按你说的做」
   *    这类跨轮指代会失败（实测过：回复里明说"本次校验未收到该方案产出"）。
   */
  readonly history?: readonly ModelMessage[];
}): Promise<RouteResult> {
  // ★ 可用 `ROUTING_CONFIDENCE_THRESHOLD` 覆盖（默认 0.6，与原先一致）
  const threshold = args.threshold ?? routingConfig.confidenceThreshold;

  const result = await args.model.completeStructured({
    purpose: 'routing',
    schema: routingSchema,
    schemaName: 'RoutingDecision',
    temperature: 0,
    maxOutputTokens: 512,
    messages: [
      msg.system(BUTLER_SYSTEM),
      ...(args.history ?? []),
      msg.user(routerTask(args.userGoal)),
    ],
  });

  return {
    decision: result.value,
    confident: result.value.confidence >= threshold,
    usage: result.usage,
    attempts: result.attempts,
    promptVersion: PROMPT_VERSIONS.routerTask,
  };
}
