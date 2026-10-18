/**
 * 预算档位（v8 · 方案 §14「预算档位」的代码落点）
 *
 * ★★ 两档，语义很直接（方案 §14）：
 *
 *   | 档位 | 定义 |
 *   |---|---|
 *   | **标准** | **完全复用 DSH 的参数值** |
 *   | **简洁** | **部分值取 DSH 的一半** |
 *
 * ★ 三处「不设上限」（方案 §14 · D-30）：
 *
 *   · 工具循环轮次 —— DSH 无硬上限，我们也不设
 *   · 历史里单条消息长度 —— DSH 无此机制，我们也不设
 *   · 其余 DSH 没有上限的项，一律不设
 *
 *   ⚠️ 理由：**任务没干完就被轮次掐断，是功能失败，不是省钱。**
 *      上限该来自真实约束（成本熔断 / 上下文预算），不来自拍脑袋。
 *
 * ⚠️ 数值来源（见方案 §14「参数来源」）：
 *   · 标准档 = DSH `dsh-compaction-basic` / `dsh-compaction-tool-result-pruner` /
 *     `dsh-llm-deepseek` 的默认值，逐项照抄
 *   · 简洁档 = 上一行的一半（摘要目标长度除外，见下）
 *   · 摘要目标 = 保留预算的 ~4%（摘要若接近保留预算，压缩就白做了）
 */

/** 两档。用户的可见词汇就是这两个词（方案 D-26）。 */
export type BudgetTier = 'lean' | 'standard';

/** 档位的中文名（界面直接用，避免各处自己翻译） */
export const BUDGET_TIER_LABEL: Record<BudgetTier, string> = {
  lean: '简洁',
  standard: '标准',
};

/** 未指定时的默认档位 */
export const DEFAULT_BUDGET_TIER: BudgetTier = 'standard';

/**
 * 一套预算参数。
 *
 * ⚠️ **只放"真的随档位变"的字段**。
 *    "三档都不设上限"那几项放在 `SHARED_BUDGET` 里 ——
 *    否则每档都要重复写一遍 `null`，读者还要逐档比对数表才能确认"轮次是不是也不限"。
 */
export interface BudgetProfile {
  readonly tier: BudgetTier;

  /** 历史里保留多少 token 的**原文**（超出的进摘要）*/
  readonly historyTokenBudget: number;

  /** 工具输出剪枝阈值（字符）：超过就截断成"头 + 中略 + 尾" */
  readonly toolOutputPruneChars: number;

  /** 剪枝时**头部**保留多少字符 */
  readonly toolOutputKeepHead: number;

  /** 剪枝时**尾部**保留多少字符 */
  readonly toolOutputKeepTail: number;

  /** 摘要的**目标**长度（字）—— 提示词里写的那句"不超过 N 字" */
  readonly summaryTargetChars: number;

  /** 摘要的**硬上限**（token）—— API 的 `max_tokens`，只是安全阀 */
  readonly summaryMaxTokens: number;

  /** 单次调用的输出上限（token） */
  readonly maxOutputTokens: number;
}

/**
 * ★ 两档共用、**不随档位变**的参数。
 */
export const SHARED_BUDGET = {
  /** 上下文窗口（DSH 默认）*/
  contextWindowTokens: 1_000_000,
  /** 压力阈值（DSH 默认）*/
  compactionThresholdRatio: 0.8,
  /** 压力余量（DSH 默认）*/
  compactionHeadroomTokens: 65_536,
  /**
   * 压缩重试次数。
   *
   * ⚠️ **不按比例缩放** —— 它是**计数器**不是容量，"0.5 次重试"不存在。
   */
  compactionRetries: 1,
  /** 溢出恢复次数（DSH 默认）*/
  overflowRetries: 1,
  /**
   * 工具循环轮次上限。
   *
   * `null` = **不设上限**（方案 §14 / D-30）。DSH 也没有硬上限。
   * ⚠️ 不设上限不等于没有保护 —— 见 `SHARED_BUDGET` 下方的说明。
   */
  maxRounds: null as number | null,
  /**
   * 历史里单条消息的字符上限。
   *
   * `null` = **不设**（方案 §14 / D-30）。DSH 没有这个机制。
   * ⚠️ 800 字的旧值会把长回复砍掉，等于"先截消息、再压摘要"的双重压缩。
   */
  maxHistoryChars: null as number | null,
} as const;

