/**
 * SSE 折叠的纯函数测试（v9 补 UI 测试网；不需要 jsdom）
 *
 * 这些函数决定"流式过程怎么长出来"，出错时表现为界面错乱而不是类型错误，
 * 所以值得单独测：工具结果先到、轮次后到、重复进度标签、错误后 done 等。
 */

import { describe, expect, it } from 'vitest';

import { applyEvent, asSseEvent, emptyAssistant } from '../chatLive.js';
import type { SseEvent } from '../types.js';

function fold(events: readonly SseEvent[]) {
  return events.reduce((a, e) => applyEvent(a, e), emptyAssistant());
}

describe('applyEvent', () => {
  it('progress：相同标签不重复，最多保留 6 条（保留最近的）', () => {
    const same = fold([
      { type: 'progress', event: { kind: 'stage', stage: 's1', label: '思考' } },
      { type: 'progress', event: { kind: 'stage', stage: 's1', label: '思考' } },
    ]);
    expect(same.stages).toEqual(['思考']);

    const a = fold([
      { type: 'progress', event: { kind: 'stage', stage: 's1', label: '思考' } },
      ...Array.from({ length: 8 }, (_, i) => ({
        type: 'progress' as const,
        event: { kind: 'stage' as const, stage: `s${i + 2}`, label: `步骤 ${i + 2}` },
      })),
    ]);
    expect(a.stages).toHaveLength(6);
    expect(a.stages[a.stages.length - 1]).toBe('步骤 9');
    expect(new Set(a.stages).size).toBe(6);
  });

  it('agent：工具调用先于轮次到达也能落到正确一轮', () => {
    const a = fold([
      { type: 'agent', kind: 'toolCall', round: 1, callId: 'c1', name: 'read_file', argsDelta: '{"path":', partial: true },
      { type: 'agent', kind: 'toolStarted', round: 1, callId: 'c1', name: 'read_file' },
      { type: 'agent', kind: 'toolResult', round: 1, callId: 'c1', name: 'read_file', ok: true, denied: false, output: 'ok', durationMs: 12 },
    ]);
    expect(a.rounds).toHaveLength(1);
    expect(a.rounds[0]?.tools[0]).toMatchObject({ callId: 'c1', name: 'read_file', status: 'ok', output: 'ok' });
  });

  it('reply：正文与完成状态', () => {
    const a = fold([{ type: 'reply', messageId: 'm1', text: '你好' }]);
    expect(a.text).toBe('你好');
    expect(a.status).toBe('done');
  });

  it('error 之后的 done 不会把状态改回完成', () => {
    const a = fold([
      { type: 'error', message: '网络断了' },
      { type: 'done' },
    ]);
    expect(a.status).toBe('error');
    expect(a.error).toBe('网络断了');
  });
});

describe('asSseEvent', () => {
  it('非对象 / 缺 type → null', () => {
    expect(asSseEvent(null)).toBeNull();
    expect(asSseEvent({ hello: 1 })).toBeNull();
    expect(asSseEvent('x')).toBeNull();
  });

  it('有 type 的对象原样收窄', () => {
    const e = asSseEvent({ type: 'done' });
    expect(e).toEqual({ type: 'done' });
  });
});
