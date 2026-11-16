/**
 * `normalizeArtifact` 的扩展验证（v8 批次A）。
 *
 * 这里要证明两件事：
 *   ① `table` / `quiz` 两种**真结构**能正确归一化（不再压平成字符串）
 *   ② ★ **答案与题目在归一化内部就已分离** —— 产出物里根本没有答案
 *
 * ② 是安全属性，不是功能属性：一旦答案漏进产出物，
 *    它会随消息一起重放给调用方，"做题视图"等于把答案印在题目下面。
 */

import { describe, expect, it } from 'vitest';

import { normalizeArtifact } from '../schemas.js';
import type { NormalizedQuizQuestion, NormalizedTable } from '../schemas.js';

type Normalized = NonNullable<ReturnType<typeof normalizeArtifact>>;

/**
 * ⚠️ 这里刻意**不用 `as` 强转**。
 *
 *    强转会关掉类型检查 —— 如果 kind 判断写错，测试会"通过"一个错的东西。
 *    收窄失败时直接抛错，测试立刻红。
 */
function tableOf(n: Normalized | null): NormalizedTable {
  if (n === null) throw new Error('归一化结果为空');
  if (n.artifact.kind !== 'table') throw new Error(`期望 table，实际 ${n.artifact.kind}`);
  return n.artifact.content;
}

function questionsOf(n: Normalized | null): readonly NormalizedQuizQuestion[] {
  if (n === null) throw new Error('归一化结果为空');
  if (n.artifact.kind !== 'quiz') throw new Error(`期望 quiz，实际 ${n.artifact.kind}`);
  return n.artifact.content;
}

describe('normalizeArtifact —— table（真结构）', () => {
  it('专用 table 字段：保留行列结构', () => {
    const n = normalizeArtifact({
      kind: 'table',
      table: {
        columns: ['菜品', '用油', '是否含花生'],
        rows: [
          ['清蒸鲈鱼', '2g', '否'],
          ['蒜蓉西兰花', '3g', '否'],
        ],
      },
    });

    expect(tableOf(n)).toEqual({
      columns: ['菜品', '用油', '是否含花生'],
      rows: [
        ['清蒸鲈鱼', '2g', '否'],
        ['蒜蓉西兰花', '3g', '否'],
      ],
    });
    expect(n?.answers).toEqual([]);
  });

  it('★ 行比列长时截断、比列短时补空 —— 否则调用方会错列', () => {
    const content = tableOf(
      normalizeArtifact({
        kind: 'table',
        table: {
          columns: ['A', 'B', 'C'],
          rows: [
            ['a1', 'b1', 'c1', '多余的第四列'],
            ['a2'],
          ],
        },
      }),
    );

    expect(content.rows[0]).toEqual(['a1', 'b1', 'c1']);
    expect(content.rows[1]).toEqual(['a2', '', '']);
  });

  it('只有 items 时用「键的并集」当列，不漏列', () => {
    // 模型常见的偷懒写法：第一行少写一个字段
    const content = tableOf(
      normalizeArtifact({
        kind: 'table',
        items: [
          { 菜品: '清蒸鱼', 用油: '2g' },
          { 菜品: '西兰花', 用油: '3g', 备注: '需焯水' },
        ],
      }),
    );

    expect(content.columns).toEqual(['菜品', '用油', '备注']);
    expect(content.rows[0]).toEqual(['清蒸鱼', '2g', '']);
    expect(content.rows[1]).toEqual(['西兰花', '3g', '需焯水']);
  });

  it('空表格 → null（不制造空产出物）', () => {
    expect(normalizeArtifact({ kind: 'table', table: { columns: [], rows: [] } })).toBeNull();
    expect(normalizeArtifact({ kind: 'table' })).toBeNull();
  });
});

