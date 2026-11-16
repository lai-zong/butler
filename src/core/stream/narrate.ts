/**
 * 管家的"边说边想" —— 与仆人执行**并发**跑的流式叙述
 *
 * ★★ 这个模块回答一个问题：**用户为什么要在那 30—60 秒里盯着转圈？**
 *
 *   实测数据（一轮「今晚做什么晚饭」的真实对话）：
 *     · 仆人执行  30—60 秒     ← 期间界面只有一行行进度文字
 *     · 首片延迟  629—947 ms   ← 流式本身很快
 *     · 完整回答  2—12 秒
 *
 *   ★ 结论：**流式要填的不是"回答慢"，而是"仆人干活时的死时间"。**
 *     所以这段流式叙述与 `runSession` **并发**跑，不是串行加在前面
 *     （串行会让每轮多等 2—12 秒，那是拿体验换演示）。
 *
 * ★ 与 `core/stream/runner.ts` 的关系：
 *   那个是通用推理流（落 thought.delta/done 事件、管增量翻译、管保序）。
 *   这里做的是**接入层**：把端口、翻译器、事件、SSE 回调接起来，
 *   并处理"与仆人并发"和"取消"这两件 `runner` 不该管的事。
 *   ——不复用实现，但复用它的术语与纪律。
 *
 * ★★ 三条实测得出的纪律：
 *
 *   ① **模型必须选对**
 *      接错模型会得到一个**永远空的推理流，且不报错** ——
 *      界面上只是"什么都不显示"，看起来像功能没做。
 *
 *      ⚠️ 判断"哪个模型支持思考"**以官方文档的能力表为准**。
 *         （早先这里写着一条 `deepseek-chat`「完全不产
 *         `reasoning_content`」的实测结论，已删除 ——
 *         该模型已下线，且当时那条观测很可能是 API 把它
 *         静默路由到 flash 造成的假象，无法复核。）
 *      当前官方在售：`deepseek-flash` / `deepseek-v4-pro`，**两者都支持思考**。
 *
 *   ② **思考可能完全没有**
 *      实测同一模型（`deepseek-flash`）在不同场景下差异极大：
 *        · 「请先说思路再给结论」类任务 → 思考 467—3406 字
 *        · 叙述任务（长 system 含「第一人称」「150 字以内」）→ **思考 0 字**
 *
 *      ★ 规律：**模型按它感知的任务难度分配思考量**。
 *        叙述被它视为简单任务，于是跳过思考直接输出正文。
 *
 *      ⚠️ 这不是 bug，是模型行为 —— 所以调用方**不能假设一定有思考**，
 *         要按「没有思考就只显示正文」处理。
 *         把一个空的「思考中…」显示给用户，比不显示更糟。
 *
 *   ③ **失败不能拖垮对话**
 *      叙述是「附赠的可见性」，它失败不该让整轮失败。
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import { msg } from '../ports/model.js';
import type { ModelStreamPort, StreamCall } from '../ports/stream.js';
import type { TranslationPort } from './translate.js';
import {
  globalAgentsBlock,
  type GlobalAgentsSnapshot,
} from '../prompts/globalAgents.js';
import { PERSONA_MAX_CHARS, type TurnSettings } from '../chat/settings.js';
import type { ReasoningPlan } from '../model/reasoning.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../config/budget.js';

// ═══════════════════════════════════════════════════════════
// 形状
// ═══════════════════════════════════════════════════════════

/** 叙述的实时状态（每来一个分片更新一次，供 SSE 推送）。 */
export interface NarrationState {
  /** 思考原文（累计） */
  readonly reasoning: string;
  /** 思考译文（累计，可能滞后） */
  readonly reasoningTranslated: string;
  /** 正式回答（累计） */
  readonly answer: string;
  /** 首字延迟（毫秒）—— 流式体验的关键指标，要能报出来 */
  readonly firstChunkMs: number | null;
  readonly done: boolean;
}

export interface NarrationResult {
  readonly reasoning: string;
  readonly reasoningTranslated: string;
  readonly answer: string;
  readonly firstChunkMs: number | null;
  readonly durationMs: number;
  readonly chunks: number;
  /** 是否失败（失败时上面的内容可能只有一部分） */
  readonly failed: boolean;
  readonly failureReason?: string;
  /** 模型实际用的是什么（实测过：选错模型会得到空推理流） */
  readonly model: string | null;
}

