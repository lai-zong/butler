/**
 * 上下文压缩 —— 让"本次会话的上文"既看得全、又不失控
 *
 * ★★ 这个模块补的是 §3.1b「三层记忆」里最浅的一层。
 *
 *   此前的实现是**固定窗口**：只带最近 4 轮、每轮最多 800 字，
 *   超出**直接丢掉**。实测后果（`history.ts` 注释里记着真实对话）：
 *
 *     你（第二轮）：那今晚就按你说的做
 *     它：『按你说的做』指向此前某位仆人给出的方案，
 *         但**本次校验未收到该方案产出**，无法核对…
 *
 *   ✅ 一处必须说清的事实：**当时的瓶颈不是"上下文太多"，而是"太少"** ——
 *      4 轮 × 800 字 ≈ 3K token，而模型上下文是 **1M**。
 *      也就是说我们**主动丢掉了很多本可以保留的信息**。
 *
 *   所以本模块的修法不是"先截断"，而是：
 *     ① **先按 token 预算尽量多保留**（预算远大于原来的 3K）
 *     ② 预算仍装不下时，把更老的部分**压缩成摘要**（不是丢掉）
 *     ③ 摘要要模型调用 —— 但**先做免费的一步**：剪枝超长工具结果
 *
 * ═══ 两层压缩（借鉴 `@deepseek-ai/dsh-compaction` 的分工）═══
 * ```
 * ① 工具结果剪枝  —— 不调模型，免费
 *      把超长工具结果换成「头 + 「中间略去 N 字」 + 尾」
 *      ⚠️ 原文仍留在事件日志里，可精确重放与查看
 *      ⚠️ 剪枝可能已经够了，就不必再花一次模型调用
 *               ↓ 还不够
 * ② 摘要压缩      —— 调一次模型
 *      把更老的若干轮压成一段结构化摘要
 *      ⚠️ 压缩失败 → 保留原文并标注，**不静默丢弃**
 * ```
 *
 * ═══ 为什么"预算"和"压力"是两个不同的东西 ═══
 *
 * | 概念 | 相对什么 | 作用 |
 * |---|---|---|
 * | **压力**（pressure）| 模型上下文窗口 | **硬安全**：撞窗口是硬失败，不是变慢 |
 * | **预算**（budget）  | 我们愿意为历史花的 token | **质量与成本**：历史太长会干扰判断、也费钱 |
 *
 * dsh 只做了前者（它要防止撞窗口）。我们两个都要：
 * 前者保命，后者保质量。
 */

import {
  DEFAULT_HISTORY_TOKEN_BUDGET,
  DEFAULT_SUMMARY_MAX_TOKENS,
  DEFAULT_SUMMARY_TARGET_CHARS,
} from '../config/budget.js';
import { msg, type ModelMessage, type ModelPurpose } from '../ports/model.js';
import type { ChatMessage } from './types.js';

// ═══════════════════════════════════════════════════════════
// 参数
// ═══════════════════════════════════════════════════════════

/**
 * 历史愿意占用的 token 预算。
 *
 * ★ 这个值替代了原来的 `MAX_HISTORY_TURNS = 4`。
 *
 * ★★ v8 · 2026-10-18：**由 24,000 改为标准档的 160,000**（方案 §14）。
 *
 *   · 旧值 24K 是按"30—60 轮够用"估的 —— 但实测长会话在 60 轮之后
 *     更早的内容就被压成 1,200 字摘要，**细节全丢**。
 *   · 新值 160,000 = DSH `retainRatio 0.16` × 1M 窗口，**照抄成熟产品的默认值**。
 *   · 它是**天花板不是固定支出**：会话只有 5,000 token 时就只发 5,000。
 *
 *   ⚠️ 物理上限由 `CONTEXT_WINDOW_TOKENS` 与 `pressureOf` 管。
 */
export const HISTORY_TOKEN_BUDGET = DEFAULT_HISTORY_TOKEN_BUDGET;

/**
 * 工具结果剪枝阈值（字符）。
 *
 * ⚠️ **v8 · 2026-10-18：本常量已删除**（方案 §14「工具输出的三个不同位置」）。
 *
 *   原因：它**在生产代码里没有调用方** —— 唯一使用方是 `validate:9`。
 *   真实路径用的是 `agentLoop.ts` 的 `TOOL_RESULT_CHAR_LIMIT`（现为标准档 8,192）
 *   与其内部的 `shrinkResult`。
 *
 *   ⚠️ 留着一个"参数表瞄准它、但没人调它"的常量，比没有更糟 ——
 *      它会让读代码的人以为剪枝阈值就是 1,200。
 *
 *   `pruneToolOutput()` 函数本身保留（它面向 `ChatMessage`，
 *   与 agentLoop 面向 `ModelMessage` 内容块的实现同构但用途不同），
 *   调用方**必须显式传阈值**，不再有默认值。
 */

