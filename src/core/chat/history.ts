/**
 * 对话历史 —— 让模型看得到「上文」
 *
 * ★★ 这个模块补的是一个**基础缺口**：
 *
 *   在此之前，每次模型调用只带 `system + 本轮消息`：
 *     `route()`      → [system, 本轮目标]
 *     `decompose()`  → [system, 本轮目标 + 召回]
 *     `runServant()` → [system, 本轮指令 + 上游产出]
 *
 *   **模型完全看不到对话历史。** 后果实测过：
 *     · 用户第二轮说「那今晚就按你说的做」
 *     · 回复：「用户目标中『按你说的做』指向此前某位仆人给出的方案，
 *              但**本次校验未收到该方案产出**，无法核对…」
 *     它明确说了"看不到" —— 因为它真的看不到。
 *
 *   ⚠️ 一处容易混淆的地方（值得写清楚）：
 *      之前那轮能知道"用户对花生过敏"，**不是因为它记得对话**，
 *      而是因为**记忆系统**把这条事实存下来并在每轮注入。
 *
 *      **记忆系统在替对话历史补位，但补不了「你刚才那句话指的是什么」。**
 *      两者是不同的问题：
 *        · 记忆  —— 跨会话的长期事实（用户是谁、有什么约束）
 *        · 历史  —— 本次会话的指代上下文（"那个"、"按你说的"、"再来一次"）
 *
 * ★ 三条纪律：
 *   ① **有上限** —— 历史会线性增长；无上限会让 prompt 越来越贵，
 *      且早晚撞上上下文长度限制（那时是硬失败，不是变慢）
 *   ② **按轮成对保留** —— 只留用户消息会让模型看到一堆没头没尾的问题
 *   ③ **截断而不丢弃** —— 超长的单条消息截断头部保留尾部
 *      （结尾通常才是问题本身）
 */

import type { ChatMessage } from '../chat/types.js';
import { msg, type ModelMessage } from '../ports/model.js';
import { HISTORY_TOKEN_BUDGET, planHistory } from './compaction.js';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/**
 * 单条历史消息的最大字符数（超出则截断头部保留尾部）。
 *
 * ⚠️ **这个常量现在只是兜底**，不再是主要的分层依据。
 *    主依据是 `HISTORY_TOKEN_BUDGET`（按 token 装，约 30—60 轮）。
 *    保留它是因为**单条超长消息**仍需截断 —— 否则一条 5 万字的回复
 *    会独占全部预算，把别的轮次全挤出去。
 */
export const MAX_HISTORY_CHARS = 800;

/**
 * @deprecated 用 `compaction.ts` 的 `HISTORY_TOKEN_BUDGET` 取代。
 *
 * ★ 为什么废弃：**固定轮数是错误的判据**。
 *   · 4 轮 × 800 字 ≈ 3K token，而上下文有 1M —— **主动丢掉了大量有用信息**
 *   · 实测后果：用户说"那今晚就按你说的做"，模型答"我看不到那个方案"
 *   ⚠️ 保留导出仅为不破坏既有引用（`buildServantHistoryMessages` 不用它）。
 */
export const MAX_HISTORY_TURNS = 4;

// ═══════════════════════════════════════════════════════════
// 构造
// ═══════════════════════════════════════════════════════════

/**
 * 从会话消息里构造给模型的历史。
 *
 * ★ 返回**一个 system 消息**而不是多个 user/assistant 消息。
 *
 *   理由（这是一个刻意的选择）：
 *   本项目的模型调用大多是**结构化输出**（要 JSON），
 *   前面塞入多轮 user/assistant 会让模型倾向于"接着聊"，
 *   而不是"输出 JSON"。实测这类干扰是结构化失败的常见原因之一。
 *
 *   用一个 system 消息把历史压成"背景资料"，既让模型看到上文，
 *   又不改变它当前的任务性质。
 *
 * ⚠️ 不含本轮的用户消息 —— 调用方自己会带上，重复会出现两遍。
 *
 * ★ 分层结构（v7，见 `compaction.ts`）：
 * ```
 * ## 更早的摘要（较早的 N 条已压缩）    ← 层②，或"未压缩"的如实标注
 *   …（摘要文本）
 *
 * ## 本次会话的最近对话                ← 层①，预算内原样保留
 *   用户：…
 *   管家：…
 *
 * ⚠️ 上面是**背景**。你现在要处理的是下面这条新消息…
 * ```
 */
/**
 * `buildHistoryMessages` 的选项。
 *
 * ⚠️ 从 v7 起**不再有 `maxTurns`** —— 固定轮数是错误的判据
 *    （4 轮 ≈ 3K token，而上下文有 1M，等于主动丢信息）。
 *    改为按 token 预算分层，见 `compaction.ts`。
 */
