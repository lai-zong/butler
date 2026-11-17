/**
 * 主观题 AI 批改：只测核心边界，不碰真实网络。
 * ★ 选择题不进来；一次提交只发一次模型调用；分数夹在 maxScore 内。
 */

import { describe, expect, it, vi } from 'vitest';

import type { ModelCall, ModelPort } from '../../ports/model.js';
import { gradeSubjective } from '../aiGrade.js';
import type { QuizAnswerKey } from '../types.js';

function key(): QuizAnswerKey {
  return {
    id: 9,
    sessionId: 's1',
    questions: [
      { id: 'q1', stem: '解释特征值', options: [], type: 'short', points: 5 },
      { id: 'q2', stem: '论述应用', options: [], type: 'essay', points: 10 },
    ],
    correct: new Map(),
    explanations: new Map(),
    references: new Map([
      ['q1', '特征值使 Av=λv'],
      ['q2', '应提到对角化与稳定性'],
    ]),
    rubrics: new Map([
      ['q1', '说明定义与几何意义'],
      ['q2', '至少两个应用场景'],
    ]),
    points: new Map([
      ['q1', 5],
      ['q2', 10],
    ]),
  };
}

function fakeModel(): { model: ModelPort; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const model = {
    completeStructured: vi.fn(async (call: ModelCall) => {
      calls.push(call);
      return {
        value: {
          results: [
            { questionId: 'q1', score: 4, maxScore: 99, right: true, feedback: '定义基本正确' },
            { questionId: 'q2', score: 16, maxScore: 10, right: true, feedback: '应用充分' },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        attempts: 1,
      };
    }),
    complete: vi.fn(),
    describe: () => ({ provider: 'test', model: 'test', capabilities: { supportsVision: false, supportsStreaming: false, supportsTools: false, supportsThinking: false } }),
  } as unknown as ModelPort;
  return { model, calls };
}

describe('gradeSubjective', () => {
  it('没有主观题时不调用模型', async () => {
    const { model, calls } = fakeModel();
    const choiceKey: QuizAnswerKey = {
      ...key(),
      questions: [{ id: 'q1', stem: '选一个', options: ['甲', '乙'], type: 'choice' }],
      references: new Map(),
      rubrics: new Map(),
    };
    const result = await gradeSubjective({ model, answerKey: choiceKey, submission: { q1: 'A' } });
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('一次调用批改全部主观题，并按题目上限 clamp', async () => {
    const { model, calls } = fakeModel();
    const result = await gradeSubjective({
      model,
      answerKey: key(),
      submission: { q1: '定义...', q2: '对角化、稳定性...' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.purpose).toBe('quizGrade');
    expect(result?.items).toHaveLength(2);
    expect(result?.items[0]?.score).toBe(4);
    expect(result?.items[1]?.score).toBe(10);
    expect(result?.items[1]?.feedback).toBe('应用充分');
  });

  it('模型漏题时报错，不静默给 0 分', async () => {
    const { model } = fakeModel();
    (model.completeStructured as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      value: { results: [{ questionId: 'q1', score: 1, maxScore: 1 }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      attempts: 1,
    });
    await expect(
      gradeSubjective({ model, answerKey: key(), submission: { q1: 'a', q2: 'b' } }),
    ).rejects.toThrow('批改结果缺少题目');
  });

  it('★ 不采纳模型自造的 reference，只回传答案卷里的可信 reference', async () => {
    const { model } = fakeModel();
    (model.completeStructured as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      value: {
        results: [
          { questionId: 'q1', score: 4, maxScore: 5, feedback: 'ok', reference: '模型编造的答案' },
          { questionId: 'q2', score: 8, maxScore: 10, feedback: 'ok', reference: '另一段编造' },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      attempts: 1,
    });
    const result = await gradeSubjective({
      model,
      answerKey: key(),
      submission: { q1: 'a', q2: 'b' },
    });
    expect(result?.items[0]?.reference).toBe('特征值使 Av=λv');
    expect(result?.items[1]?.reference).toBe('应提到对角化与稳定性');
    expect(JSON.stringify(result)).not.toContain('模型编造的答案');
  });
});