/**
 * 上下文压力参数 —— **照抄 `dsh-compaction-basic` 的默认值**。
 *
 * | 参数 | dsh 默认 | 含义 |
 * |---|---|---|
 * | `thresholdRatio` | 0.8 | 占用达 80% 时视为有压力 |
 * | `headroomTokens` | 65536 | 除输出预留外再留 64K 余量 |
 *
 * ⚠️ 这两个值对**我们当前的情况**几乎不会触发（上下文 1M × 0.8 = 800K）。
 *    保留它们是为了**将来换小上下文模型时不至于裸奔** ——
 *    那时撞窗口是硬失败，不是变慢。
 */
export const COMPACTION_THRESHOLD_RATIO = 0.8;
export const COMPACTION_HEADROOM_TOKENS = 65_536;

/** 已知模型的上下文窗口（token）。默认 1M，按官方文档。 */
export const CONTEXT_WINDOW_TOKENS = 1_000_000;

// ═══════════════════════════════════════════════════════════
// token 估算（确定性，不调模型）
// ═══════════════════════════════════════════════════════════

/**
 * 粗略估算 token 数。
 *
 * ⚠️ **这是估算，不是精确计数** —— 精确计数需要模型厂家的 tokenizer，
 *    那会引入一个重依赖。所以这里用保守的启发式：
 *
 *    · CJK 表意文字与全角标点：**每字 1 token**（偏保守，实际常更少）
 *    · 其它字符（英文、数字、半角符号）：**每 4 字符 1 token**
 *
 * ★ 什么时候必须用真实值而不是估算：
 *    判断"是否接近上下文上限"时**必须用真实值** ——
 *    模型响应里有 `usage.inputTokens`，那是真实测量。
 *    估算只用于"在预算内怎么分层保留"。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
      (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
      (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
      (code >= 0x3000 && code <= 0x303f) || // CJK 标点
      (code >= 0xff00 && code <= 0xffef); // 全角
    if (isCjk) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

// ═══════════════════════════════════════════════════════════
// ① 工具结果剪枝（不调模型）
// ═══════════════════════════════════════════════════════════

/** 剪枝结果。 */
export interface PrunedOutput {
  readonly text: string;
  readonly pruned: boolean;
  /** 原文字符数（`pruned === false` 时等于剪枝后长度） */
  readonly originalChars: number;
}

/**
 * 把超长工具结果剪成「头 + 中略标记 + 尾」。
 *
 * ★ 为什么保留**头尾**而不是只保留头：
 *    · 头部：通常是"这是什么文件/命令返回了什么"的元信息
 *    · 尾部：命令输出里最有用的**结论**常在最后（如 `EXIT 0`、总结行）
 *
 * ⚠️ 剪枝**不销毁原文** —— 事件日志里的 `toolResult` 事件保持完整，
 *    所以"精确重放"与"用户查看原始输出"都不受影响。
 */
export function pruneToolOutput(output: string, maxChars: number): PrunedOutput {
  const original = output.length;
  if (original <= maxChars) {
    return { text: output, pruned: false, originalChars: original };
  }

  // 头尾各分一半，至少各留 200 字（太短没有信息量）
  const half = Math.max(200, Math.floor((maxChars - 40) / 2));
  const head = output.slice(0, half);
  const tail = output.slice(-half);
  const omitted = original - head.length - tail.length;

  return {
    text: `${head}\n（中间略去 ${omitted} 字 · 原文见事件日志）\n${tail}`,
    pruned: true,
    originalChars: original,
  };
}

// ═══════════════════════════════════════════════════════════
// 上下文压力（硬安全）
// ═══════════════════════════════════════════════════════════

/** 压力输入的参数。 */
export interface PressureArgs {
  /**
   * 上一次请求的**真实**输入 token（来自模型响应的 `usage.inputTokens`）。
   *
   * ⚠️ 必须用真实值。为 `undefined` 时视为"无观测"，按无压力处理 ——
   *    因为没有第一次调用之前本来就没有上下文。
   */
  readonly lastInputTokens?: number;
  readonly contextWindow?: number;
  /** 本轮预计输出的 token（输出也会占窗口） */
  readonly reservedOutputTokens?: number;
}

