/**
 * 从事件读题目与答案的验证（v8 批次A）。
 *
 * ★★ 两条必须在测试里钉死的性质：
 *
 *   ① **`readQuizzes()` 的返回值里不能有答案** —— 它的返回值会直接进 HTTP 响应。
 *      这条用"序列化后不含 correct/explanation 键"来断言。
 *
 *   ② **持久化数据是不可信输入** —— 旧日志或损坏日志缺字段时，
 *      只能"少一条题"，不能抛错、不能造出半条数据。
 *      项目有过一次真实事故：给产出物加必填字段后旧数据缺字段，首页 500。
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { readAnswerKey, readExplanations, readQuizzes } from '../read.js';

const SESSION = 'sess_quiz';

/** 造一条真实的 `quiz.created` 事件 */
function seedQuiz(
  log: EventLog,
  opts?: { withAnswers?: boolean; sessionId?: string },
): number {
  const withAnswers = opts?.withAnswers ?? true;
  log.append({
    type: 'quiz.created',
    actor: 'butler',
    payload: {
      taskId: SESSION,
      artifactIndex: 0,
      questions: [
        { id: 'q1', stem: '哪种用油最少？', options: ['油炸', '清蒸'] },
        { id: 'q2', stem: '花生过敏要避开？', options: ['花生酱', '西兰花'] },
      ],
      answers: withAnswers
        ? [
            { id: 'q1', correct: 'B', explanation: '清蒸几乎不用油' },
            { id: 'q2', correct: 'A' },
          ]
        : [],
    },
  });
  return log.length; // 刚 append 的那条事件的 seq
}

