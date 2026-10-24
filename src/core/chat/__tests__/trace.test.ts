import { describe, expect, it } from 'vitest';

import { createTraceCollector } from '../trace.js';

describe('trace collector · usage', () => {
  it('保存工具循环的累计用量（跨轮取最后一轮总数）', () => {
    const trace = createTraceCollector();
    trace.onEvent({ kind: 'roundStarted', round: 1 });
    trace.onEvent({
      kind: 'usage',
      round: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalInputTokens: 100,
      totalOutputTokens: 20,
    });
    trace.onEvent({ kind: 'roundStarted', round: 2 });
    trace.onEvent({
      kind: 'usage',
      round: 2,
      inputTokens: 50,
      outputTokens: 10,
      totalInputTokens: 150,
      totalOutputTokens: 30,
    });
    trace.onEvent({ kind: 'finished', rounds: 2, reason: 'noToolCalls' });

    expect(trace.build().usage).toEqual({ inputTokens: 150, outputTokens: 30 });
  });

  it('没有 usage 事件时不伪造用量字段', () => {
    const trace = createTraceCollector();
    trace.onEvent({ kind: 'roundStarted', round: 1 });
    const built = trace.build();
    expect(built.usage).toBeUndefined();
  });
});