/** 压力结果。 */
export interface Pressure {
  /** 占用率（>= 1 表示已达压力线） */
  readonly ratio: number;
  /** 是否该压缩 */
  readonly atPressure: boolean;
  /** 可用于输入的 token 预算 */
  readonly budget: number;
  readonly used: number;
}

/**
 * 按真实 token 用量判断上下文压力。
 *
 * 公式（与 dsh 同构）：
 *   budget = contextWindow × thresholdRatio − reservedOutput − headroom
 *   ratio  = used / budget
 */
export function pressureOf(args: PressureArgs): Pressure {
  const window = args.contextWindow ?? CONTEXT_WINDOW_TOKENS;
  const reserved = args.reservedOutputTokens ?? 0;

  const budget = Math.max(
    1,
    window * COMPACTION_THRESHOLD_RATIO - reserved - COMPACTION_HEADROOM_TOKENS,
  );
  const used = args.lastInputTokens ?? 0;

  return {
    ratio: used / budget,
    atPressure: used >= budget,
    budget: Math.floor(budget),
    used,
  };
}

/**
 * 真实压力命中时，历史保留预算按 retainRatio 收缩。
 *
 * 正常（未命中压力）仍用标准档 160,000；命中时只保留
 * “压力预算 × 0.16”，给当前轮留出硬安全余量。
 *
 * ⚠️ 不把预算降成 0：全丢历史会让指代彻底失效；最低保留 16K。
 */
export const HISTORY_RETAIN_RATIO = 0.16;
export const MIN_PRESSURE_HISTORY_BUDGET = 16_000;

export function historyBudgetForPressure(lastInputTokens?: number): number {
  const pressure = pressureOf({
    ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
  });
  if (!pressure.atPressure) return HISTORY_TOKEN_BUDGET;
  return Math.max(
    MIN_PRESSURE_HISTORY_BUDGET,
    Math.floor(pressure.budget * HISTORY_RETAIN_RATIO),
  );
}

// ═══════════════════════════════════════════════════════════
// ② 分层选择（预算内尽量多留）
// ═══════════════════════════════════════════════════════════

/** 一轮 = 用户问 + 管家答。 */
export interface HistoryPlan {
  /** 预算内保留的最近消息（原样，不摘要） */
  readonly recent: readonly ChatMessage[];
  /** 预算外、需要摘要的更老消息（顺序保持时间正序） */
  readonly older: readonly ChatMessage[];
  readonly recentTokens: number;
  readonly olderTokens: number;
  /** 是否发生了分层（`older` 非空） */
  readonly layered: boolean;
}

/**
 * 选出「上次摘要边界之后」的新 older 消息。
 *
 * ★ 增量摘要的关键：上次摘要覆盖到 throughMessageId，
 *   本次只把边界之后的新消息交给模型，避免重复总结。
 * ★ 边界找不到（回退/删除/旧事件）时返回全部 older —— 宁可多花一次，
 *   也不要误以为已经覆盖。
 */
export function olderAfterCoverage(
  older: readonly ChatMessage[],
  messages: readonly ChatMessage[],
  throughMessageId: string | undefined,
): readonly ChatMessage[] {
  if (throughMessageId === undefined) return older;
  const boundary = messages.findIndex((m) => m.id === throughMessageId);
  if (boundary < 0) return older;
  return older.filter((m) => {
    const idx = messages.findIndex((x) => x.id === m.id);
    return idx > boundary;
  });
}

/**
 * 按 token 预算把历史分成「保留」与「需摘要」两段。
 *
 * ★ 从**最新**往前填，直到预算用尽 —— 保证最近的上下文一定在。
 *   更老的消息进入 `older`，交给摘要压缩（层②）。
 *
 * ⚠️ 与旧实现的根本差别：
 *   旧实现是**先按轮数砍断**（4 轮），导致"第 5 轮之前全部丢失"；
 *   这里是**先按 token 装**（约 30—60 轮），装不下才摘要 ——
 *   因此**绝大多数会话的完整上文都能保住**。
 */
