/**
 * 审计投影的脱敏（v9）
 *
 * 练习卡承诺"答案只在提交后下发"；审计页的原始事件视图必须遵守同一承诺，
 * 否则点开 `quiz.created` 就能看到 `answers`（浏览器实测过）。
 */

import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../../../core/events/types.js';
import { sanitizeEventForClient } from '../uiData.js';

function quizEvent(): SessionEvent {
  return {
    id: 'evt_1',
    sessionId: 's_1',
    seq: 3,
    type: 'quiz.created',
    actor: 'butler',
    createdAt: 1,
    payload: {
      taskId: 'chat_1',
      artifactIndex: 0,
      questions: [{ id: 'q1', stem: '哪种用油最少？', options: ['油炸', '清蒸'] }],
      answers: [{ id: 'q1', correct: 'B', explanation: '清蒸几乎不用油' }],
    },
  } as SessionEvent;
}

describe('sanitizeEventForClient', () => {
  it('quiz.created 的答案卷被移除，题目保留', () => {
    const sanitized = sanitizeEventForClient(quizEvent());
    const payload = sanitized.payload as Record<string, unknown>;
    expect('answers' in payload).toBe(false);
    expect(JSON.stringify(sanitized)).not.toContain('"correct"');
    expect(JSON.stringify(sanitized)).not.toContain('清蒸几乎不用油');
    expect(payload['questions']).toBeDefined();
  });

  it('不修改原事件（服务端批改仍要能读答案）', () => {
    const original = quizEvent();
    sanitizeEventForClient(original);
    const payload = original.payload as Record<string, unknown>;
    expect(Array.isArray(payload['answers'])).toBe(true);
  });

  it('非 quiz 事件原样返回', () => {
    const e = {
      id: 'evt_2',
      sessionId: 's_1',
      seq: 4,
      type: 'session.ended',
      actor: 'butler',
      createdAt: 2,
      payload: {},
    } as SessionEvent;
    expect(sanitizeEventForClient(e)).toBe(e);
  });
});