describe('readQuizzes', () => {
  it('读出题目，且 id 等于事件的 seq', () => {
    const log = new EventLog(SESSION);
    const seq = seedQuiz(log);

    const quizzes = readQuizzes(log, SESSION);
    expect(quizzes).toHaveLength(1);
    expect(quizzes[0]?.id).toBe(seq);
    expect(quizzes[0]?.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(quizzes[0]?.questions[0]?.options).toEqual(['油炸', '清蒸']);
  });

  it('★★ 返回值里不含答案（它会被直接放进 HTTP 响应）', () => {
    const log = new EventLog(SESSION);
    seedQuiz(log);

    const dumped = JSON.stringify(readQuizzes(log, SESSION));
    expect(dumped).not.toContain('correct');
    expect(dumped).not.toContain('explanation');
    expect(dumped).not.toContain('清蒸几乎不用油');
  });

  it('未批改时没有 grade 字段', () => {
    const log = new EventLog(SESSION);
    seedQuiz(log);
    expect(readQuizzes(log, SESSION)[0]?.grade).toBeUndefined();
  });

  it('★ 批改结果会挂到对应那份题上', () => {
    const log = new EventLog(SESSION);
    const quizId = seedQuiz(log);

    log.append({
      type: 'quiz.graded',
      actor: 'user',
      payload: {
        quizId,
        items: [
          { questionId: 'q1', stem: '哪种用油最少？', picked: 'B', correct: 'B', right: true },
          { questionId: 'q2', stem: '花生过敏要避开？', picked: 'B', correct: 'A', right: false },
        ],
      },
    });

    const grade = readQuizzes(log, SESSION)[0]?.grade;
    expect(grade?.total).toBe(2);
    expect(grade?.right).toBe(1);
    expect(grade?.items[1]?.right).toBe(false);
  });

  it('同一份题被批改多次时取**最后一条**', () => {
    const log = new EventLog(SESSION);
    const quizId = seedQuiz(log);
    for (const right of [false, true]) {
      log.append({
        type: 'quiz.graded',
        actor: 'user',
        payload: {
          quizId,
          items: [{ questionId: 'q1', stem: 'x', picked: 'B', correct: 'B', right }],
        },
      });
    }
    expect(readQuizzes(log, SESSION)[0]?.grade?.right).toBe(1);
  });

  it('只看本会话的题', () => {
    const log = new EventLog(SESSION);
    seedQuiz(log);
    log.append({
      type: 'quiz.created',
      actor: 'butler',
      payload: { questions: [{ id: 'q9', stem: '别的会话', options: ['甲', '乙'] }], answers: [] },
    });
    // 第二条事件仍属于同一 log（同一 sessionId），所以两条都该读到
    expect(readQuizzes(log, SESSION)).toHaveLength(2);
    // 而换成别的 sessionId 查，就一条都没有
    expect(readQuizzes(log, 'sess_other')).toHaveLength(0);
  });
});

describe('readQuizzes —— 损坏数据必须"少一条"，不能抛错', () => {
  it('questions 不是数组 → 跳过该条', () => {
    const log = new EventLog(SESSION);
    log.append({ type: 'quiz.created', actor: 'butler', payload: { questions: '不是数组' } });
    expect(() => readQuizzes(log, SESSION)).not.toThrow();
    expect(readQuizzes(log, SESSION)).toHaveLength(0);
  });

  it('题目结构不完整 → 只丢那一题', () => {
    const log = new EventLog(SESSION);
    log.append({
      type: 'quiz.created',
      actor: 'butler',
      payload: {
        questions: [
          { id: 'q1', stem: '完整', options: ['甲', '乙'] },
          { id: 'q2', stem: '只有一个选项', options: ['甲'] },
          { id: 'q3', options: ['甲', '乙'] },
          { stem: '没有 id', options: ['甲', '乙'] },
          '不是对象',
        ],
        answers: [],
      },
    });
    const quizzes = readQuizzes(log, SESSION);
    expect(quizzes).toHaveLength(1);
    expect(quizzes[0]?.questions.map((q) => q.id)).toEqual(['q1']);
  });

  it('payload 完全为空 → 跳过', () => {
    const log = new EventLog(SESSION);
    log.append({ type: 'quiz.created', actor: 'butler', payload: {} });
    expect(readQuizzes(log, SESSION)).toHaveLength(0);
  });

  it('quiz.graded 的 payload 坏掉 → 当作未批改（而不是崩）', () => {
    const log = new EventLog(SESSION);
    const quizId = seedQuiz(log);
    log.append({ type: 'quiz.graded', actor: 'user', payload: { quizId, items: '坏' } });
    expect(() => readQuizzes(log, SESSION)).not.toThrow();
    expect(readQuizzes(log, SESSION)[0]?.grade).toBeUndefined();
  });
});

describe('readAnswerKey', () => {
  it('取出答案表（服务端专用）', () => {
    const log = new EventLog(SESSION);
    const quizId = seedQuiz(log);

    const key = readAnswerKey(log, SESSION, quizId);
    expect(key).toBeDefined();
    expect(key?.correct.get('q1')).toBe('B');
    expect(key?.correct.get('q2')).toBe('A');
    expect(key?.questions).toHaveLength(2);
  });

  it('quizId 不存在 → undefined', () => {
    const log = new EventLog(SESSION);
    seedQuiz(log);
    expect(readAnswerKey(log, SESSION, 999)).toBeUndefined();
  });

  it('★ 一道答案都没有 → undefined（无法批改，当作不存在）', () => {
    const log = new EventLog(SESSION);
    const quizId = seedQuiz(log, { withAnswers: false });
    expect(readAnswerKey(log, SESSION, quizId)).toBeUndefined();
  });

  it('★ 绝不能把答案表现在直接当响应——它的类型里就有 correct', () => {
    // 这条是"提醒式断言"：说明为什么 API 层必须用 readQuizzes 而不是它
    const log = new EventLog(SESSION);
    const quizId = seedQuiz(log);
    const key = readAnswerKey(log, SESSION, quizId);
    expect(key !== undefined && 'correct' in key).toBe(true);
  });
});

describe('readExplanations', () => {
  it('只返回有解析的题', () => {
    const log = new EventLog(SESSION);
    const quizId = seedQuiz(log);
    const key = readAnswerKey(log, SESSION, quizId);
    if (!key) throw new Error('答案表缺失');

    expect(readExplanations(key)).toEqual([
      { questionId: 'q1', explanation: '清蒸几乎不用油' },
    ]);
  });
});
