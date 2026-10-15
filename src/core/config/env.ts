/**
 * 环境配置 —— 集中读取环境变量
 *
 * 设计依据：规则要求「环境配置：完整配置说明（**含环境变量模板**）」
 *
 * ★★ 为什么要有这个文件（这是一个真实问题的修复）：
 *
 *   之前 `.env.example` 声明了 17 个变量，而**代码只读了 2 个**。
 *   其余 15 个（`FITNESS_EMA_ALPHA`、`MAX_ROUNDS_PER_SESSION`、
 *   `TOOL_TIMEOUT_MS` …）改了**没有任何作用** —— 真实值硬编码在代码里。
 *
 *   ⚠️ 一个「看起来完整但不起作用」的模板，比没有模板更糟：
 *      使用者改了变量发现无效，会直接质疑配置说明是否真实。
 *
 * ★ 三条纪律：
 *
 *   ① **默认值一律等于原硬编码值**
 *      这个改动不改变任何现有行为 —— 只是让「想改的时候能改」。
 *      任何默认值的漂移都会让既有测试与验证脚本失去意义。
 *
 *   ② **解析失败退回默认值，不抛错**
 *      环境变量是给人手填的，写错一个数字不该让整个服务起不来。
 *      但要**记下问题**（`problems`），由 `butler doctor` 展示出来。
 *      静默吞掉错误和直接崩掉，都是坏选择。
 *
 *   ③ **变量名集中在这里**
 *      读 env 散落在各处时，"到底有哪些可配项"没有单一答案 ——
 *      而模板文件与代码会各自漂移，正是上面那个问题的成因。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ═══════════════════════════════════════════════════════════
// 读取原语
// ═══════════════════════════════════════════════════════════

export interface ConfigProblem {
  readonly key: string;
  readonly raw: string;
  readonly why: string;
  readonly usedInstead: string;
}

const problems: ConfigProblem[] = [];

/** 本次进程内解析出的问题（供 `butler doctor` 展示）。 */
export function configProblems(): readonly ConfigProblem[] {
  return problems;
}

function raw(key: string): string | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function num(key: string, fallback: number, opts?: { readonly min?: number; readonly max?: number }): number {
  const s = raw(key);
  if (s === undefined) return fallback;

  const n = Number(s);
  if (!Number.isFinite(n)) {
    problems.push({ key, raw: s, why: '不是有效数字', usedInstead: String(fallback) });
    return fallback;
  }
  if (opts?.min !== undefined && n < opts.min) {
    problems.push({ key, raw: s, why: `小于最小值 ${opts.min}`, usedInstead: String(fallback) });
    return fallback;
  }
  if (opts?.max !== undefined && n > opts.max) {
    problems.push({ key, raw: s, why: `大于最大值 ${opts.max}`, usedInstead: String(fallback) });
    return fallback;
  }
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const s = raw(key)?.toLowerCase();
  if (s === undefined) return fallback;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  problems.push({ key, raw: s, why: '不是布尔值（true/false）', usedInstead: String(fallback) });
  return fallback;
}

function str(key: string, fallback: string): string {
  return raw(key) ?? fallback;
}

