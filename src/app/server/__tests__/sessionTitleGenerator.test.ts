import { describe, expect, it } from 'vitest';

import type { ModelPort } from '@/core/ports/model.js';
import { generateSessionTitle } from '../sessionTitleGenerator.js';

function modelReturning(text: string, finishReason: 'stop' | 'length' = 'stop'): ModelPort {
  return {
    complete: async () => ({
      text,
      toolCalls: [],
      finishReason,
      usage: { inputTokens: 10, outputTokens: 4 },
    }),
  } as unknown as ModelPort;
}

describe('会话短标题生成', () => {
  it('清理引号/句号并限制长度', async () => {
    const title = await generateSessionTitle(modelReturning('“整理冰箱食材。”'), {
      userText: '冰箱里有鸡蛋、豆腐和西兰花，能做什么？',
      assistantText: '可以做西兰花豆腐汤。',
    });
    expect(title).toBe('整理冰箱食材');
  });

  it('没有模型或模型失败时返回 null，由调用方回退', async () => {
    expect(
      await generateSessionTitle(null, { userText: '你好', assistantText: '你好' }),
    ).toBeNull();
    expect(
      await generateSessionTitle(modelReturning('x'.repeat(80), 'length'), {
        userText: '你好',
        assistantText: '你好',
      }),
    ).toHaveLength(25);
  });
});
