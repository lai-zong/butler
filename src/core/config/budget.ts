/**
 * 预算档位（v8 · 方案 §14「预算档位」的代码落点）
 *
 * ★★ 为什么要分档，而不是一套全局值：
 *
 *   不同工作面要的资源量不同 —— 出 10 道选择题与改一个代码文件，
 *   需要的上下文、剪枝阈值、工具轮次完全不是一个量级。
 *   一套值只能取"够大"，那就是**让轻任务为不存在的需求付费**。
 *
 * ★ 三条边界（方案 D-25 / D-26 / D-28）：
 *   ① 档位挂在**预设**上，不挂在 `domain` 上（领域只有三种用途，见 D-25）
 *   ② 用户只见三档，**看不到** `retainRatio` / `headroomTokens` 这类原始旋钮（D-26）
 *   ③ `maxOutputTokens` **三档相同** —— 它是天花板不是成本手段（D-28）
 *
 * ⚠️ 数值来源（不许当成拍脑袋，见方案 §14「参数来源」）：
 *   · 压力阈值 0.8、压力余量 65,536 —— **照抄 DSH** `dsh-compaction-basic` 默认值
 *   · 宽裕档 160,000 —— DSH `retainRatio = 0.16` × 1M 窗口
 *   · 宽裕档 8,192 / 4,096 / 1,024 —— DSH `dsh-compaction-tool-result-pruner` 默认值
 *   · 标准档 = DSH 的 1/2；精致档 = DSH 的 1/4
 *   · `maxOutputTokens = 128,000` = DSH 默认 256,000 的 1/2，
 *     **已实测 API 接受**（deepseek-flash 可到 262,144、deepseek-v4-pro 可到 131,072）
 *   · 摘要目标长度 = 对应保留预算的 7.5%—15%
 *     （摘要若接近保留预算，压缩就白做了 —— 每轮输入反而更贵）
 */

/** 三档。用户的可见词汇就是这三个词（D-26）。 */
export type BudgetTier = 'lean' | 'standard' | 'wide';

/** 档位的中文名（界面直接用，避免各处自己翻译） */
export const BUDGET_TIER_LABEL: Record<BudgetTier, string> = {
  lean: '精致',
  standard: '标准',
  wide: '宽裕',
};

/** 未指定时的默认档位 —— 与"无预设"的默认一致 */
export const DEFAULT_BUDGET_TIER: BudgetTier = 'standard';

/**
 * 一套预算参数。
 *
 * ⚠️ 字段名刻意与使用处一致，**不做额外抽象**：
 *    多一层 `{ limits: {...} }` 只会让调用处多写一次 `.limits`。
 */
export interface BudgetProfile {
  readonly tier: BudgetTier;

  /** 历史里保留多少 token 的**原文**（超出的进摘要）*/
  readonly historyTokenBudget: number;

  /** 工具输出剪枝阈值（字符）：超过就截断成"头 + 尾" */
  readonly toolOutputPruneChars: number;

  /** 剪枝时**头部**保留多少字符 */
  readonly toolOutputKeepHead: number;

  /** 剪枝时**尾部**保留多少字符 */
  readonly toolOutputKeepTail: number;

  /** 历史里单条消息的字符上限（防止一条超长回复挤掉其它轮次）*/
  readonly maxHistoryChars: number;

  /** 工具循环最大轮次 */
  readonly maxRounds: number;

  /** 摘要的**目标**长度（字）—— 提示词里写的那句"不超过 N 字" */
  readonly summaryTargetChars: number;

  /** 摘要的**硬上限**（token）—— API 的 `max_tokens`，只是安全阀 */
  readonly summaryMaxTokens: number;

  /** 单次调用的输出上限（token）—— **三档相同**，见 D-28 */
  readonly maxOutputTokens: number;
}

/**
 * ★ 三档共用、**不随档位变**的参数。
 *
 * ⚠️ 这些放在这里而不是放进 `BudgetProfile`，是为了让"哪些值会变"一眼可见：
 *    读代码的人不必逐档比对数表才能确认"压力阈值是不是也分档了"。
 */
export const SHARED_BUDGET = {
  /** 上下文窗口（与 DSH 一致）*/
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
} as const;

const MAX_OUTPUT = 128_000;

/**
 * 三档的参数表。
 *
 * ★ 表驱动（而不是三组 `if`）：加第四档 = 加一行，不动任何逻辑。
 */
const PROFILES: Record<BudgetTier, Omit<BudgetProfile, 'tier'>> = {
  lean: {
    historyTokenBudget: 40_000,
    toolOutputPruneChars: 2_048,
    toolOutputKeepHead: 1_024,
    toolOutputKeepTail: 256,
    maxHistoryChars: 1_200,
    maxRounds: 4,
    summaryTargetChars: 3_000,
    summaryMaxTokens: 16_384,
    maxOutputTokens: MAX_OUTPUT,
  },
  standard: {
    historyTokenBudget: 80_000,
    toolOutputPruneChars: 4_096,
    toolOutputKeepHead: 2_048,
    toolOutputKeepTail: 512,
    maxHistoryChars: 2_400,
    maxRounds: 8,
    summaryTargetChars: 6_000,
    summaryMaxTokens: 32_768,
    maxOutputTokens: MAX_OUTPUT,
  },
  wide: {
    historyTokenBudget: 160_000,
    toolOutputPruneChars: 8_192,
    toolOutputKeepHead: 4_096,
    toolOutputKeepTail: 1_024,
    maxHistoryChars: 4_800,
    maxRounds: 16,
    summaryTargetChars: 8_000,
    summaryMaxTokens: 65_536,
    maxOutputTokens: MAX_OUTPUT,
  },
};

/** 取某档的完整参数。未知档位**退回标准档**（不抛错：档位是从持久化来的）*/
export function budgetProfileOf(tier: BudgetTier | undefined): BudgetProfile {
  const key = tier !== undefined && tier in PROFILES ? tier : DEFAULT_BUDGET_TIER;
  return { tier: key, ...PROFILES[key] };
}

/** 全部档位（供界面枚举）*/
export const ALL_BUDGET_TIERS: readonly BudgetTier[] = ['lean', 'standard', 'wide'];

/** 该值是否是合法档位（解析持久化数据时用）*/
export function isBudgetTier(v: unknown): v is BudgetTier {
  return v === 'lean' || v === 'standard' || v === 'wide';
}