describe('normalizeArtifact —— quiz（题目与答案分离）', () => {
  it('★★ 产出物里没有答案字段（安全属性的核心断言）', () => {
    const n = normalizeArtifact({
      kind: 'quiz',
      quiz: [
        {
          stem: '以下哪种烹饪方式用油最少？',
          options: ['油炸', '清蒸', '红烧'],
          answer: 'B',
          explanation: '清蒸几乎不用油',
        },
      ],
    });

    // 答案在单独的数组里
    expect(n?.answers).toEqual([{ id: 'q1', correct: 'B', explanation: '清蒸几乎不用油' }]);

    // 产出物里的题目**只有这三个字段** —— 没有 answer / correct / explanation
    const questions = questionsOf(n);
    expect(questions).toHaveLength(1);
    const first = questions[0];
    if (first === undefined) throw new Error('题目缺失');
    expect(Object.keys(first).sort()).toEqual(['id', 'options', 'stem']);

    // 整个产出物序列化后也不能出现答案键
    const dumped = JSON.stringify(n?.artifact);
    expect(dumped).not.toContain('correct');
    expect(dumped).not.toContain('explanation');
  });

  it('★ 五种答案写法都能归一化成选项字母', () => {
    const cases: [string | number, string][] = [
      ['C', 'C'],
      ['c', 'C'],
      ['C. 红烧', 'C'],
      ['C、红烧', 'C'],
      [3, 'C'],
      ['红烧', 'C'],
    ];

    for (const [answer, expected] of cases) {
      const n = normalizeArtifact({
        kind: 'quiz',
        quiz: [
          {
            stem: '哪一个是红烧的做法？',
            options: ['油炸', '清蒸', '红烧'],
            answer,
          },
        ],
      });
      expect(n?.answers[0]?.correct, `答案写法 ${String(answer)} 应归一化为 ${expected}`).toBe(
        expected,
      );
    }
  });

  it('答案写成「选项原文的一部分」也能匹配', () => {
    const n = normalizeArtifact({
      kind: 'quiz',
      quiz: [
        {
          stem: '选一个',
          options: ['油炸（高油）', '清蒸（少油）'],
          answer: '清蒸',
        },
      ],
    });
    expect(n?.answers[0]?.correct).toBe('B');
  });

  it('★ 没有可判定答案的题被丢弃 —— 宁可少一题，也不给错判', () => {
    const questions = questionsOf(
      normalizeArtifact({
        kind: 'quiz',
        quiz: [
          { stem: '有答案的题', options: ['甲', '乙'], answer: 'A' },
          { stem: '没给答案的题', options: ['甲', '乙'] },
          { stem: '答案对不上的题', options: ['甲', '乙'], answer: '完全不存在' },
          { stem: '只有一个选项的题', options: ['甲'], answer: 'A' },
        ],
      }),
    );

    expect(questions).toHaveLength(1);
    expect(questions[0]?.stem).toBe('有答案的题');
  });

  it('选项自带 `A.` 前缀会被去掉（否则界面显示「A. A. 油炸」）', () => {
    const questions = questionsOf(
      normalizeArtifact({
        kind: 'quiz',
        quiz: [
          {
            stem: '选一个',
            options: ['A. 油炸', 'B、清蒸', '1) 红烧'],
            answer: 'B',
          },
        ],
      }),
    );
    expect(questions[0]?.options).toEqual(['油炸', '清蒸', '红烧']);
  });

  it('题目塞在 items 里也能读出来（模型常见写法）', () => {
    const n = normalizeArtifact({
      kind: 'quiz',
      items: [
        { question: '第一题', choices: ['甲', '乙'], correct: 'A' },
        { question: '第二题', choices: ['甲', '乙'], correct: 2 },
      ],
    });

    expect(questionsOf(n).map((q) => q.stem)).toEqual(['第一题', '第二题']);
    expect(n?.answers.map((a) => a.correct)).toEqual(['A', 'B']);
  });

  it('混合题型：简答题只把 reference/rubric 放进答案卷', () => {
    const n = normalizeArtifact({
      kind: 'quiz',
      quiz: [
        { stem: '选择题', options: ['甲', '乙'], answer: 'A' },
        {
          stem: '简答题',
          type: 'short',
          points: 5,
          answer: '这是答案',
          rubric: '要点齐全',
        },
      ],
    });
    expect(n?.answers[1]).toMatchObject({
      id: 'q2',
      reference: '这是答案',
      rubric: '要点齐全',
      points: 5,
    });
    const questions = questionsOf(n);
    expect(questions[1]).toMatchObject({ type: 'short', options: [], points: 5 });
    expect(JSON.stringify(questions)).not.toContain('这是答案');
    expect(JSON.stringify(questions)).not.toContain('要点齐全');
  });

  it('一道有效题都没有 → null', () => {
    expect(normalizeArtifact({ kind: 'quiz', quiz: [] })).toBeNull();
    expect(normalizeArtifact({ kind: 'quiz' })).toBeNull();
  });
});

describe('normalizeArtifact —— 向后兼容（text / list / plan 行为不变）', () => {
  it('text：保留整段文本', () => {
    const n = normalizeArtifact({ kind: 'text', content: '一句话结论' });
    expect(n?.artifact).toEqual({ kind: 'text', content: '一句话结论' });
    expect(n?.answers).toEqual([]);
  });

  it('list：items 变字符串数组（不再返回"按换行切的字符串"）', () => {
    const n = normalizeArtifact({ kind: 'list', items: ['第一条', '第二条'] });
    expect(n?.artifact).toEqual({ kind: 'list', content: ['第一条', '第二条'] });
  });

  it('plan：标题与 items 合并成数组', () => {
    const n = normalizeArtifact({ kind: 'plan', title: '步骤', items: ['备菜', '下锅'] });
    expect(n?.artifact).toEqual({ kind: 'plan', content: ['步骤', '备菜', '下锅'] });
  });

  it('`type` 别名与 `kind` 等价', () => {
    const n = normalizeArtifact({ type: 'list', items: ['甲'] });
    expect(n?.artifact.kind).toBe('list');
  });

  it('空产出 → null', () => {
    expect(normalizeArtifact({})).toBeNull();
    expect(normalizeArtifact({ kind: 'text', content: '   ' })).toBeNull();
    expect(normalizeArtifact({ kind: 'list', items: [] })).toBeNull();
  });
});
