/**
 * 预算档位表验证（v8 · 两档）
 *
 * ★ 这里守的不是"数字对不对"，而是**方案 §14 / D-26 / D-28 / D-30 的四条约束**：
 *   · 只有两档（简洁 / 标准），且每档都完整
 *   · 标准档 = 沿用 DSH；简洁档 = 标准档的一半（摘要目标按 ~4% 单独推算）
 *   · `maxOutputTokens` **按档位区分**（标准 256,000 / 简洁 128,000，D-28）
 *   · 历史单条消息不设上限（D-30）；工具轮次已从字段层彻底删除
 *
 * ⚠️ 以及一条容易漏的**安全性**：档位从持久化数据来，
 *    未知值必须**退回标准档**而不是抛错 —— 旧/损坏数据不该让会话打不开。
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_BUDGET_TIERS,
  BUDGET_TIER_LABEL,
  DEFAULT_BUDGET_TIER,
  DEFAULT_HISTORY_TOKEN_BUDGET,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_SUMMARY_MAX_TOKENS,
  DEFAULT_SUMMARY_TARGET_CHARS,
  DEFAULT_TOOL_RESULT_CHAR_LIMIT,
  SHARED_BUDGET,
  budgetProfileOf,
  isBudgetTier,
} from '../budget.js';
import type { BudgetTier } from '../budget.js';

/** 真的随档位变的字段（`maxHistoryChars` 已移到 SHARED，不在此列） */
const TIERED_FIELDS = [
  'historyTokenBudget',
  'toolOutputPruneChars',
  'toolOutputKeepHead',
  'toolOutputKeepTail',
  'summaryTargetChars',
  'summaryMaxTokens',
  'maxOutputTokens',
] as const satisfies readonly (keyof ReturnType<typeof budgetProfileOf>)[];

describe('预算档位 · 结构', () => {
  it('恰好两档（简洁 / 标准），且每档有中文名', () => {
    expect(ALL_BUDGET_TIERS).toEqual(['lean', 'standard']);
    for (const tier of ALL_BUDGET_TIERS) {
      expect(BUDGET_TIER_LABEL[tier].length).toBeGreaterThan(0);
    }
    expect(BUDGET_TIER_LABEL.lean).toBe('简洁');
    expect(BUDGET_TIER_LABEL.standard).toBe('标准');
  });

  it('★ 每档的每个字段都有值（缺字段会让调用处拿到 undefined）', () => {
    for (const tier of ALL_BUDGET_TIERS) {
      const p = budgetProfileOf(tier);
      for (const f of TIERED_FIELDS) {
        expect(typeof p[f], `${tier}.${f} 不是数字`).toBe('number');
        expect(p[f], `${tier}.${f} 不是正数`).toBeGreaterThan(0);
      }
    }
  });
});

describe('预算档位 · D-28：maxOutputTokens 按档位区分', () => {
  it('★ 标准档 256,000 / 简洁档 128,000（后者是前者的一半）', () => {
    expect(budgetProfileOf('standard').maxOutputTokens).toBe(256_000);
    expect(budgetProfileOf('lean').maxOutputTokens).toBe(128_000);
    expect(budgetProfileOf('lean').maxOutputTokens * 2).toBe(
      budgetProfileOf('standard').maxOutputTokens,
    );
  });

  it('★ 其余随档位变的字段，简洁档都应是标准档的一半（摘要目标除外）', () => {
    const lean = budgetProfileOf('lean');
    const standard = budgetProfileOf('standard');

    // 这几个是严格的 1/2
    for (const f of [
      'historyTokenBudget',
      'toolOutputPruneChars',
      'toolOutputKeepHead',
      'toolOutputKeepTail',
      'summaryMaxTokens',
    ] as const) {
      expect(lean[f] * 2, `${f} 不是标准档的一半`).toBe(standard[f]);
    }

    // 摘要目标按"保留预算的 ~4%"独立推算，不强行折半
    expect(lean.summaryTargetChars).toBeLessThan(standard.summaryTargetChars);
  });
});

