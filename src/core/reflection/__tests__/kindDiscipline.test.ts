/**
 * 反思提示词里的**记忆类型纪律**（D-31 · A11 配套）
 *
 * ★ 为什么单独测提示词：
 *   schema 只说了"summary 是长内容汇总"，**没说什么时候该用**。
 *   没有准入条件，模型很容易每轮都产出一条长总结 ——
 *   而 summary 比原子条目长得多，污染召回上下文的代价更大。
 */
import { describe, expect, it } from 'vitest';

import { butlerReflectionSystem, domainReflectionSystem } from '../reflect.js';
import { reflectionSchema } from '../../prompts/schemas.js';

describe('★★ 两个系统提示词都写了 summary 的准入条件', () => {
  const prompts: Array<{ name: string; text: string }> = [
    { name: 'domainReflectionSystem', text: domainReflectionSystem('life') },
    { name: 'butlerReflectionSystem', text: butlerReflectionSystem() },
  ];

  for (const p of prompts) {
    it(`★ ${p.name} 提到四类记忆的名字与枚举值`, () => {
      expect(p.text).toContain('(fact)');
      expect(p.text).toContain('(preference)');
      expect(p.text).toContain('(principle)');
      expect(p.text).toContain('(summary)');
    });

    it(`★★ ${p.name} 明确"同一个任务不要产出 summary"`, () => {
      // 这是最关键的准入条件：单次任务的反思不该产出长期总结
      expect(p.text).toContain('同一个任务');
      expect(p.text).toContain('不要产出 summary');
    });

    it(`★★ ${p.name} 要求 summary 写清时间段/状态/成因/建议`, () => {
      expect(p.text).toContain('时间段');
      expect(p.text).toContain('成因');
    });

    it(`★ ${p.name} 限制数量（最多 1 条）`, () => {
      expect(p.text).toContain('最多 1 条');
    });
  }
});

describe('★ schema 的说明不再悬空', () => {
  it('kind 的 describe 指向了真实存在的章节，而不是"见下"', () => {
    const desc =
      reflectionSchema.shape.candidates.element.shape.kind.description ?? '';
    expect(desc).not.toContain('见下');
    // 指向提示词里真实存在的章节名
    expect(desc).toContain('记忆类型怎么选');
    // 而且那个章节确实存在
    expect(domainReflectionSystem('life')).toContain('记忆类型怎么选');
    expect(butlerReflectionSystem()).toContain('记忆类型怎么选');
  });

  it('summary 仍被 schema 接受（纪律不改变能力，只约束使用）', () => {
    const parsed = reflectionSchema.safeParse({
      candidates: [
        { kind: 'summary', content: 'x', confidence: 0.6, evidence: [], rationale: '' },
      ],
      collaborationIssues: [],
      rhythmChanges: [],
    });
    expect(parsed.success).toBe(true);
  });
});