function optStr(key: string): string | undefined {
  return raw(key);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════
// 模型服务
// ═══════════════════════════════════════════════════════════

export const modelConfig = {
  get apiKey(): string {
    return str('DEEPSEEK_API_KEY', '');
  },
  get baseUrl(): string {
    return str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com');
  },
} as const;

/**
 * 视觉模型（预留）。
 *
 * ⚠️ 这三个变量**当前未接入**，如实说明：
 *    多模态走的是主模型自身的视觉能力（实测 `deepseek-chat` 可读图，
 *    `deepseek-v4-pro` **不可** —— 见验证 3 的实测记录）。
 *
 *    留着它们是给"将来接独立视觉模型"预备位置。
 *    **写明"预留"比假装支持好** —— 后者会让人配了却不见效。
 */
export const visionConfig = {
  get reserved(): true {
    return true;
  },
  get apiKey(): string | undefined {
    return optStr('VISION_API_KEY');
  },
  get baseUrl(): string | undefined {
    return optStr('VISION_BASE_URL');
  },
  get model(): string | undefined {
    return optStr('VISION_MODEL');
  },
} as const;

// ═══════════════════════════════════════════════════════════
// 编排
// ═══════════════════════════════════════════════════════════

export const routingConfig = {
  /** 低于此置信度不猜测，转为询问用户（方案 § 2.2①） */
  get confidenceThreshold(): number {
    // ⚠️ 上限 1 —— 阈值大于 1 会让**所有**路由都转询问，服务等于不可用
    return num('ROUTING_CONFIDENCE_THRESHOLD', 0.6, { min: 0, max: 1 });
  },
} as const;

// ═══════════════════════════════════════════════════════════
// 记忆演化（方案 § 8.4）
// ═══════════════════════════════════════════════════════════

export const memoryConfig = {
  /** EMA 平滑系数 α。越小越"渐变"，越不容易被单次事件影响 */
  get emaAlpha(): number {
    // ⚠️ 上限 1，且不能为 0 —— 0 会让适应度永不更新
    return num('FITNESS_EMA_ALPHA', 0.15, { min: 0.001, max: 1 });
  },

  /** 连续未命中多少天后进入休眠 */
  get dormantAfterMs(): number {
    const days = num('MEMORY_DORMANT_DAYS', 60, { min: 1 });
    return days * DAY_MS;
  },

  /** 适应度低于此值且长期休眠则归档 */
  get archiveBelowFitness(): number {
    return num('MEMORY_ARCHIVE_FITNESS_THRESHOLD', 0.25, { min: 0, max: 1 });
  },

  /** 探索性召回比例（防局部最优，方案 § 8.5） */
  get exploratoryRatio(): number {
    return num('EXPLORATORY_RECALL_RATIO', 0.1, { min: 0, max: 1 });
  },
} as const;

// ═══════════════════════════════════════════════════════════
// 成本与安全熔断
// ═══════════════════════════════════════════════════════════

export const limitsConfig = {
  /** 单会话最大推理轮次 */
  get maxRoundsPerSession(): number {
    // ⚠️ 下限 1：0 会让工具循环一次都不跑
    return num('MAX_ROUNDS_PER_SESSION', 8, { min: 1 });
  },

  /** 全局日额度上限（元） */
  get dailyBudgetCny(): number {
    return num('DAILY_BUDGET_CNY', 20, { min: 0 });
  },

  /** 单次命令类工具的执行耗时上限（毫秒） */
  get toolTimeoutMs(): number {
    // ⚠️ 下限 1000 —— 太短的超时会让所有命令都失败，看起来像"工具坏了"
    return num('TOOL_TIMEOUT_MS', 15_000, { min: 1000 });
  },

  /** 定时任务每日耗 token 的次数上限 */
  get dailyTokenTaskLimit(): number {
    return num('DAILY_TOKEN_TASK_LIMIT', 10, { min: 0 });
  },
} as const;

// ═══════════════════════════════════════════════════════════
// 隐私（方案 § 7.3）
// ═══════════════════════════════════════════════════════════

export const privacyConfig = {
  /**
   * 行为观察开关。
   *
   * ⚠️ 这是**默认值来源**，不是"放宽开关"——
   *    采集边界（采什么、存多久、聚合后原文即删）写死在代码里，
   *    不由此变量放宽。开着这个变量也只是回到默认关闭状态。
   */
  get behaviorObservationEnabled(): boolean {
    return bool('BEHAVIOR_OBSERVATION_ENABLED', false);
  },

  /** 原始活动记录保留天数（0 = 永久保留） */
  get activityRawRetentionDays(): number {
    return num('ACTIVITY_RAW_RETENTION_DAYS', 7, { min: 0 });
  },
} as const;

// ═══════════════════════════════════════════════════════════
// 本地存储
// ═══════════════════════════════════════════════════════════

export const storageConfig = {
  /**
   * 本地优先：数据默认不出设备。
   *
   * ⚠️ 当前**恒为 true 的语义** —— 事件流与记忆只写本地 JSONL，
   *    代码里没有任何"上传到远端"的路径。
   *    这个变量是给将来引入云端同步时用的开关位置。
   */
  get localFirst(): boolean {
    return bool('LOCAL_FIRST', true);
  },

  /** 导出文件是否包含凭证（默认排除）。true 时必须提供加密口令 */
  get exportIncludeCredentials(): boolean {
    return bool('EXPORT_INCLUDE_CREDENTIALS', false);
  },

  /** 数据目录 */
  get dataDir(): string {
    return str('BUTLER_DATA_DIR', join(process.cwd(), '.butler-data'));
  },

  /** 默认用户 id */
  get userId(): string {
    return str('BUTLER_USER_ID', 'local');
  },
} as const;

// ═══════════════════════════════════════════════════════════
// 环境文件加载
// ═══════════════════════════════════════════════════════════

/**
 * 载入 `.env.local`（若存在）。
 *
 * ★ 为什么自己加载而不靠 `next dev`：
 *   `butler doctor` 需要在**不启动 Next** 的情况下检查环境变量。
 *   依赖框架加载的话，"自检"就必须先把服务跑起来 —— 那是本末倒置。
 *
 * ⚠️ 用 Node 内建 `process.loadEnvFile`（20.12+），不引入 dotenv：
 *    这是唯一的用途，多一个依赖不值得。
 */
export function loadEnvFile(dir: string = process.cwd()): {
  readonly loaded: boolean;
  readonly path: string;
} {
  const path = join(dir, '.env.local');
  if (!existsSync(path)) return { loaded: false, path };

  try {
    process.loadEnvFile(path);
    return { loaded: true, path };
  } catch (err) {
    problems.push({
      key: '.env.local',
      raw: path,
      why: `读取失败：${err instanceof Error ? err.message : String(err)}`,
      usedInstead: '环境变量（未从文件加载）',
    });
    return { loaded: false, path };
  }
}

// ═══════════════════════════════════════════════════════════
// 一致性自检
// ═══════════════════════════════════════════════════════════

/** 本模块认识的全部环境变量名（供 doctor 与模板一致性检查用）。 */
export const KNOWN_KEYS: readonly string[] = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'VISION_API_KEY',
  'VISION_BASE_URL',
  'VISION_MODEL',
  'ROUTING_CONFIDENCE_THRESHOLD',
  'FITNESS_EMA_ALPHA',
  'MEMORY_DORMANT_DAYS',
  'MEMORY_ARCHIVE_FITNESS_THRESHOLD',
  'EXPLORATORY_RECALL_RATIO',
  'MAX_ROUNDS_PER_SESSION',
  'DAILY_BUDGET_CNY',
  'TOOL_TIMEOUT_MS',
  'DAILY_TOKEN_TASK_LIMIT',
  'BEHAVIOR_OBSERVATION_ENABLED',
  'ACTIVITY_RAW_RETENTION_DAYS',
  'LOCAL_FIRST',
  'EXPORT_INCLUDE_CREDENTIALS',
  'BUTLER_DATA_DIR',
  'BUTLER_USER_ID',
];

