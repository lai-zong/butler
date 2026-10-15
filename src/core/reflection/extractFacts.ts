/**
 * 事实提取 —— 从用户发言里抽出"关于用户本人"的事实
 *
 * ★★ 这个文件补的是一条**自洽的空转链**上最关键的一环：
 *
 *   实测发现（一次真实对话后）：
 *     用户说「我叫示例用户，对花生严重过敏」
 *     反思产出的 6 条候选**全是原则**，没有一条事实。
 *
 *   于是：
 *     ① 没有 fact 类候选
 *     ② `inferSource` 对原则一律返回 `aiDerivedPrinciple`
 *        （这是刻意的保守设计：原则会指导后续所有决策，最该审）
 *     ③ 于是全部落 candidate
 *     ④ 方案规定**候选不参与召回** → 召回恒为 0
 *     ⑤ 「它记得你」永远不成立 —— **而系统看起来一切正常**
 *
 *   ⚠️ 根因在 ①：反思的 prompt 是面向"这轮协作有什么可改进的"，
 *      它天生产出原则。**事实不是"反思"出来的，是"听到"的。**
 *      用户说"我对花生过敏"是一句**陈述**，不需要推理，
 *      需要的是**把它记下来**。
 *
 * ★ 为什么单独一步而不是塞进反思：
 *   · 归因不同：事实来自**用户发言**，原则来自**协作复盘**
 *   · 可靠性不同：事实是用户原话（可自主生效），原则是推断（需审核）
 *   · 时机不同：事实应当在**理解目标之后立刻**提取（供本轮就注入），
 *     反思在任务结束后
 */

import type { ModelPort } from '../ports/model.js';
import type { ClockPort } from '../ports/clock.js';
import type { EventLog } from '../events/log.js';
import type { MemoryStore } from '../memory/store.js';
import type { MemoryCandidate } from './reflect.js';
import { memoryExtractionSchema } from '../prompts/schemas.js';
import { msg } from '../ports/model.js';

// ═══════════════════════════════════════════════════════════
// 常量与类型
// ═══════════════════════════════════════════════════════════

/** 提示词版本（方案要求分层 Prompt 可版本化）。 */
export const EXTRACT_PROMPT_VERSION = 'extract-facts/1.0';

/**
 * 单次提取的上限。
 *
 * ⚠️ 上限不是为了省 token，而是**防止把闲聊写成记忆**：
 *    一次发言里真正"关于用户本人且长期有效"的事实通常 0—3 条。
 *    给到 8 条会让模型倾向于把临时状态（"今晚想吃清淡的"）
 *    也当成长期事实，那会污染记忆库，而且用户很难察觉。
 */
export const MAX_FACTS_PER_TURN = 4;

/** 提取出的一条事实（模型返回的原始形状）。 */
export interface ExtractedFact {
  /** 事实内容，第三人称陈述句 */
  readonly content: string;
  /** 0—1 置信度 */
  readonly confidence: number;
  /**
   * 类别。
   *
   * ★ 这个区分直接决定它能否自主生效：
   *   · `identity` / `constraint` / `context` → 用户陈述，**可自主生效**
   *   · `preference` 里含"推断"性质的 → 待审核
   */
  readonly category: 'identity' | 'constraint' | 'preference' | 'context';
  /** 用户原话片段（证据链，必须来自用户发言本身） */
  readonly quote: string;
}

