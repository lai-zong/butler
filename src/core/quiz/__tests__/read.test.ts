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

/**
 * ⚠️ 两个**不同**的 id，必须分开（真实系统里它们就是不同的）：
 *   · `LOG_ID`  —— `EventLog` 构造时传的"事件日志 id"，会填进 `SessionEvent.sessionId`
 *   · `SESSION` —— **聊天会话** id，写在事件 payload 的 `taskId` 里
 *
 * 曾经的缺陷：读题时按 `e.sessionId` 过滤 → 生产环境永远查不到。
 * 而测试里两者恰好传了同一个值，所以那个 bug **在测试里看不出来**。
 */
const LOG_ID = '__event_log__';
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
    const log = new EventLog(LOG_ID);
    const seq = seedQuiz(log);

    const quizzes = readQuizzes(log, SESSION);
    expect(quizzes).toHaveLength(1);
    expect(quizzes[0]?.id).toBe(seq);
    expect(quizzes[0]?.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(quizzes[0]?.questions[0]?.options).toEqual(['油炸', '清蒸']);
  });

  it('★★ 返回值里不含答案（它会被直接放进 HTTP 响应）', () => {
    const log = new EventLog(LOG_ID);
    seedQuiz(log);

    const dumped = JSON.stringify(readQuizzes(log, SESSION));
    expect(dumped).not.toContain('correct');
    expect(dumped).not.toContain('explanation');
    expect(dumped).not.toContain('清蒸几乎不用油');
  });

  it('混合题型：题目可见，但参考答案与 rubric 不出现在 readQuizzes', () => {
    const log = new EventLog(LOG_ID);
    log.append({
      type: 'quiz.created',
      actor: 'butler',
      payload: {
        taskId: SESSION,
        questions: [
          { id: 'q1', stem: '选择', options: ['甲', '乙'], type: 'choice', points: 1 },
          { id: 'q2', stem: '解释一下', options: [], type: 'short', points: 5 },
        ],
        answers: [
          { id: 'q1', correct: 'A', points: 1 },
          { id: 'q2', reference: '参考答案', rubric: '评分标准', points: 5 },
        ],
      },
    });
    const seq = log.length;
    const quiz = readQuizzes(log, SESSION)[0];
    expect(quiz?.questions.map((q) => q.type)).toEqual(['choice', 'short']);
    expect(JSON.stringify(quiz)).not.toContain('参考答案');
    expect(JSON.stringify(quiz)).not.toContain('评分标准');

    const key = readAnswerKey(log, SESSION, seq);
    expect(key?.references?.get('q2')).toBe('参考答案');
    expect(key?.rubrics?.get('q2')).toBe('评分标准');
    expect(key?.points?.get('q2')).toBe(5);
  });

  it('未批改时没有 grade 字段', () => {
    const log = new EventLog(LOG_ID);
    seedQuiz(log);
    expect(readQuizzes(log, SESSION)[0]?.grade).toBeUndefined();
  });

  it('★ 批改结果会挂到对应那份题上', () => {
    const log = new EventLog(LOG_ID);
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
    const log = new EventLog(LOG_ID);
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
    const log = new EventLog(LOG_ID);
    seedQuiz(log);
    // 另一条事件：**没有 taskId** —— 不属于任何聊天会话，不该被读到
    log.append({
      type: 'quiz.created',
      actor: 'butler',
      payload: { questions: [{ id: 'q9', stem: '别的会话', options: ['甲', '乙'] }], answers: [] },
    });
    expect(readQuizzes(log, SESSION)).toHaveLength(1);
    // 换成别的聊天会话 id 查，也一条都没有
    expect(readQuizzes(log, 'sess_other')).toHaveLength(0);
  });
});

