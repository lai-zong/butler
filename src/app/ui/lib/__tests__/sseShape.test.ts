/**
 * SSE 事件的形状校验（2026-11-11 加固）
 *
 * ★ 实测复现：一条 `{"type":"progress"}`（没有 event 字段）能被旧实现
 *   `asSseEvent` 直接强转通过，随后 `applyEvent` 在 `e.event.label.trim()`
 *   上抛 TypeError —— 而它跑在流式渲染路径里，整页会被 error boundary 替换。
 *
 * 新行为：形状不对的事件返回 null（调用方跳过这一条），其余内容继续渲染。
 */

import { describe, expect, it } from 'vitest';

import { applyEvent, asSseEvent, emptyAssistant } from '../chatLive.js';

describe('asSseEvent：形状不对就拒绝', () => {
  it('缺 event 字段的 progress 被拒绝', () => {
    expect(asSseEvent({ type: 'progress' })).toBeNull();
  });

  it('缺 answer 的 narration 被拒绝', () => {
    expect(asSseEvent({ type: 'narration', reasoning: 'x' })).toBeNull();
  });

  it('缺 callId 的 toolCall 被拒绝', () => {
    expect(asSseEvent({ type: 'agent', kind: 'toolCall', round: 0, name: 'x' })).toBeNull();
  });

  it('形状正确的事件照常通过', () => {
    const ok = asSseEvent({
      type: 'progress',
      event: { kind: 'stage', stage: 'understand', label: '理解目标' },
    });
    expect(ok).not.toBeNull();
    expect(
      asSseEvent({ type: 'agent', kind: 'toolCall', round: 0, callId: 'c1', name: 'n', argsDelta: '{}' }),
    ).not.toBeNull();
    expect(asSseEvent({ type: 'reply', messageId: 'm', text: '好' })).not.toBeNull();
  });

  it('未知类型保持放行（前端不比后端更早知道新事件）', () => {
    expect(asSseEvent({ type: 'someFutureEvent' })).not.toBeNull();
  });
});

describe('applyEvent：坏事件不会再炸整页', () => {
  it('跳过被拒绝的事件后，正常事件仍能推进状态', () => {
    const bad = asSseEvent({ type: 'progress' });
    expect(bad).toBeNull();

    const good = asSseEvent({
      type: 'progress',
      event: { kind: 'stage', stage: 'recall', label: '召回记忆' },
    });
    expect(good).not.toBeNull();
    if (good === null) throw new Error('unreachable');
    const next = applyEvent(emptyAssistant(), good);
    expect(next.stages).toContain('召回记忆');
  });
});