export function planHistory(
  messages: readonly ChatMessage[],
  opts?: { readonly budgetTokens?: number; readonly excludeLast?: boolean },
): HistoryPlan {
  const budget = opts?.budgetTokens ?? HISTORY_TOKEN_BUDGET;
  const excludeLast = opts?.excludeLast ?? true;

  // 只取已完成的消息；排除本轮用户消息（调用方会带）
  const done = messages.filter((m) => m.status === 'done');
  const pool = excludeLast ? done.slice(0, -1) : done;

  if (pool.length === 0) {
    return { recent: [], older: [], recentTokens: 0, olderTokens: 0, layered: false };
  }

  // 从最新往前填
  const recent: ChatMessage[] = [];
  let used = 0;
  for (let i = pool.length - 1; i >= 0; i--) {
    const m = pool[i];
    if (m === undefined) continue;
    const cost = estimateTokens(m.text) + 16; // 16 ≈ 角色前缀与分隔的开销
    if (used + cost > budget && recent.length > 0) break;
    recent.unshift(m);
    used += cost;
  }

  const kept = new Set(recent.map((m) => m.id));
  const older = pool.filter((m) => !kept.has(m.id));
  const olderTokens = older.reduce((s, m) => s + estimateTokens(m.text) + 16, 0);

  return {
    recent,
    older,
    recentTokens: used,
    olderTokens,
    layered: older.length > 0,
  };
}

// ═══════════════════════════════════════════════════════════
// 摘要压缩的提示词与结果形状
// ═══════════════════════════════════════════════════════════

/**
 * 摘要压缩要保留什么、丢弃什么。
 *
 * ★ 这是层②的**质量标准**，写在这里而不是埋在提示词字符串里，
 *   因为它决定了"压缩后还懂不懂上文"。
 */
export const SUMMARY_KEEP = [
  '用户的目标与诉求（他到底想做什么）',
  '已经确认的事实与约束（过敏、预算、时间等）',
  '已经做出的决定与理由',
  '被否决的方案及其原因（避免重复提议）',
  '尚未解决的问题与用户未回答的提问',
  '指代关系（"那个方案"指的是什么）',
] as const;

export const SUMMARY_DROP = [
  '寒暄与客套',
  '重复表述',
  '已完成的中间步骤细节（谁查了什么文件）',
  '工具的原始输出内容（结论留下即可）',
] as const;

/** 摘要压缩的结果。 */
export interface CompactedHistory {
  /** 摘要文本；`undefined` 表示没做压缩（不需要或失败） */
  readonly summary?: string;
  /** 实际被压缩的消息数 */
  readonly compactedCount: number;
  /** 压缩前的 token 估算 */
  readonly beforeTokens: number;
  /** 压缩后的 token 估算（仅摘要部分） */
  readonly afterTokens: number;
  /**
   * 失败原因（`summary === undefined` 且本应压缩时给出）。
   * ⚠️ 失败**不静默** —— 调用方要向界面标注"较早内容未压缩"。
   */
  readonly failure?: string;
}

// ═══════════════════════════════════════════════════════════
// 层②的提示词构造（纯函数，模型调用由调用方注入）
// ═══════════════════════════════════════════════════════════

/** 摘要压缩请求的提示词。 */
export interface SummaryPrompt {
  readonly system: string;
  readonly user: string;
}

/**
 * 构造"把更老的历史压成摘要"的提示词。
 *
 * ★ 为什么要**保留/丢弃清单**而不是只说"总结一下"：
 *   实测的经验是——泛泛地要求"总结"会把**决定与理由**丢掉，
 *   留下一堆"用户询问了X，助手回答了Y"的空壳。
 *   而后续对话最需要的恰恰是**决定与理由**（避免重复提议已被否决的方案）。
 *
 * ⚠️ 输出用**纯文本**而不是 JSON：
 *   摘要要直接拼进 system 提示词，用 JSON 反而要多一层解析，
 *   而且解析失败就又得重试。
 */
export function buildSummaryPrompt(
  older: readonly ChatMessage[],
  opts?: { readonly maxChars?: number },
): SummaryPrompt {
  /**
   * ★ 摘要目标长度：由 1,200 改为标准档的 6,000 字（方案 §14）。
   *
   *   1,200 字只能装下"决定了什么"，装不下"为什么""具体数量""菜名" ——
   *   而后续对话最需要的恰恰是这些。6,000 字仍是保留预算（160,000）的 3.75%，
   *   不会让每轮输入变贵。
   */
  const maxChars = opts?.maxChars ?? DEFAULT_SUMMARY_TARGET_CHARS;

  const transcript = older
    .map((m) => {
      const who = m.role === 'user' ? '用户' : m.role === 'butler' ? '管家' : m.role;
      return `${who}：${m.text}`;
    })
    .join('\n\n');

  const system = [
    '你要把一段较早的对话压成摘要，供后续对话当背景使用。',
    '',
    '## 必须保留',
    ...SUMMARY_KEEP.map((k) => `- ${k}`),
    '',
    '## 必须丢弃',
    ...SUMMARY_DROP.map((k) => `- ${k}`),
    '',
    '## 要求',
    '- 用**第三人称**陈述（"用户想…""已决定…"），不要写成对话',
    '- **只输出摘要正文**，不要任何前后缀、不要 markdown 标题',
    `- 不超过 ${maxChars} 字`,
    '- 如果某类信息在原文里没有，就跳过，**不要编**',
  ].join('\n');

  return { system, user: `## 需要压缩的对话\n\n${transcript}` };
}

