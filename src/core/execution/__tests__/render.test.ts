/**
 * 产出物渲染器验证（v8 批次A）。
 *
 * ★★ 这个文件存在的理由，是守住一个**已经发生过**的静默降级：
 *
 *   在 `table`/`quiz` 出现之前，8 处调用方各自写着同一个"聪明"写法：
 *     `Array.isArray(a.content) ? a.content.join('；') : String(a.content)`
 *   它对新两种形态都会产出 `[object Object]` —— 不报错、不崩，
 *   但监督员复核与反思从此读到一堆垃圾。
 *
 *   所以这里有一条**跨全部 kind 的回归守卫**：任何产出物渲染结果都不得含
 *   `[object Object]`。以后再加产出物种类，这条会立刻抓到漏改的渲染分支。
 */

import { describe, expect, it } from 'vitest';

import { artifactToText, renderArtifact } from '../render.js';
import type { ExecutionArtifact } from '../types.js';

/** 覆盖**全部** kind —— 新增 kind 时这里会因穷举而需要补一条 */
const ALL_KINDS: readonly ExecutionArtifact[] = [
  { kind: 'text', content: '一句话结论' },
  { kind: 'list', content: ['第一条', '第二条'] },
  { kind: 'plan', content: ['备菜', '下锅'] },
  {
    kind: 'table',
    content: {
      columns: ['菜品', '用油'],
      rows: [
        ['清蒸鲈鱼', '2g'],
        ['蒜蓉西兰花', '3g'],
      ],
    },
  },
  {
    kind: 'quiz',
    content: [
      { id: 'q1', stem: '哪种烹饪用油最少？', options: ['油炸', '清蒸'] },
      { id: 'q2', stem: '花生过敏要避开？', options: ['花生酱', '西兰花'] },
    ],
  },
  { kind: 'file', content: { name: '菜单.docx', ref: 'artifact_7' } },
];

describe('renderArtifact', () => {
  it('text：原样返回', () => {
    expect(renderArtifact({ kind: 'text', content: '结论' })).toEqual({
      text: '结论',
      itemCount: 1,
    });
  });

  it('list / plan：一行一条，itemCount = 条数', () => {
    expect(renderArtifact({ kind: 'list', content: ['甲', '乙', '丙'] })).toEqual({
      text: '甲\n乙\n丙',
      itemCount: 3,
    });
    expect(renderArtifact({ kind: 'plan', content: ['step1'] }).itemCount).toBe(1);
  });

  it('★ table：渲染成 Markdown 表格，itemCount = 行数', () => {
    const r = renderArtifact(ALL_KINDS[3] as ExecutionArtifact);
    expect(r.itemCount).toBe(2);
    expect(r.text).toBe(
      ['| 菜品 | 用油 |', '| --- | --- |', '| 清蒸鲈鱼 | 2g |', '| 蒜蓉西兰花 | 3g |'].join('\n'),
    );
  });

  it('table：单元格里的 `|` 被转义（否则会把表格撑破列）', () => {
    const r = renderArtifact({
      kind: 'table',
      content: { columns: ['公式'], rows: [['a | b']] },
    });
    expect(r.text).toContain('a \\| b');
  });

  it('★ quiz：渲染题干与选项，且**不含答案**', () => {
    const r = renderArtifact(ALL_KINDS[4] as ExecutionArtifact);
    expect(r.itemCount).toBe(2);
    expect(r.text).toBe(
      [
        '1. 哪种烹饪用油最少？',
        '   A. 油炸',
        '   B. 清蒸',
        '',
        '2. 花生过敏要避开？',
        '   A. 花生酱',
        '   B. 西兰花',
      ].join('\n'),
    );
    // 渲染结果里不该出现答案相关的字样
    expect(r.text).not.toContain('正确');
    expect(r.text).not.toContain('答案');
  });

  it('file：用文件名展示，不用内部引用当主信息', () => {
    const r = renderArtifact({ kind: 'file', content: { name: '菜单.docx', ref: 'artifact_7' } });
    expect(r.text).toContain('菜单.docx');
  });

  it('★★ 回归守卫：任何 kind 都不得渲染出 `[object Object]`', () => {
    for (const artifact of ALL_KINDS) {
      const { text } = renderArtifact(artifact);
      expect(text, `kind=${artifact.kind} 渲染出了 [object Object]`).not.toContain(
        '[object Object]',
      );
      // 也不能渲染成空串（那同样是静默丢失）
      expect(text.length, `kind=${artifact.kind} 渲染为空`).toBeGreaterThan(0);
    }
  });
});

describe('artifactToText', () => {
  it('★ 全部 kind 都不得产出 `[object Object]`（8 处调用方的共同守卫）', () => {
    for (const artifact of ALL_KINDS) {
      expect(
        artifactToText(artifact, '；'),
        `kind=${artifact.kind} 渲染出了 [object Object]`,
      ).not.toContain('[object Object]');
    }
  });

  it('list / plan 保留调用方指定的分隔符', () => {
    const list: ExecutionArtifact = { kind: 'list', content: ['甲', '乙'] };
    expect(artifactToText(list, '；')).toBe('甲；乙');
    expect(artifactToText(list)).toBe('甲\n乙');
    expect(artifactToText(list, ' | ')).toBe('甲 | 乙');
  });

  it('table / quiz 的分隔符由渲染器自己决定（结构不能按分隔符拆）', () => {
    const table = ALL_KINDS[3] as ExecutionArtifact;
    // 无论传什么分隔符，表格都是完整的 Markdown 表格
    expect(artifactToText(table, '；')).toBe(artifactToText(table, '\n'));
  });

  it('text 原样返回', () => {
    expect(artifactToText({ kind: 'text', content: '结论' }, '；')).toBe('结论');
  });
});