export interface HistoryOptions {
  /** 预算（token）。默认 `HISTORY_TOKEN_BUDGET`（24K，约 30—60 轮）。 */
  readonly budgetTokens?: number;
  readonly excludeLast?: boolean;
  /**
   * 更老历史的**摘要**（由层②压缩产生）。
   *
   * 给了它就放在最近对话之前，标注为"更早的摘要"；
   * 不给且确实有更老的历史时，会**如实标注"较早内容未压缩"** ——
   * 让模型知道自己漏了什么，比假装完整更有用。
   */
  readonly olderSummary?: string;
}

export function buildHistoryMessages(
  messages: readonly ChatMessage[],
  opts?: HistoryOptions,
): readonly ModelMessage[] {
  const plan = planHistory(messages, {
    budgetTokens: opts?.budgetTokens ?? HISTORY_TOKEN_BUDGET,
    excludeLast: opts?.excludeLast ?? true,
  });

  if (plan.recent.length === 0 && plan.older.length === 0) return [];

  const parts: string[] = [];

  // ── 层②：更老历史的摘要 ──
  if (plan.older.length > 0) {
    const summary = opts?.olderSummary;
    if (summary !== undefined && summary.trim().length > 0) {
      parts.push(`## 更早的摘要（较早的 ${plan.older.length} 条已压缩）\n\n${summary}`);
    } else {
      // ⚠️ 如实标注，不假装完整 —— 模型知道自己漏了什么，反而会收敛表述
      parts.push(
        `## 更早的内容（未压缩）\n\n` +
          `此前还有 ${plan.older.length} 条对话（约 ${(plan.olderTokens / 1000).toFixed(1)}K token），` +
          `未纳入本次上下文。如果用户的指代指向那些内容，**直接问清是哪一个** —— ` +
          `不要猜，也不要声称"看不到全部"。`,
      );
    }
  }

  // ── 层①：预算内的最近对话 ──
  const lines: string[] = [];
  for (const m of plan.recent) {
    const who = m.role === 'user' ? '用户' : m.role === 'butler' ? '管家' : m.role;
    lines.push(`${who}：${truncateHead(m.text, MAX_HISTORY_CHARS)}`);
  }
  if (lines.length > 0) {
    parts.push(`## 本次会话的最近对话（供你理解指代，不是当前任务）\n\n${lines.join('\n\n')}`);
  }

  parts.push(
    `⚠️ 上面是**背景**。你现在要处理的是下面这条新消息，` +
      `不要回答上面已经回答过的问题。`,
  );

  return [msg.system(parts.join('\n\n'))];
}

/** 供调用方/界面查看当前历史的 token 占用（不构造消息）。 */
export function historyUsage(
  messages: readonly ChatMessage[],
  opts?: { readonly budgetTokens?: number },
): {
  readonly recentTokens: number;
  readonly olderTokens: number;
  readonly layered: boolean;
  readonly budget: number;
} {
  const budget = opts?.budgetTokens ?? HISTORY_TOKEN_BUDGET;
  const plan = planHistory(messages, { budgetTokens: budget });
  return {
    recentTokens: plan.recentTokens,
    olderTokens: plan.olderTokens,
    layered: plan.layered,
    budget,
  };
}

/**
 * 截断头部、保留尾部。
 *
 * ⚠️ 保留**尾部**而不是头部，因为：
 *   · 长消息的开头通常是铺垫（"我想了一下…考虑到…"）
 *   · 结尾才是问题本身（"…所以今晚吃什么？"）
 *
 *   截头留尾让模型看到"他要什么"，截尾留头只能看到"他在铺垫"。
 */
export function truncateHead(text: string, max: number): string {
  if (text.length <= max) return text;
  return `（前文略）…${text.slice(-max)}`;
}

/**
 * 给 `runServant` 用的**精简**历史。
 *
 * ⚠️ 为什么仆人用更少的历史：
 *   仆人的职责是"按指令干活"，它需要的是**上游产出**（通过
 *   `inputs` 精确传递），而不是对话的来龙去脉。
 *   给多了会让它跑偏到"回答用户"而不是"产出结构化报告"。
 *
 *   实测依据：仆人 prompt 里已经有 `instruction` + `injectedConstraints`
 *   + `inputs` 三块精确信息，再加长历史是重复供给。
 */
export function buildServantHistoryMessages(
  messages: readonly ChatMessage[],
): readonly ModelMessage[] {
  if (messages.length === 0) return [];

  const done = messages.filter((m) => m.status === 'done');
  const lastUser = [...done].reverse().find((m) => m.role === 'user');
  if (lastUser === undefined) return [];

  return [
    msg.system(
      `## 用户本轮原话（供理解语境，不是指令）\n\n` +
        `用户：${truncateHead(lastUser.text, 400)}`,
    ),
  ];
}