describe('预算档位 · 标准档 = 沿用 DSH', () => {
  it('标准档与 DSH 默认值逐项一致', () => {
    const s = budgetProfileOf('standard');
    expect(s.historyTokenBudget).toBe(160_000); // DSH retainRatio 0.16 x 1M
    expect(s.toolOutputPruneChars).toBe(8_192); // DSH pruner threshold
    expect(s.toolOutputKeepHead).toBe(4_096);
    expect(s.toolOutputKeepTail).toBe(1_024);
    expect(s.summaryMaxTokens).toBe(65_536); // DSH maxTokens = headroomTokens
    expect(s.maxOutputTokens).toBe(256_000); // DSH DEFAULT_MAX_TOKENS
  });

  it('共用参数与 DSH 一致', () => {
    expect(SHARED_BUDGET.contextWindowTokens).toBe(1_000_000);
    expect(SHARED_BUDGET.compactionThresholdRatio).toBe(0.8);
    expect(SHARED_BUDGET.compactionHeadroomTokens).toBe(65_536);
    expect(SHARED_BUDGET.compactionRetries).toBe(1);
    expect(SHARED_BUDGET.overflowRetries).toBe(1);
  });
});

describe('预算档位 · D-30：历史单条消息不设上限', () => {
  it('★ 历史里单条消息不设上限（两档都是 null）', () => {
    expect(SHARED_BUDGET.maxHistoryChars).toBeNull();
  });

  it('「不设上限」不能退化成 0 或 undefined', () => {
    expect(SHARED_BUDGET.maxHistoryChars).not.toBe(0);
    expect(SHARED_BUDGET.maxHistoryChars).not.toBeUndefined();
  });
});

describe('预算档位 · 数值约束', () => {
  it('★ 摘要目标长度 ≤ 保留预算的 20%（否则压缩反而更贵）', () => {
    /**
     * 摘要是**每轮都要重发**的。如果摘要长度接近保留预算，
     * 每轮输入 = 保留 + 摘要 ≈ 两份原文，压缩就失去了意义。
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

  it('★ 摘要硬上限要显著大于摘要目标（否则等于没设安全阀）', () => {
    for (const tier of ALL_BUDGET_TIERS) {
      const p = budgetProfileOf(tier);
      expect(p.summaryMaxTokens).toBeGreaterThan(p.summaryTargetChars);
    }
  });
});

describe('预算档位 · 第一步的全局常量（方案 §14 落地顺序）', () => {
  it('★ 默认常量取「标准」档（第一步落地用）', () => {
    const s = budgetProfileOf('standard');
    expect(DEFAULT_HISTORY_TOKEN_BUDGET).toBe(s.historyTokenBudget);
    expect(DEFAULT_SUMMARY_TARGET_CHARS).toBe(s.summaryTargetChars);
    expect(DEFAULT_SUMMARY_MAX_TOKENS).toBe(s.summaryMaxTokens);
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(s.maxOutputTokens);
    expect(DEFAULT_TOOL_RESULT_CHAR_LIMIT).toBe(s.toolOutputPruneChars);
  });

  it('★ 旧值已全部退役（防止回退）', () => {
    // 这些是改造前的值，任何一个复现都说明有人把旧数字写回去了
    expect(DEFAULT_HISTORY_TOKEN_BUDGET).not.toBe(24_000);
    expect(DEFAULT_SUMMARY_TARGET_CHARS).not.toBe(1_200);
    expect(DEFAULT_SUMMARY_MAX_TOKENS).not.toBe(1_200);
    expect(DEFAULT_MAX_OUTPUT_TOKENS).not.toBe(3_072);
  });
});

describe('预算档位 · 持久化边界（不可信输入）', () => {
  it('未知档位退回标准档，不抛错', () => {
    const weird = ['wide', 'huge', '', 'STANDARD', 'null'] as unknown as BudgetTier[];
    for (const w of weird) {
      expect(() => budgetProfileOf(w)).not.toThrow();
      expect(budgetProfileOf(w).tier).toBe(DEFAULT_BUDGET_TIER);
    }
  });

  it('undefined 退回标准档', () => {
    expect(budgetProfileOf(undefined).tier).toBe('standard');
  });

  it('isBudgetTier 只认两个值', () => {
    expect(isBudgetTier('lean')).toBe(true);
    expect(isBudgetTier('standard')).toBe(true);
    expect(isBudgetTier('wide')).toBe(false);
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
