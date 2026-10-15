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

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/**
 * 最多带几轮历史。
 *
 * ⚠️ 4 轮是权衡的结果，不是随手定的：
 *   · 太少（1—2 轮）无法处理"那个""按你说的"这类跨轮指代
 *   · 太多（10+ 轮）会让每条 prompt 都背上几千 token，
 *     而第 8 轮的细节对第 10 轮几乎无用
 *   · 真正需要长期记住的东西**该进记忆库**，不是靠堆历史 ——
 *     那是本项目记忆系统的职责，历史只是短期指代上下文
 */
export const MAX_HISTORY_TURNS = 4;

/** 单条历史消息的最大字符数（超出则截断头部保留尾部）。 */
export const MAX_HISTORY_CHARS = 800;

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
 */
export function buildHistoryMessages(
  messages: readonly ChatMessage[],
  opts?: { readonly maxTurns?: number; readonly excludeLast?: boolean },
): readonly ModelMessage[] {
  const maxTurns = opts?.maxTurns ?? MAX_HISTORY_TURNS;
  const excludeLast = opts?.excludeLast ?? true;

  // 去掉本轮用户消息（调用方会带）与未完成的消息
  const pool = excludeLast
    ? messages.filter((m) => m.status === 'done').slice(0, -1)
    : messages.filter((m) => m.status === 'done');

  if (pool.length === 0) return [];

  // 取最后 N 轮（一轮 = 用户问 + 管家答）
  const recent = pool.slice(-maxTurns * 2);

  const lines: string[] = [];
  for (const m of recent) {
    const who = m.role === 'user' ? '用户' : m.role === 'butler' ? '管家' : m.role;
    lines.push(`${who}：${truncateHead(m.text, MAX_HISTORY_CHARS)}`);
  }

  return [
    msg.system(
      `## 本次会话的最近对话（供你理解指代，不是当前任务）\n\n` +
        lines.join('\n\n') +
        `\n\n⚠️ 上面是**背景**。你现在要处理的是下面这条新消息，` +
        `不要回答上面已经回答过的问题。`,
    ),
  ];
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