describe('readQuizzes —— 损坏数据必须"少一条"，不能抛错', () => {
  it('questions 不是数组 → 跳过该条', () => {
    const log = new EventLog(LOG_ID);
    log.append({ type: 'quiz.created', actor: 'butler', payload: { questions: '不是数组' } });
    expect(() => readQuizzes(log, SESSION)).not.toThrow();
    expect(readQuizzes(log, SESSION)).toHaveLength(0);
  });

  it('题目结构不完整 → 只丢那一题', () => {
    const log = new EventLog(LOG_ID);
    log.append({
      type: 'quiz.created',
      actor: 'butler',
      payload: {
        // ⚠️ 必须带 taskId —— 否则整条事件不属于任何聊天会话，会被过滤掉，
        //    这条测试就退化成"因为查不到所以通过"，什么也没测到
        taskId: SESSION,
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
    const log = new EventLog(LOG_ID);
    log.append({ type: 'quiz.created', actor: 'butler', payload: {} });
    expect(readQuizzes(log, SESSION)).toHaveLength(0);
  });

  it('quiz.graded 的 payload 坏掉 → 当作未批改（而不是崩）', () => {
    const log = new EventLog(LOG_ID);
    const quizId = seedQuiz(log);
    log.append({ type: 'quiz.graded', actor: 'user', payload: { quizId, items: '坏' } });
    expect(() => readQuizzes(log, SESSION)).not.toThrow();
    expect(readQuizzes(log, SESSION)[0]?.grade).toBeUndefined();
  });
});

describe('readAnswerKey', () => {
  it('取出答案表（服务端专用）', () => {
    const log = new EventLog(LOG_ID);
    const quizId = seedQuiz(log);

    const key = readAnswerKey(log, SESSION, quizId);
    expect(key).toBeDefined();
    expect(key?.correct.get('q1')).toBe('B');
    expect(key?.correct.get('q2')).toBe('A');
    expect(key?.questions).toHaveLength(2);
  });

  it('quizId 不存在 → undefined', () => {
    const log = new EventLog(LOG_ID);
    seedQuiz(log);
    expect(readAnswerKey(log, SESSION, 999)).toBeUndefined();
  });

  it('★ 一道答案都没有 → undefined（无法批改，当作不存在）', () => {
    const log = new EventLog(LOG_ID);
    const quizId = seedQuiz(log, { withAnswers: false });
    expect(readAnswerKey(log, SESSION, quizId)).toBeUndefined();
  });

  it('★ 只有 rubric、没有 correct/reference 的题不可批改（与 readAnswerKey 一致）', () => {
    const log = new EventLog(LOG_ID);
    log.append({
      type: 'quiz.created',
      actor: 'butler',
      payload: {
        taskId: SESSION,
        questions: [{ id: 'q1', stem: '解释一下', options: [], type: 'short', points: 5 }],
        answers: [{ id: 'q1', rubric: '要点齐全', points: 5 }],
      },
    });
    const quizId = log.length;
    expect(readQuizzes(log, SESSION)[0]?.gradable).toBe(false);
    expect(readAnswerKey(log, SESSION, quizId)).toBeUndefined();
  });

  it('★ 旧日志里重复题目 id 只保留第一道，不产生重复 UI key / 错位答案', () => {
    const log = new EventLog(LOG_ID);
    log.append({
      type: 'quiz.created',
      actor: 'butler',
      payload: {
        taskId: SESSION,
        questions: [
          { id: 'q1', stem: '第一道', options: ['甲', '乙'], type: 'choice', points: 1 },
          { id: 'q1', stem: '第二道', options: ['甲', '乙'], type: 'choice', points: 1 },
        ],
        answers: [
          { id: 'q1', correct: 'A', points: 1 },
          { id: 'q1', correct: 'B', points: 1 },
        ],
      },
    });
    const quiz = readQuizzes(log, SESSION)[0];
    expect(quiz?.questions).toHaveLength(1);
    expect(quiz?.questions[0]?.stem).toBe('第一道');
    expect(readAnswerKey(log, SESSION, 1)?.correct.get('q1')).toBe('A');
  });

  it('★ 绝不能把答案表现在直接当响应——它的类型里就有 correct', () => {
    // 这条是"提醒式断言"：说明为什么 API 层必须用 readQuizzes 而不是它
    const log = new EventLog(LOG_ID);
    const quizId = seedQuiz(log);
    const key = readAnswerKey(log, SESSION, quizId);
    expect(key !== undefined && 'correct' in key).toBe(true);
  });
});

describe('readExplanations', () => {
  it('只返回有解析的题', () => {
    const log = new EventLog(LOG_ID);
    const quizId = seedQuiz(log);
    const key = readAnswerKey(log, SESSION, quizId);
    if (!key) throw new Error('答案表缺失');

    expect(readExplanations(key)).toEqual([
      { questionId: 'q1', explanation: '清蒸几乎不用油' },
    ]);
  });
});

describe('★ 字段语义回归：日志 id 与聊天会话 id 不是一回事', () => {
  it('按日志 id 查不到题（这正是不该用它过滤的原因）', () => {
    const log = new EventLog(LOG_ID);
    seedQuiz(log);

    // 用日志 id 查 → 空（因为它不是聊天会话 id）
    expect(readQuizzes(log, LOG_ID)).toHaveLength(0);
    // 用聊天会话 id 查 → 有
    expect(readQuizzes(log, SESSION)).toHaveLength(1);
  });

  it('事件自身的 sessionId 是日志 id，不是聊天会话 id', () => {
    const log = new EventLog(LOG_ID);
    seedQuiz(log);

    const ev = log.byType('quiz.created')[0];
    expect(ev?.sessionId).toBe(LOG_ID);
    expect((ev?.payload as { taskId?: string }).taskId).toBe(SESSION);
    // 两者必须不同 —— 相同的话这个测试就没有意义了
    expect(LOG_ID).not.toBe(SESSION);
  });

  it('readAnswerKey 也按聊天会话 id 校验归属', () => {
    const log = new EventLog(LOG_ID);
    const quizId = seedQuiz(log);

    expect(readAnswerKey(log, SESSION, quizId)).toBeDefined();
    // 用日志 id 当会话 id → 拒绝（防止跨会话拿答案）
    expect(readAnswerKey(log, LOG_ID, quizId)).toBeUndefined();
  });
});
