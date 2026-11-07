/**
 * ReasoningPlan → 请求体字段
 *
 * ★ 这里锁的是“实际发什么”：
 *   core 的 plan 说 applied 是什么，适配器就必须在 body 里落成什么。
 *   两者不一致时，事件里的审计值就是假的。
 */

import { describe, expect, it } from 'vitest';

import { applyReasoningPlan } from '../reasoning.js';
import { planReasoning } from '../../../core/model/reasoning.js';

function bodyFor(level: 'off' | 'low' | 'high' | 'max', provider: 'deepseek' | 'glm' | 'mimo', model: string) {
  const body: Record<string, unknown> = {};
  applyReasoningPlan(body, planReasoning({ level, provider, model }));
  return body;
}

describe('applyReasoningPlan', () => {
  it('DeepSeek off → thinking.disabled，且没有 reasoning_effort', () => {
    const body = bodyFor('off', 'deepseek', 'deepseek-flash');
    expect(body['thinking']).toEqual({ type: 'disabled' });
    expect('reasoning_effort' in body).toBe(false);
  });

  it('DeepSeek max → thinking.enabled + reasoning_effort=max', () => {
    const body = bodyFor('max', 'deepseek', 'deepseek-flash');
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect(body['reasoning_effort']).toBe('max');
  });

  it('GLM-5.3 off 回退 → thinking.enabled + reasoning_effort=low', () => {
    const body = bodyFor('off', 'glm', 'glm-5.3');
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect(body['reasoning_effort']).toBe('low');
  });

  it('GLM-4.6 max 不支持 effort → 只发 thinking.enabled', () => {
    const body = bodyFor('max', 'glm', 'glm-4.6');
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect('reasoning_effort' in body).toBe(false);
  });

  it('MiMo off → reasoning_effort=none；开启档不写字面强度字段', () => {
    const off = bodyFor('off', 'mimo', 'mimo-v2.6-flash');
    expect(off['reasoning_effort']).toBe('none');
    expect('thinking' in off).toBe(false);

    for (const level of ['low', 'high', 'max'] as const) {
      const body = bodyFor(level, 'mimo', 'mimo-v2.6-flash');
      expect('thinking' in body).toBe(false);
      expect('reasoning_effort' in body).toBe(false);
    }
  });

  it('未知供应商什么都不发', () => {
    const body: Record<string, unknown> = { model: 'x' };
    applyReasoningPlan(body, planReasoning({ level: 'high', provider: 'openai-compatible', model: 'x' }));
    expect(body).toEqual({ model: 'x' });
  });
});