/**
 * **已声明但尚未接入**的变量。
 *
 * ★ 为什么要单独列出，而不是从 `KNOWN_KEYS` 删掉：
 *
 *   · 它们标明了「将来接这个能力时该放哪儿」的位置
 *   · 而 `KNOWN_KEYS` 是模板一致性检查的依据 ——
 *     删掉会导致检查认为模板"多余"，反而把预留位也清掉
 *
 * ⚠️ 这些变量**填了不生效**。模板里必须明确标注，
 *    否则使用者配了却不见效，会怀疑整份配置说明的真实性。
 *
 * ★ 纪律：一个变量从本集合移出，必须同时满足两条 ——
 *   ① 有代码真的消费它  ② `.env.example` 里它是**活跃**行（非注释）
 */
export const RESERVED_KEYS: readonly string[] = [
  /** 独立视觉模型 —— 当前走主模型自身视觉能力 */
  'VISION_API_KEY',
  'VISION_BASE_URL',
  'VISION_MODEL',
  /** 日额度（元）—— 当前额度机制按「次数」而非「金额」计（见 DAILY_TOKEN_TASK_LIMIT）*/
  'DAILY_BUDGET_CNY',
  /** 行为观察默认开关 —— 读取器已就绪，但观察器尚未接进 bootstrap */
  'BEHAVIOR_OBSERVATION_ENABLED',
  /** 云端同步 —— 当前恒为本地，代码里没有上传路径 */
  'LOCAL_FIRST',
  /** 导出含凭证 —— 导出功能尚未实现 */
  'EXPORT_INCLUDE_CREDENTIALS',
];