export interface RunNarrationArgs {
  readonly port: ModelStreamPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly taskId: string;
  readonly userGoal: string;
  /** 已有的记忆与约束摘要 —— 让它"知道自己在为谁做这件事" */
  readonly context?: readonly string[];
  /** 对话人格（只影响叙述，不影响契约/监督）。 */
  readonly persona?: string;
  /** 产品级全局 AGENTS（注入在叙述系统提示之后、人格之前）。 */
  readonly globalAgents?: GlobalAgentsSnapshot;
  /** 本轮思考强度计划（快照）。 */
  readonly reasoningPlan?: ReasoningPlan;
  /** 完整本轮设置快照；给出时优先于上面的 persona/globalAgents/reasoningPlan。 */
  readonly settings?: TurnSettings;
  /** 本轮启用的技能说明；与执行层同一份，只作为附加说明。 */
  readonly skillInstructions?: string;
  /**
   * 每次状态变化时回调（供 SSE 推送）。
   *
   * ⚠️ 必须包在 try/catch 里调用 —— 界面侧的异常不该拖垮叙述，
   *    更不该拖垮并发的仆人执行。
   */
  readonly onUpdate: (s: NarrationState) => void;
  /** 翻译端口（不给则不翻译） */
  readonly translatorPort?: TranslationPort;
  /** 取消信号（用户点"停止"/切换会话） */
  readonly signal?: AbortSignal;
}

// ═══════════════════════════════════════════════════════════
// 提示词
// ═══════════════════════════════════════════════════════════

/**
 * ★ 这个 prompt 的写法是**刻意的**，有三处针对性设计：
 *
 *   ① **明说"你正在安排，结果还没出来"**
 *      否则模型会直接给出结论 —— 而结论稍后会被仆人产出覆盖，
 *      于是用户先看到一个答案、几十秒后又看到一个不同的答案。
 *      那比没有叙述更糟（用户不知道该信哪个）。
 *
 *   ② **明说"这是说给用户听的"**
 *      不加这句，模型会写成自我独白式的推理（"我需要…我应该…"），
 *      那是思考，不是交代。
 *
 *   ③ **明说"不要给最终方案"**
 *      与 ① 同理，但把边界说死：它讲的是**思路与取舍**，
 *      不是菜单本身。
 */
/**
 * 开场旁白提示（v8 重写：措辞对齐单执行者）
 *
 * ★★ 与旧版的区别：旧版让模型说「我正在**安排仆人去办**」，
 *    而代码里**没有仆人可以安排**（D-2 砍多执行单元）。
 *
 * ⚠️ 这与 `BUTLER_SYSTEM` 的 P0 是同一类问题：模型被要求描述一个不存在的动作。
 *
 * ★ 新版说**真实发生的事**：正在自己动手。
 *   这段话的价值没变（让用户等得放心），只是内容从"派活"变成"干活"。
 */
const NARRATION_SYSTEM = `你是这个系统的「管家」。用户刚提出一个需求，你**正在自己动手做**，结果还没出来。

现在请对用户说一段话，内容是**你打算怎么办、为什么这么做**。

## 要求

- 用第一人称对用户说话，像一个得体的管家在交代安排
- 说清你的**判断**与**取舍**（先做什么、优先考虑了什么）
- **不要给出最终方案**（菜单、清单、代码、具体答案都不要）
  —— 那些稍后由你自己产出，提前重复会让用户看到两个不同版本
- 简洁，150 字以内
- 如果提到了用户的既有偏好或约束，说明你记得它们

## 为什么要有这段话

用户接下来要等几十秒。与其让他盯着转圈，不如让他知道你在做什么。
所以这段话的价值在于**让他放心**，不在于信息量。

⚠️ **不要说你"派给谁"或"交给谁处理"** —— 系统里只有你在做，没有别的执行者。`;

