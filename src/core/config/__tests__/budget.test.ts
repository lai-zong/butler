/**
 * 预算档位表验证（v8 · B1）
 *
 * ★ 这里守的不是"数字对不对"，而是**方案 D-26 / D-28 的两条约束**：
 *   · D-26：只有三档，且每档都完整（不能缺字段 → 调用处拿到 undefined）
 *   · D-28：`maxOutputTokens` **三档相同**（它是天花板不是成本手段）
 *
 * ⚠️ 以及一条容易漏的**安全性**：档位是从持久化数据来的，
 *    未知值必须**退回标准档**而不是抛错 —— 旧数据/损坏数据不该让会话打不开。
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_BUDGET_TIERS,
  BUDGET_TIER_LABEL,
  DEFAULT_BUDGET_TIER,
  SHARED_BUDGET,
  budgetProfileOf,
  isBudgetTier,
} from '../budget.js';
import type { BudgetTier } from '../budget.js';

describe('预算档位 · 结构', () => {
  it('恰好三档，且每档有中文名', () => {
    expect(ALL_BUDGET_TIERS).toHaveLength(3);
    for (const tier of ALL_BUDGET_TIERS) {
      expect(BUDGET_TIER_LABEL[tier].length).toBeGreaterThan(0);
    }
  });

  it('★ 每档的每个字段都有值（缺字段会让调用处拿到 undefined）', () => {
    const numericFields = [
      'historyTokenBudget',
      'toolOutputPruneChars',
      'toolOutputKeepHead',
      'toolOutputKeepTail',
      'maxHistoryChars',
      'maxRounds',
      'summaryTargetChars',
      'summaryMaxTokens',
      'maxOutputTokens',
    ] as const;

    for (const tier of ALL_BUDGET_TIERS) {
      const p = budgetProfileOf(tier);
      for (const f of numericFields) {
        expect(typeof p[f], `${tier}.${f} 不是数字`).toBe('number');
        expect(p[f], `${tier}.${f} 不是正数`).toBeGreaterThan(0);
      }
    }
  });
});

describe('预算档位 · 方案 D-28：maxOutputTokens 三档相同', () => {
  it('★ 三档的 maxOutputTokens 完全一致', () => {
    const values = ALL_BUDGET_TIERS.map((t) => budgetProfileOf(t).maxOutputTokens);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe(128_000);
  });

  it('★ 其余参数**必须**随档位递增（否则分档就没有意义）', () => {
    const lean = budgetProfileOf('lean');
    const standard = budgetProfileOf('standard');
    const wide = budgetProfileOf('wide');

    expect(lean.historyTokenBudget).toBeLessThan(standard.historyTokenBudget);
    expect(standard.historyTokenBudget).toBeLessThan(wide.historyTokenBudget);

    expect(lean.maxRounds).toBeLessThan(standard.maxRounds);
    expect(standard.maxRounds).toBeLessThan(wide.maxRounds);

    expect(lean.toolOutputPruneChars).toBeLessThan(standard.toolOutputPruneChars);
    expect(standard.toolOutputPruneChars).toBeLessThan(wide.toolOutputPruneChars);

    expect(lean.summaryTargetChars).toBeLessThan(standard.summaryTargetChars);
    expect(standard.summaryTargetChars).toBeLessThan(wide.summaryTargetChars);
  });
});

describe('预算档位 · 方案 §14 的数值约束', () => {
  it('★ 摘要目标长度 ≤ 保留预算的 20%（否则压缩反而更贵）', () => {
    /**
     * 摘要是**每轮都要重发**的。如果摘要长度接近保留预算，
     * 每轮输入 = 保留 + 摘要 ≈ 两份原文，压缩就失去了意义。
     *
     * 中文 1 字 ≈ 1 token，所以直接用字数比 token 预算。
     */
    for (const tier of ALL_BUDGET_TIERS) {
      const p = budgetProfileOf(tier);
      const ratio = p.summaryTargetChars / p.historyTokenBudget;
      expect(ratio, `${tier} 档摘要占保留预算 ${(ratio * 100).toFixed(1)}%`).toBeLessThan(0.2);
    }
  });

  it('★ 剪枝保留量必须小于剪枝阈值（否则"剪枝"不剪任何东西）', () => {
    for (const tier of ALL_BUDGET_TIERS) {
      const p = budgetProfileOf(tier);
      const kept = p.toolOutputKeepHead + p.toolOutputKeepTail;
      expect(kept, `${tier} 档保留 ${kept} ≥ 阈值 ${p.toolOutputPruneChars}`).toBeLessThan(
        p.toolOutputPruneChars,
      );
    }
  });

  it('宽裕档与 DSH 默认值一致（数值来源可追溯）', () => {
    const wide = budgetProfileOf('wide');
    expect(wide.historyTokenBudget).toBe(160_000); // DSH retainRatio 0.16 × 1M
    expect(wide.toolOutputPruneChars).toBe(8_192);
    expect(wide.toolOutputKeepHead).toBe(4_096);
    expect(wide.toolOutputKeepTail).toBe(1_024);
    expect(wide.maxOutputTokens).toBe(128_000); // DSH 256,000 的一半
  });

  it('三档共用参数与 DSH 一致', () => {
    expect(SHARED_BUDGET.contextWindowTokens).toBe(1_000_000);
    expect(SHARED_BUDGET.compactionThresholdRatio).toBe(0.8);
    expect(SHARED_BUDGET.compactionHeadroomTokens).toBe(65_536);
    expect(SHARED_BUDGET.compactionRetries).toBe(1);
  });
});

describe('预算档位 · 持久化边界（不可信输入）', () => {
  it('未知档位退回标准档，不抛错', () => {
    const weird = ['huge', '', 'STANDARD', 'null'] as unknown as BudgetTier[];
    for (const w of weird) {
      expect(() => budgetProfileOf(w)).not.toThrow();
      expect(budgetProfileOf(w).tier).toBe(DEFAULT_BUDGET_TIER);
    }
  });

  it('undefined 退回标准档', () => {
    expect(budgetProfileOf(undefined).tier).toBe('standard');
  });

  it('isBudgetTier 只认三个值', () => {
    expect(isBudgetTier('lean')).toBe(true);
    expect(isBudgetTier('standard')).toBe(true);
    expect(isBudgetTier('wide')).toBe(true);
    expect(isBudgetTier('huge')).toBe(false);
    expect(isBudgetTier(undefined)).toBe(false);
    expect(isBudgetTier(1)).toBe(false);
  });

  it('返回值是**新对象**（调用处改了不会污染表）', () => {
    const a = budgetProfileOf('standard');
    const b = budgetProfileOf('standard');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
