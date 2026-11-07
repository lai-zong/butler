/**
 * 思考强度四档映射
 *
 * 依据（2026-11 官方文档）：
 *   · DeepSeek：thinking + reasoning_effort（off 可关闭）
 *   · GLM-5.3：不能关思考；off 回退 low
 *   · GLM-5.2：支持 reasoning_effort，low 官方映射为 high
 *   · GLM-4.x / 5.0 / 5.1：只有开关，没有 effort
 *   · MiMo：只区分 none / 开，不区分强度
 *   · 其它：没有把握就不发送
 */

import { describe, expect, it } from 'vitest';

import {
  detectReasoningProvider,
  isReasoningLevel,
  planReasoning,
  reasoningFromLegacyThinkingLevel,
} from '../reasoning.js';

describe('统一四档校验', () => {
  it('只接受 off / low / high / max', () => {
    for (const v of ['off', 'low', 'high', 'max']) expect(isReasoningLevel(v)).toBe(true);
    for (const v of ['medium', 'default', 'HIGH', '', null, 3]) {
      expect(isReasoningLevel(v)).toBe(false);
    }
  });
});

describe('供应商识别', () => {
  it('DeepSeek 预设 / 适配器 → deepseek', () => {
    expect(detectReasoningProvider({ presetId: 'deepseek', model: 'deepseek-flash' })).toBe('deepseek');
    expect(detectReasoningProvider({ adapter: 'deepseek', model: 'x' })).toBe('deepseek');
  });

  it('智谱预设或 glm-* 模型 → glm', () => {
    expect(detectReasoningProvider({ presetId: 'zhipu', model: 'glm-5.3' })).toBe('glm');
    expect(detectReasoningProvider({ model: 'glm-4.6' })).toBe('glm');
  });

  it('mimo-* 模型 → mimo；Ollama → ollama；其它 → openai-compatible', () => {
    expect(detectReasoningProvider({ model: 'mimo-v2.6-flash' })).toBe('mimo');
    expect(detectReasoningProvider({ adapter: 'ollama', model: 'qwen3.5:4b' })).toBe('ollama');
    expect(detectReasoningProvider({ presetId: 'openai', model: 'gpt-4o-mini' })).toBe('openai-compatible');
  });
});

describe('DeepSeek · 四档全部真实发送', () => {
  const model = 'deepseek-flash';

  it('off → thinking=disabled，不发 reasoning_effort', () => {
    const p = planReasoning({ level: 'off', provider: 'deepseek', model });
    expect(p.dispatch).toEqual({ style: 'deepseek', thinking: 'disabled' });
    expect(p.applied).toBe('off');
    expect(p.fallbackReason).toBeUndefined();
    expect(p.sentFields).toEqual(['thinking']);
  });

  it('low / high / max → thinking=enabled + 对应 reasoning_effort', () => {
    for (const level of ['low', 'high', 'max'] as const) {
      const p = planReasoning({ level, provider: 'deepseek', model });
      expect(p.dispatch).toEqual({
        style: 'deepseek',
        thinking: 'enabled',
        reasoningEffort: level,
      });
      expect(p.applied).toBe(level);
      expect(p.sentFields).toEqual(['thinking', 'reasoning_effort']);
    }
  });
});

describe('GLM · 关不掉时回退最低档', () => {
  it('GLM-5.3 请求 off → enabled + low，并记录回退', () => {
    const p = planReasoning({ level: 'off', provider: 'glm', model: 'glm-5.3' });
    expect(p.dispatch).toEqual({ style: 'glm', thinking: 'enabled', reasoningEffort: 'low' });
    expect(p.applied).toBe('low');
    expect(p.fallbackReason).toContain('不支持关闭思考');
  });

  it('GLM-5.3-Flash 同样关不掉', () => {
    const p = planReasoning({ level: 'off', provider: 'glm', model: 'glm-5.3-flash' });
    expect(p.applied).toBe('low');
  });

  it('GLM-4.6 可以关思考；但没有 reasoning_effort', () => {
    const off = planReasoning({ level: 'off', provider: 'glm', model: 'glm-4.6' });
    expect(off.dispatch).toEqual({ style: 'glm', thinking: 'disabled' });
    expect(off.applied).toBe('off');

    const max = planReasoning({ level: 'max', provider: 'glm', model: 'glm-4.6' });
    expect(max.dispatch).toEqual({ style: 'glm', thinking: 'enabled' });
    expect(max.applied).toBe('high');
    expect(max.fallbackReason).toContain('不支持 reasoning_effort');
  });

  it('GLM-5.2 支持 effort，且 low 官方映射为 high', () => {
    const low = planReasoning({ level: 'low', provider: 'glm', model: 'glm-5.2' });
    expect(low.dispatch).toEqual({ style: 'glm', thinking: 'enabled', reasoningEffort: 'low' });
    expect(low.applied).toBe('high');
    expect(low.fallbackReason).toContain('映射');

    const max = planReasoning({ level: 'max', provider: 'glm', model: 'glm-5.2' });
    expect(max.applied).toBe('max');
  });
});

describe('MiMo · 只有开/关两种实际效果', () => {
  it('off 发 reasoning_effort=none', () => {
    const p = planReasoning({ level: 'off', provider: 'mimo', model: 'mimo-v2.6-flash' });
    expect(p.dispatch).toEqual({ style: 'mimo', mimoEffort: 'none' });
    expect(p.applied).toBe('off');
    expect(p.sentFields).toEqual(['reasoning_effort']);
  });

  it('low / high / max 都按“开启”处理，不假装强度', () => {
    for (const level of ['low', 'high', 'max'] as const) {
      const p = planReasoning({ level, provider: 'mimo', model: 'mimo-v2.6-pro' });
      expect(p.dispatch).toEqual({ style: 'mimo' });
      expect(p.applied).toBe('high');
      expect(p.sentFields).toEqual([]);
      expect(p.fallbackReason).toContain('不区分强度');
    }
  });
});

describe('未知 OpenAI 兼容 · 不发送、不阻断', () => {
  it('applied 为 null，没有任何请求字段', () => {
    for (const provider of ['openai-compatible', 'ollama', 'unknown'] as const) {
      const p = planReasoning({ level: 'high', provider, model: 'some-model' });
      expect(p.style).toBe('none');
      expect(p.dispatch).toEqual({ style: 'none' });
      expect(p.applied).toBeNull();
      expect(p.sentFields).toEqual([]);
    }
  });
});

describe('旧桌宠档位兼容', () => {
  it('default / medium → high；low / high 原样', () => {
    expect(reasoningFromLegacyThinkingLevel('default')).toBe('high');
    expect(reasoningFromLegacyThinkingLevel('medium')).toBe('high');
    expect(reasoningFromLegacyThinkingLevel('low')).toBe('low');
    expect(reasoningFromLegacyThinkingLevel('high')).toBe('high');
  });
});
