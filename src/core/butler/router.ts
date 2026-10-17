/**
 * 管家 · 路由
 *
 * 设计依据：方案 § 2.2① 路由与任务分解
 *
 * ★★ v7 修订（D-4）：这条纪律**改了**。
 *
 *   原文：「置信度不足时**不猜测，转入澄清提问**。这是多 Agent 系统
 *          第一大故障（路由错配）的第一道防线。」
 *
 *   ⚠️ 为什么改：它把"我不确定"变成了"我不干活"。
 *      实测后果 —— 整轮返回 `steps: []`、`reports: []`，
 *      用户看到的是「置信度不足，已转入澄清提问，未执行派发。」
 *      然后**什么都没发生**。用户去忙别的回来一看，还是什么都没有。
 *
 *      这与产品目标直接冲突（D-4 / D-17）：
 *      **判断类的决定应该自主，不该让用户逐次审核。**
 *
 *   ★ 现在的纪律：
 *     · 路由**照样给出**最可能的判断（`servant` 一直有值）
 *     · 置信度不足时**带着这个假设继续干**，并把假设明说出来
 *     · 用户看到的是「结果 + 我按 X 理解的，不对说一声」，
 *       而不是「一个没回答的问题」
 *
 *   ⚠️ 注意这道门**只适用于判断类**。权限类（删文件、跑命令）
 *      不能这样处理 —— 判断错了能改，删掉的文件回不来。
 */

import { msg, type ModelMessage, type ModelPort } from '../ports/model.js';
import { routingConfig } from '../config/env.js';
import { BUTLER_SYSTEM, PROMPT_VERSIONS, routerTask } from '../prompts/butler.js';
import { routingSchema, type RoutingDecision } from '../prompts/schemas.js';

export interface RouteResult {
  readonly decision: RoutingDecision;
  /**
   * 置信度是否达到阈值。
   *
   * ⚠️ v7 起 `false` **不表示"不派发"** —— 表示"带着假设派发"。
   *    调用方应把假设告诉用户，而不是停下来等他回答。
   */
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
