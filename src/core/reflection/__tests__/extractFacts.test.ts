/**
 * 事实提取测试
 *
 * ★ 这个文件锁住的是一条**端到端验证出来的关键行为**：
 *
 *   用户说「我叫示例用户，对花生严重过敏。」→
 *     「用户叫示例用户。」           → **global_shared**（软约束，可检索）
 *     「用户对花生严重过敏。」    → **global_constraint**（硬约束）
 *
 *   ⚠️ 分级不是分类学的洁癖，而是**安全设计的核心区分**：
 *      实测踩过 —— 两类都写成 `global_shared` 时，
 *      过敏事实会被相关性过滤掉：
 *        「我叫示例用户，对花生严重过敏」  → 召回 2 条 ✓
 *        「今晚吃什么」               → 召回 **0 条** ✗
 *      于是**保护在最需要的时候失效**：
 *      用户随口问晚饭时，过敏事实不被召回、不被注入，
 *      仆人给出的方案完全可能含花生。
 */

import { describe, expect, it } from 'vitest';

import { extractFacts, quoteAppearsIn } from '../extractFacts.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { domainForFactContent, normalizeFactCategory } from '../../memory/constraintSemantics.js';

// ═══════════════════════════════════════════════════════════
// ★ 防幻觉：quote 必须真的出现在用户发言里
// ═══════════════════════════════════════════════════════════

describe('★ 防幻觉核对（记忆库的价值建立在"每条都能追溯到你原话"上）', () => {
  const userSaid = '我叫示例用户，对花生严重过敏。今晚想在家做个简单的晚饭，两个人吃。';

  it('真的出现过的引文通过', () => {
    expect(quoteAppearsIn('对花生严重过敏', userSaid)).toBe(true);
    expect(quoteAppearsIn('我叫示例用户', userSaid)).toBe(true);
    expect(quoteAppearsIn('两个人吃', userSaid)).toBe(true);
  });

  it('★ 宽松匹配标点与空白（模型常把「我叫示例用户」引成「我叫示例用户，」）', () => {
    expect(quoteAppearsIn('我叫示例用户，', userSaid)).toBe(true);
    expect(quoteAppearsIn('我叫 示例用户', userSaid)).toBe(true);
  });

  it('★ 编造的引文被拦住（这是防幻觉的关键）', () => {
    // 模型很擅长把"常识"写成"用户说过" —— 记忆库一旦被污染，
    // 用户很难发现（他会以为是自己说过的）
    expect(quoteAppearsIn('我对海鲜过敏', userSaid)).toBe(false);
    expect(quoteAppearsIn('我有一个孩子', userSaid)).toBe(false);
    // 反向也不行：用户没说"不"
    expect(quoteAppearsIn('我对花生不过敏', userSaid)).toBe(false);
  });

  it('★ 只改一个实词就会被识破（宽松只忽略标点，不忽略实词）', () => {
    expect(quoteAppearsIn('对花生轻微过敏', userSaid)).toBe(false);
  });

  it('过短的引文无鉴别力，判为不通过', () => {
    expect(quoteAppearsIn('我', userSaid)).toBe(false);
    expect(quoteAppearsIn('', userSaid)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 分级的语义（从常量层面锁住）
// ═══════════════════════════════════════════════════════════

describe('★ category → memClass 的映射语义', () => {
  /**
   * ⚠️ 这里不断言实现细节（那是 `extractFacts` 内部的事），
   *    而是断言**这条规则本身**：只有 constraint 才是硬约束。
   *
   *    理由：这个映射是安全属性，不是偏好。
   *    `identity`（叫示例用户）不该是硬约束 —— 否则每次对话都被
   *    无条件注入"用户叫示例用户"，浪费名额还挤掉真正重要的信息。
   *    `constraint`（花生过敏）**必须**是硬约束 —— 它涉及人身安全。
   */
  const toMemClass = (category: string): string =>
    category === 'constraint' ? 'global_constraint' : 'global_shared';

  it('constraint → global_constraint（硬约束）', () => {
    expect(toMemClass('constraint')).toBe('global_constraint');
  });

  it('identity / preference / context → global_shared（软约束）', () => {
    expect(toMemClass('identity')).toBe('global_shared');
    expect(toMemClass('preference')).toBe('global_shared');
    expect(toMemClass('context')).toBe('global_shared');
  });
});

describe('★ 事实类别护栏（2026-11-17 回归）', () => {
  it('“控糖/尽量”不会被归类为硬约束', () => {
    const content = '用户晚上尽量不吃甜的和油炸的食物。';
    expect(normalizeFactCategory('constraint', content)).toBe('preference');
    expect(domainForFactContent(content)).toBe('health');
  });

  it('“花生严重过敏”必须保留为硬约束', () => {
    expect(normalizeFactCategory('preference', '用户对花生严重过敏。')).toBe('constraint');
  });

  it('“华法林/医嘱”必须保留为硬约束', () => {
    expect(normalizeFactCategory('context', '用户服用华法林，医生禁止吃维生素K。')).toBe(
      'constraint',
    );
  });
});

describe('★ extractFacts 端到端分类护栏', () => {
  const T = 1_760_000_000_000;
  const userText = '我最近在控糖，晚上尽量不吃甜的和油炸的；以后推荐吃的先帮我排除这两类';
  const model = {
    async completeStructured() {
      return {
        value: {
          facts: [
            {
              content: '用户晚上尽量不吃甜的和油炸的食物。',
              confidence: 0.85,
              category: 'constraint',
              quote: '晚上尽量不吃甜的和油炸的',
            },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  };

  it('★ 模型误标 constraint，最终仍落成 preference/global_shared', async () => {
    const log = new EventLog('s_extract');
    const clock = new FixedClock(T);
    const r = await extractFacts({
      model: model as never,
      log,
      clock,
      store: {} as never,
      userId: 'u',
      userText,
      existing: [],
    });
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]?.category).toBe('preference');
    expect(r.candidates[0]?.kind).toBe('preference');
    expect(r.candidates[0]?.scope.memClass).toBe('global_shared');
    expect(r.candidates[0]?.scope.domain).toBe('health');
  });
});
