/**
 * 环境配置 —— 集中读取环境变量
 *
 * 设计依据：规则要求「环境配置：完整配置说明（**含环境变量模板**）」
 *
 * ★★ 为什么要有这个文件（这是一个真实问题的修复）：
 *
 *   之前 `.env.example` 声明了 17 个变量，而**代码只读了 2 个**。
 *   其余 15 个（`FITNESS_EMA_ALPHA`、`MEMORY_DORMANT_DAYS`、
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
  /**
   * 结构化调用用的模型（路由、分解、仆人、监督、反思）。
   *
   * ⚠️ 这个变量**之前被 deepseek.ts 直接读取，但没登记在这里、
   *    也不在 `.env.example` 里** —— 违反「变量名集中一处」的纪律。
   *    现在收回集中管理。
   */
  get model(): string {
    return str('DEEPSEEK_MODEL', 'deepseek-flash');
  },
  /** 单次模型调用超时（毫秒）。同样之前未登记。 */
  get timeoutMs(): number {
    return num('MODEL_TIMEOUT_MS', 90_000, { min: 1000 });
  },
  /**
   * ★ 叙述（流式"边说边想"）用的模型。
   *
   * ⚠️ 为什么与主模型分开配置：
   *    叙述是"轻活"（短、快），用便宜快的模型就够。
   *
   * ★ 2026-08 按**官方 Models & Pricing 文档**更正：
   *    官方只有两个模型 —— `deepseek-flash` 与 `deepseek-v4-pro`。
   *    · flash   ：便宜约 4—5 倍、**支持 Vision**、支持思考
   *    · v4-pro  ：贵、**不支持 Vision**、支持思考
   *
   * ⚠️ 这里原先写着 `deepseek-chat`「完全不产 reasoning_content」——
   *    **那条结论已删除**，理由两条：
   *      ① 该模型已不在官方清单里
   *      ② 当时那条"实测"很可能是假象：它的请求被 API
   *         **静默路由到 flash**，所以观测到的行为未必属于它。
   *         模型已下线，无法复核 —— 不能留着当依据。
   *
   *    ⚠️ 接错模型的后果**很隐蔽**：推理流永远是空的，且不报错。
   *       所以选模型要**以官方文档的能力表为准**，不要靠零散实测。
   */
  get narrationModel(): string {
    return str('NARRATION_MODEL', 'deepseek-flash');
  },
} as const;

/**
 * 视觉模型（预留）。
 *
 * ⚠️ 这三个变量**当前未接入**，如实说明：
 *    多模态走的是**主模型自身的视觉能力** ——
 *    按官方 Models & Pricing 文档：
 *      · `deepseek-flash`   ✓ 支持读图
 *      · `deepseek-v4-pro`  ✗ Not supported
 *
 *    ⚠️ 这段原先写的是"实测 `deepseek-chat` 可读图"——
 *       该模型已不在官方清单里，那条观测无法复核，已更正为官方文档结论。
 *
 *    留着这三个变量是给"将来接独立视觉模型"预备位置。
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

/**
 * 记忆检索参数。
 *
 * ★ 语义阈值默认 0.35：30 条跨场景 + 5 条负例的复测结果
 *   （0.40 命中 27/30，0.35 命中 29/30，负例误召回都 1/5）。
 *   允许用环境变量覆盖，但**不是**“调低就一定更好”。
 */