/**
 * 校验并规范化模型返回的摘要。
 *
 * ⚠️ 一条必须拦住的失败：模型返回空串或只有标点。
 *    那等于"压缩成了没有"——比不压缩更糟，因为调用方会以为已经压好了。
 */
export function normalizeSummary(raw: string, maxChars: number = 1_500): string | undefined {
  const t = raw.trim();
  if (t.length === 0) return undefined;
  // 只有标点/空白 → 视为无效
  if (/^[\s\p{P}]*$/u.test(t)) return undefined;
  // 明显是"我没法总结"这类拒答 → 视为失败，交给调用方标注
  if (/^(抱歉|我无法|无法总结|cannot|sorry)/i.test(t)) return undefined;
  return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t;
}

// ═══════════════════════════════════════════════════════════
// 层②执行：调模型做摘要（失败不抛，返回 failure）
// ═══════════════════════════════════════════════════════════

/** 摘要压缩的依赖（注入以便测试与替换）。 */
export interface SummarizeArgs {
  /** 只要 `complete` 就够了 —— 不依赖完整的 ModelPort，便于用假模型测 */
  readonly model: {
    complete(call: {
      readonly purpose: ModelPurpose;
      readonly temperature?: number;
      readonly maxOutputTokens?: number;
      readonly messages: readonly ModelMessage[];
    }): Promise<{ readonly text: string }>;
  };
  readonly older: readonly ChatMessage[];
  /** 已有摘要（增量压缩时把上次的也带上，避免越压越丢） */
  readonly previousSummary?: string;
}

/**
 * 把更老的历史压成摘要。
 *
 * ★★ **失败绝不抛异常** —— 压缩是优化，不是主路径。
 *    如果压缩失败就让整轮对话失败，那是用优化换来了可用性下降。
 *    失败时返回 `failure`，由调用方在上下文里**如实标注"未压缩"**。
 *
 * ★ 增量压缩：把 `previousSummary` 一起喂进去，
 *   避免"每次都只压当前这批，导致更早的信息在摘要里消失"。
 */
export async function summarizeOlder(args: SummarizeArgs): Promise<CompactedHistory> {
  const beforeTokens = args.older.reduce((s, m) => s + estimateTokens(m.text) + 16, 0);

  if (args.older.length === 0) {
    return { compactedCount: 0, beforeTokens: 0, afterTokens: 0 };
  }

  const prompt = buildSummaryPrompt(args.older);
  const user =
    args.previousSummary !== undefined && args.previousSummary.trim().length > 0
      ? `## 已有摘要（更早的对话，请合并进去）\n\n${args.previousSummary}\n\n${prompt.user}`
      : prompt.user;

  try {
    const res = await args.model.complete({
      purpose: 'compaction',
      temperature: 0.1,
      // ★ 摘要硬上限：由 1,200 改为标准档的 65,536（= DSH 的 headroomTokens 默认值）。
      //   ⚠️ 这是**安全阀**不是目标长度 —— 目标由提示词里的 maxChars（6,000 字）决定。
      maxOutputTokens: DEFAULT_SUMMARY_MAX_TOKENS,
      messages: [msg.system(prompt.system), msg.user(user)],
    });

    const summary = normalizeSummary(res.text);
    if (summary === undefined) {
      return {
        compactedCount: args.older.length,
        beforeTokens,
        afterTokens: 0,
        failure: '模型没有给出有效摘要（空、纯标点或拒答）',
      };
    }

    return {
      compactedCount: args.older.length,
      beforeTokens,
      afterTokens: estimateTokens(summary),
      summary,
    };
  } catch (err) {
    return {
      compactedCount: args.older.length,
      beforeTokens,
      afterTokens: 0,
      failure: err instanceof Error ? err.message : String(err),
    };
  }
}

