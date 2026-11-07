/**
 * 把 core 的 `ReasoningPlan` 写进供应商请求体。
 *
 * ★ 这里是**唯一**知道具体字段名的地方（ADR 0004）：
 *   core 只给“档位 + 实际语义”，适配器负责落成 JSON。
 *
 * 字段依据：
 *   · DeepSeek：`thinking: {type: enabled|disabled}` + `reasoning_effort: low|high|max`
 *   · GLM：     `thinking: {type: enabled|disabled}` + `reasoning_effort`（GLM-5.2+）
 *   · MiMo：    Chat Completions 用 `reasoning_effort: none` 关闭；
 *               其余档位不发送（官方只区分开/关，不区分强度）
 *   · 其它：    不发送任何字段
 */

import type { ReasoningPlan } from '../../core/model/reasoning.js';

export function applyReasoningPlan(
  body: Record<string, unknown>,
  plan: ReasoningPlan,
): void {
  switch (plan.dispatch.style) {
    case 'deepseek':
    case 'glm': {
      if (plan.dispatch.thinking !== undefined) {
        body['thinking'] = { type: plan.dispatch.thinking };
      }
      if (plan.dispatch.reasoningEffort !== undefined) {
        body['reasoning_effort'] = plan.dispatch.reasoningEffort;
      }
      return;
    }
    case 'mimo': {
      /**
       * ⚠️ 只有 `none` 这一种“关闭”值是有把握的。
       *    非 off 档位**不发** —— 供应商自己按开启处理，
       *    我们不在请求里假装 low/high/max。
       */
      if (plan.dispatch.mimoEffort !== undefined) {
        body['reasoning_effort'] = plan.dispatch.mimoEffort;
      }
      return;
    }
    case 'none':
      return;
  }
}