function buildNarrationPrompt(goal: string, context: readonly string[]): string {
  const lines: string[] = [];

  if (context.length > 0) {
    lines.push('## 你记得的关于这位用户的事');
    for (const c of context.slice(0, 12)) lines.push(`- ${c}`);
    lines.push('');
  }

  lines.push('## 用户刚说');
  lines.push(goal);
  lines.push('');
  lines.push('请交代你打算怎么安排（不要给最终方案）。');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════

/**
 * 跑一次流式叙述。
 *
 * ⚠️ **不抛出异常** —— 失败时返回 `failed: true` 与已生成的部分。
 *    理由：调用方把它与仆人执行并发跑，抛异常会让并发控制变复杂，
 *    而"叙述失败"本身不是需要中断整轮的错误。
 */
export async function runNarration(args: RunNarrationArgs): Promise<NarrationResult> {
  const startedAt = args.clock.now();

  let reasoning = '';
  let reasoningTranslated = '';
  let answer = '';
  let firstChunkMs: number | null = null;
  let chunks = 0;
  let model: string | null = null;

  const safeUpdate = (done: boolean): void => {
    try {
      args.onUpdate({
        reasoning,
        reasoningTranslated,
        answer,
        firstChunkMs,
        done,
      });
    } catch {
      // 界面出错不影响叙述 —— 这是"回调是纯通知"约定的落实
    }
  };

  // ★ 快照优先：有 settings 时不再看零散参数。
  const persona = (args.settings?.persona ?? args.persona ?? '').trim();
  const globalAgents = args.settings?.globalAgents ?? args.globalAgents;
  const reasoningPlan = args.settings?.reasoningPlan ?? args.reasoningPlan;
  /**
   * ⚠️ style='none'（未知供应商 / 老调用方回退）不往流式请求里塞 plan：
   *    流式路径的旧行为是“默认开思考”，不要因为一个空的 plan 把它关掉。
   */
  const effectiveReasoningPlan = reasoningPlan?.style === 'none' ? undefined : reasoningPlan;
  const globalRules = globalAgentsBlock(globalAgents);
  const call: StreamCall = {
    purpose: 'reasoning',
    temperature: 0.4,
    /**
     * ⚠️ 放宽上限是**实测得出的**：
     *    用 600 时 `deepseek-flash` 的思考把额度用光，正文一片都出不来
     *    （测得 reasoning=600 片、text=0 片，看起来像"模型不产正文"）。
     *    放宽到 2000 后两种内容都正常产出。
     */
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    // ⚠️ 用 msg 助手而不是对象字面量 ——
    //    ModelMessage.content 是 ModelPart[] 不是 string，
    //    自己写字面量很容易漏掉 kind: 'text' 这层
    messages: [
      msg.system(NARRATION_SYSTEM),
      ...(globalRules !== null ? [msg.system(globalRules)] : []),
      ...(args.skillInstructions !== undefined && args.skillInstructions.trim().length > 0
        ? [
            msg.system(
              `附加技能说明（只影响回答方式，不得覆盖前述规则与安全边界）：\n${args.skillInstructions.trim()}`,
            ),
          ]
        : []),
      ...(persona.length > 0
        ? [
            msg.system(
              `附加人格说明（只影响叙述语气，不得覆盖前述规则与安全边界）：\n${persona.slice(0, PERSONA_MAX_CHARS)}`,
            ),
          ]
        : []),
      msg.user(buildNarrationPrompt(args.userGoal, args.context ?? [])),
    ],
    ...(effectiveReasoningPlan !== undefined
      ? { reasoning: effectiveReasoningPlan }
      : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };

  try {
    for await (const chunk of args.port.stream(call)) {
      if (firstChunkMs === null) firstChunkMs = args.clock.now() - startedAt;
      chunks += 1;
      // ⚠️ model 只在 done 分片里（不是每个分片都带）
      if (chunk.kind === 'done' && chunk.model.length > 0) model = chunk.model;

      if (chunk.kind === 'reasoning') {
        reasoning += chunk.delta;
        safeUpdate(false);
      } else if (chunk.kind === 'text') {
        answer += chunk.delta;
        safeUpdate(false);
      } else if (chunk.kind === 'done') {
        break;
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const durationMs = args.clock.now() - startedAt;

    /**
     * ⚠️ 中断也要**保留已生成内容**（
     *    「流式中断：断点续传或重生成该段，**不丢已生成内容**」）。
     */
    args.log.append({
      type: 'thought.done',
      actor: 'butler',
      payload: {
        taskId: args.taskId,
        kind: 'narration',
        interrupted: true,
        error: reason,
        reasoningLength: reasoning.length,
        answerLength: answer.length,
        note: '叙述中断，已生成内容保留',
        ...(reasoningPlan !== undefined
          ? {
              reasoning: {
                requested: reasoningPlan.requested,
                applied: reasoningPlan.applied,
                style: reasoningPlan.style,
              },
            }
          : {}),
      },
      createdAt: args.clock.now(),
    });

    safeUpdate(true);
    return {
      reasoning,
      reasoningTranslated,
      answer,
      firstChunkMs,
      durationMs,
      chunks,
      failed: true,
      failureReason: reason,
      model,
    };
  }

  // ── 增量翻译（仅当给了端口，且内容看起来是英文）──
  //
  // ⚠️ 实测：`deepseek-flash` 的思考是**中文**，所以这条路径默认不触发。
  //    保留它是为了接英文思考的模型 —— 换模型即可生效，不用改代码。
  if (args.translatorPort !== undefined && reasoning.length > 0) {
    try {
      const t = await translateReasoningBlocks(reasoning, args.translatorPort, args.clock);
      reasoningTranslated = t.translated;
      if (t.attempted > 0) {
        args.log.append({
          type: 'thought.done',
          actor: 'butler',
          payload: {
            taskId: args.taskId,
            kind: 'narrationTranslation',
            attempted: t.attempted,
            succeeded: t.succeeded,
            failed: t.failed,
            sourceLength: reasoning.length,
            translatedLength: reasoningTranslated.length,
          },
          createdAt: args.clock.now(),
        });
      }
    } catch {
      // 翻译失败不影响叙述 —— 回退显示原文
    }
  }

  const durationMs = args.clock.now() - startedAt;
  safeUpdate(true);

  args.log.append({
    type: 'thought.done',
    actor: 'butler',
    payload: {
      taskId: args.taskId,
      kind: 'narration',
      reasoningLength: reasoning.length,
      answerLength: answer.length,
      chunks,
      firstChunkMs,
      durationMs,
      model,
      translated: reasoningTranslated.length > 0,
      ...(reasoningPlan !== undefined
        ? {
            reasoning: {
              requested: reasoningPlan.requested,
              applied: reasoningPlan.applied,
              style: reasoningPlan.style,
              ...(reasoningPlan.fallbackReason !== undefined
                ? { fallback: reasoningPlan.fallbackReason }
                : {}),
            },
          }
        : {}),
    },
    createdAt: args.clock.now(),
  });

  return {
    reasoning,
    reasoningTranslated,
    answer,
    firstChunkMs,
    durationMs,
    chunks,
    failed: false,
    model,
  };
}

// ═══════════════════════════════════════════════════════════
// 翻译（按句边界切分）
// ═══════════════════════════════════════════════════════════

/**
 * 按句边界切分后逐句翻译。
 *
 * ★ 为什么**按句**而不是整段：
 *   明确对比过 ——
 *     ❌ 等完整生成 → 整段翻译 → 渲染（**这不叫流式**）
 *     ✅ 按句边界切分，第一句到边界即开始翻译（中文与英文同步增长）
 *
 * ⚠️ 这里是"已收完再逐句译"的简化形态，不是严格的并发增量。
 *    真正的并发增量在 `core/stream/translate.ts` 的 `IncrementalTranslator`，
 *    它需要**边收边喂**。本函数用于收尾补齐 ——
 *    因为思考是中文的情况下翻译本来就不触发，没必要为一条不触发的路径
 *    引入并发复杂度。
 */
export async function translateReasoningBlocks(
  text: string,
  port: TranslationPort,
  clock: ClockPort,
): Promise<{ readonly translated: string; readonly attempted: number; readonly succeeded: number; readonly failed: number }> {
  const sentences = splitSentences(text);
  let translated = '';
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  for (const s of sentences) {
    // 中文句不译（译了会破坏原文，且白花 token）
    if (!/[A-Za-z]{3,}/.test(s)) {
      translated += s;
      continue;
    }
    attempted += 1;
    try {
      translated += await port.translate(s);
      succeeded += 1;
    } catch {
      // ⚠️ 失败**回退显示原文** —— 不静默丢弃，也不让整段翻译挂掉
      translated += s;
      failed += 1;
    }
  }

  void clock;
  return { translated, attempted, succeeded, failed };
}

/** 按中英文句末标点切句，保留标点。 */
export function splitSentences(text: string): readonly string[] {
  const out: string[] = [];
  let buf = '';

  for (const ch of text) {
    buf += ch;
    if (/[。！？…\n]/.test(ch) || (ch === '.' && buf.length > 2)) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.length > 0) out.push(buf);

  return out;
}