export interface ExtractFactsResult {
  readonly facts: readonly ExtractedFact[];
  readonly candidates: readonly MemoryCandidate[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly skippedReason?: string;
}

// ═══════════════════════════════════════════════════════════
// 提取
// ═══════════════════════════════════════════════════════════

/**
 * 从一句用户发言里提取关于用户本人的事实。
 *
 * ★ 三条纪律：
 *   ① **`quote` 必须能在用户发言里找到** —— 这是防幻觉的关键。
 *      模型很擅长把"常识"写成"用户说过"，而记忆库一旦被这种内容污染，
 *      用户很难发现（他会以为是自己说过的）。
 *   ② **没有事实时返回空数组是正常的**。"帮我查个天气"不含任何
 *      关于用户本人的长期事实 —— 强行提取就是制造噪音。
 *   ③ **失败不抛出** —— 提取失败不该让对话进行不下去。
 */
export async function extractFacts(args: {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly store: MemoryStore;
  readonly userId: string;
  readonly userText: string;
  /** 已有记忆的摘要，供模型判断"这条是否已经记过" */
  readonly existing: readonly string[];
}): Promise<ExtractFactsResult> {
  const empty = { inputTokens: 0, outputTokens: 0 };

  // 太短的发言不可能含事实（"好" / "继续" / "嗯"）
  const text = args.userText.trim();
  if (text.length < 8) {
    return { facts: [], candidates: [], usage: empty, skippedReason: '发言过短' };
  }

  args.log.append({
    type: 'reflection.started',
    actor: 'butler',
    payload: {
      kind: 'factExtraction',
      sessionId: '__extract__',
      textLength: text.length,
      existingCount: args.existing.length,
    },
    createdAt: args.clock.now(),
  });

  let parsed: { facts: ExtractedFact[] };
  let usage = { inputTokens: 0, outputTokens: 0 };

  try {
    const result = await args.model.completeStructured({
      purpose: 'memoryExtraction',
      schema: memoryExtractionSchema,
      schemaName: 'ExtractedFacts',
      temperature: 0.1,
      maxOutputTokens: 1024,
      messages: [msg.system(EXTRACT_SYSTEM), msg.user(buildExtractPrompt(text, args.existing))],
    });
    parsed = { facts: result.value.facts as ExtractedFact[] };
    usage = result.usage;
  } catch (err) {
    args.log.append({
      type: 'reflection.done',
      actor: 'butler',
      payload: {
        kind: 'factExtraction',
        failed: true,
        reason: err instanceof Error ? err.message : String(err),
      },
      createdAt: args.clock.now(),
    });
    return {
      facts: [],
      candidates: [],
      usage: empty,
      skippedReason: `提取失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── ★ 防幻觉：逐条核对 quote 是否真在用户发言里 ──
  const checked: ExtractedFact[] = [];
  let dropped = 0;

  for (const f of (parsed.facts ?? []).slice(0, MAX_FACTS_PER_TURN)) {
    if (typeof f.content !== 'string' || f.content.trim().length === 0) {
      dropped += 1;
      continue;
    }
    if (typeof f.quote !== 'string' || !quoteAppearsIn(f.quote, text)) {
      /**
       * ⚠️ 找不到出处就**丢弃**，不降置信度保留。
       *
       *   理由：记忆库的价值建立在"每条都能追溯到你原话"上。
       *   保留一条无出处的事实，等于在库里放了一条**无法审计**的记忆 ——
       *   而"可审计"是本项目的立身之本。
       */
      dropped += 1;
      continue;
    }
    checked.push({ ...f, content: f.content.trim(), quote: f.quote.trim() });
  }

  // ── 转成记忆候选 ──
  const candidates: MemoryCandidate[] = checked.map((f, i) => ({
    id: `cand_fact_${args.clock.now().toString(36)}_${i}`,
    kind: 'fact',
    content: f.content,
    confidence: clamp01(f.confidence),
    /**
     * ★ 证据链带上用户原话 —— 这是 `inferSource` 判定
     *   「用户陈述」的依据，也是用户日后审计时看到的"你当时是这么说的"。
     */
    evidence: [`用户说：「${f.quote}」`],
    scope: {
      // identity / constraint / context 属于全局共享层；
      // 偏好仍是全局共享（用户偏好不分领域）
      memClass: 'global_shared',
    },
    rationale: `从用户发言中提取（类别：${CATEGORY_LABEL[f.category] ?? f.category}）`,
    layer: 'butler',
    by: 'butler',
    createdAt: args.clock.now(),
  }));

  args.log.append({
    type: 'reflection.done',
    actor: 'butler',
    payload: {
      kind: 'factExtraction',
      extracted: checked.length,
      droppedNoQuote: dropped,
      categories: checked.map((f) => f.category),
    },
    createdAt: args.clock.now(),
  });

  return { facts: checked, candidates, usage };
}

// ═══════════════════════════════════════════════════════════
// 提示词
// ═══════════════════════════════════════════════════════════

const CATEGORY_LABEL: Record<string, string> = {
  identity: '身份',
  constraint: '约束',
  preference: '偏好',
  context: '背景',
};

/**
 * ⚠️ 这个 prompt 刻意**极短且只问事实**。
 *
 *   第一版把"提取事实"和"反思协作"混在一个 prompt 里 ——
 *   实测结果是模型只输出原则，一条事实都没有
 *   （因为"反思"这个词把它的注意力拉到"有什么可改进的"上）。
 *
 *   **一个 prompt 只干一件事**，这里干的就是"听清用户说了什么关于他自己的事"。
 */
const EXTRACT_SYSTEM = `你是一个"事实提取器"。你的唯一任务是从用户的一句话里，找出**关于用户本人**且**长期有效**的事实。

## 什么算事实（要提取）

- 身份：姓名、称呼、职业、家庭成员、居住地
- 约束：过敏、忌口、慢性病、宗教禁忌、硬性限制
- 偏好：长期稳定的喜好与厌恶（不是这一顿想吃什么）
- 背景：长期状况（如"我在减脂期""我最近在备赛"）

## 什么不算（不要提取）

- 临时状态：「今晚想吃清淡的」「今天有点累」
- 请求本身：「帮我安排晚饭」「推荐几家餐厅」
- 你对用户的推断：没有原话依据的一律不提
- 常识与通用知识：「花生是常见过敏原」

## 铁律

1. **每一条都必须给出 quote，且必须逐字出现在用户这句话里。**
   找不到原话就不要提这一条。宁可少提。
2. **没有事实就返回空数组。** 这是完全正常的答案 ——
   「帮我查个天气」不含任何关于用户本人的事实。
3. content 用第三人称陈述句，简洁，不超过 40 字。
4. 一次最多 4 条。**宁可少提，不要凑数。**`;

function buildExtractPrompt(userText: string, existing: readonly string[]): string {
  const lines: string[] = [];

  if (existing.length > 0) {
    lines.push('## 已经记住的（不要重复提取）');
    for (const e of existing.slice(0, 30)) lines.push(`- ${e}`);
    lines.push('');
  }

  lines.push('## 用户这句话');
  lines.push(userText);
  lines.push('');
  lines.push('提取关于用户本人且长期有效的事实。没有就返回空数组。');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

/**
 * `quote` 是否真的出现在用户发言里。
 *
 * ⚠️ 刻意**宽松匹配**：去掉空白与常见标点后比对。
 *    模型会把「我叫示例用户」引成「我叫示例用户，」（带上逗号），
 *    严格逐字比对会把这条正确的事实误杀。
 *
 *    但**不能宽松到失去意义** —— 只忽略空白与标点，
 *    不忽略任何实词。这样"编造一句话"仍然会被拦住。
 */
export function quoteAppearsIn(quote: string, text: string): boolean {
  const norm = (s: string): string => s.replace(/[\s，。！？、；：""''（）()【】《》,.!?;:'"()[\]<>-]/g, '');
  const q = norm(quote);
  if (q.length === 0) return false;
  // 太短的 quote 无鉴别力（"我"、"的"）
  if (q.length < 2) return false;
  return norm(text).includes(q);
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0.7;
  return Math.min(1, Math.max(0, v));
}