/**
 * ★ 不设上限时的三道真实保护（不是靠轮次数兜底）：
 *
 *   1. **上下文预算** —— `planHistory` 从最新往前装，装不下才摘要
 *   2. **日成本熔断** —— `DAILY_BUDGET_CNY`
 *   3. **循环终止条件** —— 模型提交报告即结束；某轮无工具调用也结束
 */

/**
 * 两档的参数表。
 *
 * ★ 表驱动（而不是两组 `if`）：加档位 = 加一行，不动任何逻辑。
 */
const PROFILES: Record<BudgetTier, Omit<BudgetProfile, 'tier'>> = {
  standard: {
    // 全部照抄 DSH 默认值
    historyTokenBudget: 160_000,
    toolOutputPruneChars: 8_192,
    toolOutputKeepHead: 4_096,
    toolOutputKeepTail: 1_024,
    summaryTargetChars: 6_000,
    summaryMaxTokens: 65_536,
    maxOutputTokens: 256_000,
  },
  lean: {
    // 取标准档的一半（摘要目标长度按"保留预算的 ~4%"单独推算）
    historyTokenBudget: 80_000,
    toolOutputPruneChars: 4_096,
    toolOutputKeepHead: 2_048,
    toolOutputKeepTail: 512,
    summaryTargetChars: 3_000,
    summaryMaxTokens: 32_768,
    maxOutputTokens: 128_000,
  },
};

/** 取某档的完整参数。未知档位**退回标准档**（不抛错：档位是从持久化来的）*/
export function budgetProfileOf(tier: BudgetTier | undefined): BudgetProfile {
  const key = tier !== undefined && tier in PROFILES ? tier : DEFAULT_BUDGET_TIER;
  return { tier: key, ...PROFILES[key] };
}

/** 全部档位（供界面枚举）*/
export const ALL_BUDGET_TIERS: readonly BudgetTier[] = ['lean', 'standard'];

/** 该值是否是合法档位（解析持久化数据时用）*/
export function isBudgetTier(v: unknown): v is BudgetTier {
  return v === 'lean' || v === 'standard';
}

/**
 * ★ 第一步落地用：把「标准」档的关键值导出成**全局常量**。
 *
 * 方案 §14「落地顺序」第一步：先把标准档落到全局常量与各调用点。
 * 第二步（按预设分档）才改成随会话传入 —— 那时调用方从 `budgetProfileOf(session.tier)` 取。
 *
 * ⚠️ 有了这几个常量，调用点就**不要**再硬编码数字 ——
 *    否则第二步要一处一处去翻。
 */
const STANDARD = budgetProfileOf('standard');

/** 历史预算（标准档）*/
export const DEFAULT_HISTORY_TOKEN_BUDGET = STANDARD.historyTokenBudget;
/** 摘要目标长度（标准档，字）*/
export const DEFAULT_SUMMARY_TARGET_CHARS = STANDARD.summaryTargetChars;
/** 摘要硬上限（标准档，token）*/
export const DEFAULT_SUMMARY_MAX_TOKENS = STANDARD.summaryMaxTokens;
/** 单次调用输出上限（标准档，token）—— 所有模型调用共用 */
export const DEFAULT_MAX_OUTPUT_TOKENS = STANDARD.maxOutputTokens;
/** 单条工具结果进上下文的字符上限（标准档）*/
export const DEFAULT_TOOL_RESULT_CHAR_LIMIT = STANDARD.toolOutputPruneChars;
