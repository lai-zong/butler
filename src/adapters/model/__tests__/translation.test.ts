import { describe, expect, it } from 'vitest';

import { deepSeekTranslationPort } from '../translation.js';
import type { ModelPort } from '../../../core/ports/model.js';

function fakeModel(text: string): { model: ModelPort; calls: unknown[] } {
  const calls: unknown[] = [];
  const model = {
    complete: (call: unknown) => {
      calls.push(call);
      return Promise.resolve({ text });
    },
    completeStructured: () => Promise.reject(new Error('not used')),
    describe: () => ({
      provider: 'stub',
      model: 'stub',
      capabilities: {
        supportsVision: false,
        supportsStreaming: false,
        supportsTools: false,
        supportsThinking: false,
      },
    }),
  } as unknown as ModelPort;
  return { model, calls };
}

describe('DeepSeek 思考翻译端口', () => {
  it('使用 translation purpose、关闭 thinking，并返回译文', async () => {
    const { model, calls } = fakeModel('  用户想查天气。  ');
    const port = deepSeekTranslationPort(model);
    expect(await port.translate('The user wants weather.')).toBe('用户想查天气。');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: 'translation',
      thinking: 'disabled',
      temperature: 0,
    });
  });

  it('空译文按失败处理，不把空串当成功', async () => {
    const { model } = fakeModel('   ');
    const port = deepSeekTranslationPort(model);
    await expect(port.translate('hello')).rejects.toThrow('空文本');
  });

  it('传递取消信号', async () => {
    const { model, calls } = fakeModel('译文');
    const port = deepSeekTranslationPort(model);
    const controller = new AbortController();
    await port.translate('hello', controller.signal);
    expect((calls[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });
});
