/**
 * 确定性批改验证（v8 批次A）。
 *
 * ★ 为什么这些断言值得写这么细：
 *   批改是**用户会直接对着答案核对的输出**。错一次，用户对系统的信任就没了。
 *   而它的错法很隐蔽 —— 不崩，只是"明明对了却报错"。
 *
 * ⚠️ 尤其要钉死三条边界：未作答 / 无法归一化 / 缺答案键。
 *    这三处如果"尽量理解"用户，就会在用户答错时误判为对。
 */

import { describe, expect, it } from 'vitest';

import { gradeQuiz } from '../grade.js';
import type { QuizAnswerKey } from '../types.js';

function key(
  questions: readonly { id: string; stem: string; options: string[] }[],
  correct: Record<string, string>,
): QuizAnswerKey {
  return {
    id: 7,
    sessionId: 'sess_1',
    questions,
    correct: new Map(Object.entries(correct)),
    explanations: new Map(),
  };
}

const THREE = [
  { id: 'q1', stem: '题一', options: ['甲', '乙', '丙'] },
  { id: 'q2', stem: '题二', options: ['甲', '乙'] },
  { id: 'q3', stem: '题三', options: ['甲', '乙'] },
];

describe('gradeQuiz —— 基本判定', () => {
  it('全对', () => {
    const g = gradeQuiz({
      answerKey: key(THREE, { q1: 'A', q2: 'B', q3: 'A' }),
      submission: { q1: 'A', q2: 'B', q3: 'A' },
    });
    expect(g.total).toBe(3);
    expect(g.right).toBe(3);
    expect(g.items.every((i) => i.right)).toBe(true);
  });

  it('对错混合：分别给出 picked 与 correct', () => {
    const g = gradeQuiz({
      answerKey: key(THREE, { q1: 'A', q2: 'B', q3: 'A' }),
      submission: { q1: 'C', q2: 'B' },
    });
    expect(g.right).toBe(1);
    expect(g.items[0]).toMatchObject({ questionId: 'q1', picked: 'C', correct: 'A', right: false });
    expect(g.items[1]).toMatchObject({ questionId: 'q2', picked: 'B', correct: 'B', right: true });
  });
});

describe('gradeQuiz —— ★ 三条必须钉死的边界', () => {
  it('★ 未作答算错，但 picked **留空**（界面要能区分"没做"与"选错"）', () => {
    const g = gradeQuiz({
      answerKey: key(THREE, { q1: 'A', q2: 'B', q3: 'A' }),
      submission: { q2: 'B' },
    });

    const q1 = g.items.find((i) => i.questionId === 'q1');
    expect(q1?.right).toBe(false);
    expect(q1?.picked).toBeUndefined(); // ← 关键：不是 'X'、不是 ''
    expect('picked' in (q1 ?? {})).toBe(false);
  });

  it('★ 无法归一化的作答算错，且**不猜测**', () => {
    const g = gradeQuiz({
      answerKey: key(THREE, { q1: 'A', q2: 'B', q3: 'A' }),
      submission: { q1: '我选第一个', q2: 'Z', q3: '' },
    });
    // 三个都不该被判对
    expect(g.right).toBe(0);
  });

  it('★ 缺答案键的题**判错而不是跳过**（跳题会让 total 骗人）', () => {
    const g = gradeQuiz({
      answerKey: key(THREE, { q1: 'A' }), // 后两题没有答案
      submission: { q1: 'A', q2: 'B', q3: 'A' },
    });
    expect(g.total).toBe(3); // ← 不能变成 1
    expect(g.right).toBe(1);
    expect(g.items[1]?.right).toBe(false);
    expect(g.items[1]?.correct).toBeUndefined();
  });
});

describe('gradeQuiz —— 作答写法宽容（与模型侧共用同一套归一化）', () => {
  it('小写、带前缀、数字下标都能判对', () => {
    const cases: [string, boolean][] = [
      ['a', true],
      ['A', true],
      ['A. 甲', true],
      ['1', true],
      ['甲', true],
      ['B', false],
    ];
    for (const [picked, expected] of cases) {
      const g = gradeQuiz({
        answerKey: key([THREE[0]!], { q1: 'A' }),
        submission: { q1: picked },
      });
      expect(g.items[0]?.right, `作答 ${picked} 应判 ${expected ? '对' : '错'}`).toBe(expected);
    }
  });

  it('归一化后 picked 一律是大写字母（对外展示统一）', () => {
    const g = gradeQuiz({
      answerKey: key([THREE[0]!], { q1: 'B' }),
      submission: { q1: 'b' },
    });
    expect(g.items[0]?.picked).toBe('B');
  });
});

describe('gradeQuiz —— 纯函数性质', () => {
  it('不修改入参', () => {
    const k = key(THREE, { q1: 'A', q2: 'B', q3: 'A' });
    const submission = { q1: 'A' };
    const before = JSON.stringify({ n: k.questions.length, c: [...k.correct], s: submission });
    gradeQuiz({ answerKey: k, submission });
    const after = JSON.stringify({ n: k.questions.length, c: [...k.correct], s: submission });
    expect(after).toBe(before);
  });

  it('同样的输入两次结果一致（可重放）', () => {
    const run = (): string =>
      JSON.stringify(
        gradeQuiz({
          answerKey: key(THREE, { q1: 'A', q2: 'B', q3: 'A' }),
          submission: { q1: 'A', q2: 'A' },
        }),
      );
    expect(run()).toBe(run());
  });

  it('空题集 → total 0 且不抛错', () => {
    const g = gradeQuiz({ answerKey: key([], {}), submission: { q1: 'A' } });
    expect(g).toEqual({ total: 0, right: 0, items: [] });
  });
});