export const retrievalConfig = {
  get semanticThreshold(): number {
    return num('MEMORY_SEMANTIC_THRESHOLD', 0.35, { min: 0, max: 1 });
  },
  /**
   * 语义 top-k 补充通道的候选数（默认 3，0 关闭）。
   *
   * ⚠️ 与阈值分开：阈值决定“单靠语义就能进”的门槛；
   *    top-k 只负责把少量低分但可能相关的候选送进精排。
   */
  get semanticTopK(): number {
    // dev 集对比：topK=3 在 limit=8 下仍漏“火锅→减脂”；topK=5 才补进来，
    // 由精排过滤后负例没有增加（见 scripts/eval-recall.ts 的 dev/test 结果）。
    return Math.max(0, Math.floor(num('MEMORY_SEMANTIC_TOPK', 5, { min: 0, max: 10 })));
  },
  /** top-k 补充通道的语义下限；默认 0.30。 */
  get semanticFloor(): number {
    return num('MEMORY_SEMANTIC_FLOOR', 0.3, { min: 0, max: 1 });
  },
  /** 精排过滤阈值；低于它的软记忆会被丢弃，硬约束不受影响。 */
  get rerankMinRelevance(): number {
    return num('MEMORY_RERANK_MIN_RELEVANCE', 0.5, { min: 0, max: 1 });
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
// 记忆冲突检测（v10.5）
// ═══════════════════════════════════════════════════════════

export const conflictDetectionConfig = {
  /**
   * off    = 不检测（默认；不额外调用模型）
   * review = 只发现“可能冲突”，标记为待审；不自动裁决
   */
  get mode(): 'off' | 'review' {
    const s = raw('CONFLICT_DETECTION_MODE');
    if (s === undefined) return 'off';
    if (s === 'off' || s === 'review') return s;
    problems.push({
      key: 'CONFLICT_DETECTION_MODE',
      raw: s,
      why: '只能是 off / review',
      usedInstead: 'off',
    });
    return 'off';
  },
} as const;

// ═══════════════════════════════════════════════════════════
// 成本与安全熔断
// ═══════════════════════════════════════════════════════════

export const limitsConfig = {
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

  /** 操作范围熔断：统计窗口（毫秒） */
  get toolFuseWindowMs(): number {
    return num('TOOL_FUSE_WINDOW_MS', 60_000, { min: 1_000 });
  },

  /** 操作范围熔断：窗口内允许的非只读调用次数 */
  get toolFuseMaxWrites(): number {
    return num('TOOL_FUSE_MAX_WRITES', 30, { min: 1 });
  },

  /**
   * 单个定时任务的超时（毫秒）。
   *
   * ★ 默认 120s：高于单次模型调用默认的 90s（MODEL_TIMEOUT_MS），
   *   给本地聚合/写事件留出余量；超时后不再重试，避免后台无限占用。
   */
  get scheduleTaskTimeoutMs(): number {
    return num('SCHEDULE_TASK_TIMEOUT_MS', 120_000, { min: 1000 });
  },
} as const;

// ═══════════════════════════════════════════════════════════
// 监督员触发模式（v10 · D-35 / D-48）
// ═══════════════════════════════════════════════════════════

export const supervisionConfig = {
  /**
   * `manual`（默认）：主回合不自动调用监督员，由用户在轮次条按需发起；
   * `auto`：保留旧的每轮自动复核行为（测试/回退用）。
   *
   * ⚠️ 只影响“是否自动调用”；固定 `SUPERVISOR_SYSTEM` 与只读边界不变。
   */
  get mode(): 'auto' | 'manual' {
    const raw = (process.env['SUPERVISOR_MODE'] ?? 'manual').trim().toLowerCase();
    return raw === 'auto' ? 'auto' : 'manual';
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
  'MODEL_PROVIDER',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'MODEL_TIMEOUT_MS',
  'NARRATION_MODEL',
  'VISION_API_KEY',
  'VISION_BASE_URL',
  'VISION_MODEL',
  'ROUTING_CONFIDENCE_THRESHOLD',
  'MEMORY_SEMANTIC_THRESHOLD',
  'MEMORY_SEMANTIC_TOPK',
  'MEMORY_SEMANTIC_FLOOR',
  'MEMORY_RERANK_MIN_RELEVANCE',
  'FITNESS_EMA_ALPHA',
  'MEMORY_DORMANT_DAYS',
  'MEMORY_ARCHIVE_FITNESS_THRESHOLD',
  'EXPLORATORY_RECALL_RATIO',
  'CONFLICT_DETECTION_MODE',
  'DAILY_BUDGET_CNY',
  'TOOL_TIMEOUT_MS',
  'TOOL_FUSE_WINDOW_MS',
  'TOOL_FUSE_MAX_WRITES',
  'SUPERVISOR_MODE',
  'DAILY_TOKEN_TASK_LIMIT',
  'SCHEDULE_TASK_TIMEOUT_MS',
  'BEHAVIOR_OBSERVATION_ENABLED',
  'ACTIVITY_RAW_RETENTION_DAYS',
  'LOCAL_FIRST',
  'EXPORT_INCLUDE_CREDENTIALS',
  'BUTLER_DATA_DIR',
  'BUTLER_MODEL_DIR',
  'BUTLER_PERMISSION_MODE',
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
  /** 导出含凭证 —— 变量保留；当前导出路径明确不含凭证值，不读取此开关 */
  'EXPORT_INCLUDE_CREDENTIALS',
];
