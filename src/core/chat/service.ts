/**
 * 聊天服务 —— 把一次用户发言变成完整的一轮
 *
 * 设计依据：方案 § 2.2⑤（管家校验层是唯一裁决者）、§ 5.2（对话参与回退）
 *
 * ★ 这一轮的执行顺序（按用户确认的设计）：
 *
 *     用户发言
 *        ↓
 *     召回记忆 → 路由 → 分解 → 派发仆人（管家**只旁注提醒，不中断**）
 *        ↓
 *     仆人跑完
 *        ↓
 *     ★ 管家审查（唯一决策点）
 *        ├─ 没问题 → 直接汇报（不逐个征求用户同意）
 *        └─ 有问题 → 打回 + 告知用户
 *
 * ⚠️ 审查的分级是本文件的重点，见 `buildVerdict`。
 */

import type { ModelPort } from '../ports/model.js';
import type { ClockPort, RandomPort } from '../ports/clock.js';
import type { EventLog } from '../events/log.js';
import type { MemoryStore } from '../memory/store.js';
import type { ToolFramework } from '../tools/framework.js';
import { recall, type ScoredMemory } from '../memory/recall.js';
import {
  reflectTurn,
  renderReflectSummary,
  sinkAndAdmit,
  type ReflectTurnResult,
} from '../reflection/runReflection.js';
import { extractFacts } from '../reflection/extractFacts.js';
import { runNarration, type NarrationResult, type NarrationState } from '../stream/narrate.js';
import type { ModelStreamPort } from '../ports/stream.js';
import type { AgentProgressEvent } from '../tools/agentLoop.js';
import { DEFAULT_PARAMS } from '../memory/fitness.js';
import { runSession, type ProgressEvent, type RunSessionResult } from '../runtime/orchestrator.js';
import {
  SessionStore,
  type ServantReportData,
  type Verdict,
  type VerdictIssue,
} from './types.js';
import { buildHistoryMessages, buildServantHistoryMessages } from './history.js';
import { planHistory, summarizeOlder } from './compaction.js';
import { createTraceCollector } from './trace.js';
import { toServantReportData } from './reports.js';
import type { ServantId } from '../servants/types.js';

// ═══════════════════════════════════════════════════════════
// 一轮的执行
// ═══════════════════════════════════════════════════════════

/** 一次召回最多取几条 —— 太多会淹没任务本身。 */
export const RECALL_LIMIT = 8;

export interface RunTurnArgs {
  readonly sessionId: string;
  readonly userText: string;
  /** 记忆归属的用户 */
  readonly userId: string;
  readonly random: RandomPort;
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly store: MemoryStore;
  readonly chat: SessionStore;
  readonly tools?: ToolFramework;
  readonly onProgress?: (e: ProgressEvent) => void;
  /**
   * 流式叙述端口（流式的「边说边想」）。
   *
   * ⚠️ **必须选支持思考的模型** —— 否则推理流永远是空的**且不报错**，
   *    界面上只是"什么都不显示"，看起来像功能没做。
   *    ⚠️ 模型是否支持思考，**以官方文档的能力表为准**，
   *    不要靠零散实测（我们曾因一次被静默路由的观测得出错误结论）。
   *    用 `NARRATION_MODEL` 配置（默认 `deepseek-flash`）。
   *
   * 不给则跳过叙述（测试与纯推理场景不需要它）。
   */
  readonly streamModel?: ModelStreamPort;
  /** 叙述状态更新回调（供 SSE 推送逐字内容） */
  readonly onNarration?: (s: NarrationState) => void;
  /**
   * 工具循环进度（供界面渲染「思考 → 工具 → 再思考」画面）。
   *
   * ⚠️ 只有给了 streamPort 才有事件 —— 工具循环得走流式才看得到过程。
   */
  readonly onAgentProgress?: (e: AgentProgressEvent) => void;
}

export interface RunTurnResult {
  readonly userMessageId: string;
  readonly replyMessageId: string;
  readonly replyText: string;
  readonly verdict: Verdict;
  readonly session: RunSessionResult;
  /**
   * 本次反思与入库的结果。
   *
   * ⚠️ 可空：反思失败时（模型超时等）它是 undefined，
   *    但**对话本身仍然成功** —— 学习失败不该让用户拿不到结果。
   */
  readonly reflection?: ReflectTurnResult;
  /**
   * 本次的流式叙述结果。
   *
   * ⚠️ 可空且**可能 failed** —— 叙述是"附赠的可见性"，
   *    它失败不该让整轮失败。
   */
  readonly narration?: NarrationResult;
  /**
   * ★★ 本轮各仆人的产出 —— 界面右侧「仆人面板」的数据。
   *
   * ⚠️ 与 `session.reports` 的区别：
   *    · `session.reports` 是**领域对象**（完整产出物，给管家校验用）
   *    · 这个是**已截断的展示形状**（给界面排版用）
   *
   *   ★ 在 `runTurn` 里**只转换一次**，然后复用到两个地方
   *     （落进消息 + 通过 SSE 推给界面）——
   *     转两次会出现「界面上看到的」与「存下来的」不一致，
   *     而那是最难查的一类 bug。
   */
  readonly servantReports: readonly ServantReportData[];
}

/**
 * 跑一轮对话。
 *
 * ★ 全程由本函数负责把 core 的产出翻译成**界面要的东西**：
 *   消息、审查结论、进度事件。
 *   Route Handler 只负责把它接成 SSE —— 不掺业务逻辑。
 */
export async function runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
  const { sessionId, userText, chat } = args;

  // ── ① 记下用户发言（落事件，供回退与重放）──
  const userMsg = chat.appendMessage(sessionId, { role: 'user', text: userText });

  /**
   * ── ①a ★ 构造对话历史 ──
   *
   * ★★ 这一步之前**完全缺失**，后果实测过：
   *   用户第二轮说「那今晚就按你说的做」，回复里明说
   *   「用户目标中『按你说的做』指向此前某位仆人给出的方案，
   *     但**本次校验未收到该方案产出**，无法核对」。
   *   它明确说了「看不到」—— 因为它真的看不到。
   *
   * ⚠️ 一处容易混淆的地方（值得写清楚）：
   *    之前那轮能知道「用户对花生过敏」，**不是因为它记得对话**，
   *    而是因为**记忆系统**把这条事实存下来并在每轮注入。
   *
   *    **记忆系统在替对话历史补位，但补不了「你刚才那句话指的是什么」。**
   *      · 记忆 —— 跨会话的长期事实（你是谁、有什么约束）
   *      · 历史 —— 本次会话的指代上下文（「那个」「按你说的」）
   *
   * ⚠️ 必须在 `appendMessage` **之后**取：
   *    管家的历史要**排除**最后一条（那是本轮用户消息，调用方自己会带，
   *    不排除会出现两遍）；仆人的历史要**包含**它（要知道用户本轮说了什么）。
   */
  const priorMessages = chat.messagesOf(sessionId);

  /**
   * ── ①a′ ★ 层②：更老的历史先压成摘要（只在超预算时发生）──
   *
   * ★ 为什么"只在超预算时"：
   *   历史预算 24K token（约 30—60 轮），一般会话根本用不满。
   *   所以这一步**绝大多数轮次是空转**（`older` 为空，直接跳过）——
   *   不会为每轮对话多付一次模型调用。
   *
   * ⚠️ **压缩失败绝不让对话失败** —— 压缩是优化，不是主路径。
   *    失败时摘要为空，`buildHistoryMessages` 会**如实标注"较早内容未压缩"**，
   *    而不是假装完整（假装完整会让模型自信地用错前提）。
   */
  let olderSummary: string | undefined;
  {
    const plan = planHistory(priorMessages, { excludeLast: true });
    if (plan.older.length > 0 && args.model !== undefined && args.model !== null) {
      const compacted = await summarizeOlder({ model: args.model, older: plan.older });
      if (compacted.summary !== undefined) {
        olderSummary = compacted.summary;
      }
      // 尺寸轨迹落事件 —— "压缩省了多少"要可核对，不能只有我口头说
      args.log.append({
        type: 'context.compacted',
        actor: 'butler',
        payload: {
          compactedCount: compacted.compactedCount,
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
          ok: compacted.summary !== undefined,
          ...(compacted.failure !== undefined ? { failure: compacted.failure } : {}),
        },
        createdAt: args.clock.now(),
      });
    }
  }

  const history = buildHistoryMessages(priorMessages, {
    excludeLast: true,
    ...(olderSummary !== undefined ? { olderSummary } : {}),
  });
  const servantHistory = buildServantHistoryMessages(priorMessages);

  /**
   * ── ①b ★ 从用户发言提取事实 ──
   *
   * ★★ 这一步是「它记得你」的起点，之前**完全缺失**。
   *
   *   实测发现：用户说「我叫示例用户，对花生严重过敏」，
   *   而系统只从**反思**里产出候选 —— 反思的 prompt 面向
   *   「这轮协作有什么可改进的」，天生产出**原则**，一条事实都没有。
   *
   *   后果链：
   *     没有 fact 类候选 → `inferSource` 对原则一律判 aiDerivedPrinciple
   *     → 全部待审核 → 方案规定候选不参与召回 → **召回恒为 0**
   *     → 「它记得你」永不成立，**而系统看起来一切正常**。
   *
   *   ★ 根本区分：**事实不是「反思」出来的，是「听到」的。**
   *     用户说「我对花生过敏」是一句陈述，不需要推理，需要的是记下来。
   *
   * ⚠️ 刻意放在**召回之前** —— 这样本轮就能用上刚提取的事实。
   *    用户说「我对花生过敏，今晚吃什么」时，第一条消息就该生效，
   *    而不是等到下一轮。
   */
  let extractedFactCount = 0;
  try {
    const existingFacts = args.store
      .visibleTo({ kind: 'butler', userId: args.userId })
      .filter((m) => m.kind === 'fact')
      .map((m) => m.content);

    const ex = await extractFacts({
      model: args.model,
      log: args.log,
      clock: args.clock,
      store: args.store,
      userId: args.userId,
      userText,
      existing: existingFacts,
    });

    if (ex.candidates.length > 0) {
      const r = sinkAndAdmit({
        log: args.log,
        store: args.store,
        clock: args.clock,
        candidates: ex.candidates,
      });
      extractedFactCount = r.admittedAutonomously;
    }
  } catch (err) {
    // 提取失败不该阻断对话 —— 但要留痕，不静默吞
    args.log.append({
      type: 'reflection.done',
      actor: 'butler',
      payload: {
        sessionId,
        kind: 'factExtraction',
        failed: true,
        reason: err instanceof Error ? err.message : String(err),
      },
      createdAt: args.clock.now(),
    });
  }

  // ── ② 召回记忆 ──
  //
  // ⚠️ 可见集合**必须先经 `visibleTo` 过滤**再交给 recall ——
  //    不能"先全拿再筛"：那等于把不该看的（其他仆人的领域记忆、
  //    无授权的敏感域）也读进了内存，分权就成了摆设。
  const candidates = args.store.visibleTo({ kind: 'butler', userId: args.userId });
  const recallResult = recall({
    query: userText,
    candidates,
    limit: RECALL_LIMIT,
    now: args.clock.now(),
    random: args.random,
    // ⚠️ 参数演化（第三层）的当前值应由演化引擎持有；
    //    当前用默认值 —— 演化引擎自适应后需要把当前参数取回来传这里。
    params: DEFAULT_PARAMS,
  });
  const recalled = recallResult.selected;

  const memRefs = recalled.map((r) => ({
    id: r.memory.id,
    content: r.memory.content,
  }));

  // ── ③ 编排（仆人执行；管家只旁注，不中断）──
  //
  /**
   * ★★ 叙述与仆人执行**并发**跑 —— 这是流式真正该填的地方。
   *
   *   实测数据（一轮真实对话）：
   *     · 仆人执行  30—60 秒   ← 期间界面只有一行行进度文字
   *     · 叙述本身  1.6—2.4 秒
   *
   *   ⚠️ 所以**不能串行**加在前面：串行会让每轮多等 2—3 秒 ——
   *      那是拿体验换演示，方向反了。
   *      并发跑则叙述在那段死时间里说完，随后被真实结果覆盖。
   *
   *   ⚠️ 叙述失败**不影响**编排：`runNarration` 内部吞掉异常并返回
   *      `failed: true`，这里再用 `.catch` 兜一层，防止意外冒泡。
   */
  const narrationPromise: Promise<NarrationResult | null> =
    args.streamModel !== undefined && args.streamModel !== null
      ? runNarration({
          port: args.streamModel,
          log: args.log,
          clock: args.clock,
          taskId: sessionId,
          userGoal: userText,
          context: narrationContext(args.store, recalled, args.userId),
          onUpdate: (s) => args.onNarration?.(s),
        }).catch(() => null)
      : Promise.resolve(null);

  /**
   * ★★ 收集工具循环过程 —— 让「它到底干了什么」**跨刷新留存**。
   *
   *   ⚠️ 必须在 `runSession` **之前**建：
   *      事件从 `onAgentProgress` 同步推出，晚一步就漏掉前面的轮次。
   *
   *   ★ 与界面内存里那份的分工：
   *      · 界面那份用于**流式渲染**（逐片更新，看得见"正在长"）
   *      · 这份用于**持久化**（收完写进消息）
   *      只做前者的话，刷新就再也看不到"它读了哪个文件、结果是什么"。
   */
  const trace = createTraceCollector();

  const session = await runSession({
    model: args.model,
    clock: args.clock,
    sessionId,
    userGoal: userText,
    recalled,
    log: args.log,
    store: args.store,
    // 管家要理解指代（「按你说的」）
    ...(history.length > 0 ? { history } : {}),
    // 仆人用精简历史（只有用户本轮原话）
    ...(servantHistory.length > 0 ? { servantHistory } : {}),
    // ★ 工具循环的流式：让「调了什么工具、拿到什么」可见
    ...(args.streamModel !== undefined && args.streamModel !== null
      ? { streamPort: args.streamModel }
      : {}),
    // ★ 一路喂给收集器（持久化），一路喂给调用方（流式渲染）
    onAgentProgress: (e) => {
      trace.onEvent(e);
      args.onAgentProgress?.(e);
    },
    ...(args.tools !== undefined ? { tools: args.tools } : {}),
    ...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
  });

  // ── ④ ★ 管家审查（唯一决策点）──
  const verdict = buildVerdict({
    sessionId,
    forMessageId: userMsg.id,
    session,
    chat,
    clock: args.clock,
    recalledCount: recalled.length,
  });

  // ── ⑤ 汇报（通过）或告知（打回）──
  const baseReply = verdict.outcome === 'accepted'
    ? buildAcceptedReply(session, verdict)
    : buildRejectedReply(session, verdict);

  /**
   * ★ 置信度不足时，把"按什么假设干的"**明确告诉用户**（v7 · D-4）。
   *
   * ⚠️ 放在**最前面**而不是末尾：
   *   放在末尾用户会先读一大段产出、最后才发现前提可能是错的，
   *   等于白读。放在开头，他一眼就知道"哦它理解成这样了"。
   *
   * ⚠️ 措辞刻意不用"置信度不足"这种内部术语 ——
   *   用户不关心我们的概率，只关心"它理解得对不对"。
   */
  const assumptionLine =
    session.assumption !== undefined
      ? `> ${session.assumption.note}\n\n`
      : '';
  const replyText = `${assumptionLine}${baseReply}`;

  /**
   * ★ 仆人产出**只转换一次** —— 下面两个地方复用它
   *   （落进消息 + 通过返回值给 SSE）。
   */
  const servantReports = toServantReportData(session);

  const reply = chat.appendMessage(sessionId, {
    role: 'butler',
    text: replyText,
    status: 'done',
    memoryRefs: memRefs,
    // ★ 工具循环过程随消息落盘 —— 刷新后仍能看到「它读了哪个文件」
    ...(trace.hasContent() ? { agentTrace: trace.build() } : {}),
    /**
     * ★★ 各仆人各自的产出 —— 界面上「仆人面板」的数据源。
     *
     * ⚠️ 之前**没有收集它**，于是界面上只能显示管家汇总后的结果，
     *    看不到「某个仆人说了什么、依据是什么」。
     *    而方案 § 2.2 的核心是**仆人只提交发现、管家才做裁决** ——
     *    那个区分必须在界面上看得见，
     *    否则「平等编排」只是文档里的一句话。
     */
    ...(servantReports.length > 0 ? { servantReports } : {}),
  });

  args.onProgress?.({
    kind: 'stage',
    stage: verdict.outcome === 'accepted' ? 'done' : 'rejected',
    label: verdict.outcome === 'accepted' ? '完成' : '打回',
  });

  /**
   * ── ⑥ 反思与入库 ──
   *
   * ★★ 这一步之前**缺了**，而且是整个项目最严重的一个缺口：
   *
   *   `reflectServant` / `reflectButler` / `sinkCandidates` 在此之前
   *   **只有验证脚本调用**。生产代码里没有任何地方调用它们。
   *
   *   失效链：界面聊天 → 记忆库永远是空的 → 召回 0 条
   *   → 没有硬约束注入 → 没有原则 → 没有演化
   *   → **「它记得你」在真实使用路径上完全不成立**。
   *
   *   ⚠️ 而验证 2 是 34/34 全过的 —— 因为它手工调了反思与入库。
   *      这暴露了验证方法上的一个问题：
   *      **验证「核心能力可用」不等于验证「真实路径可达」**。
   *
   * ⚠️ 刻意放在汇报**之后**：用户先拿到结果，反思是"附赠的积累"。
   *    反思失败也**不影响**已交付的结果。
   */
  args.onProgress?.({ kind: 'stage', stage: 'reflect', label: '整理这次的经验' });

  let reflection: ReflectTurnResult | null = null;
  try {
    reflection = await reflectTurn({
      model: args.model,
      log: args.log,
      clock: args.clock,
      store: args.store,
      session,
      userGoal: userText,
      userId: args.userId,
      accepted: verdict.outcome === 'accepted',
    });
  } catch (err) {
    // 反思失败不该让用户拿不到结果 —— 但要留痕，不静默吞
    args.log.append({
      type: 'reflection.done',
      actor: 'butler',
      payload: {
        sessionId,
        failed: true,
        reason: err instanceof Error ? err.message : String(err),
      },
      createdAt: args.clock.now(),
    });
  }

  // 学到了什么 —— 追加到回复末尾（用户应当看得见「它在积累」）
  const learnedParts: string[] = [];
  if (extractedFactCount > 0) {
    learnedParts.push(`从你这句话里记住了 ${extractedFactCount} 条`);
  }
  if (reflection !== null) {
    const s = renderReflectSummary(reflection);
    if (s.length > 0) learnedParts.push(s);
  }
  if (learnedParts.length > 0) {
    chat.updateMessage(sessionId, reply.id, {
      text: `${replyText}\n\n---\n\n*${learnedParts.join(' · ')}*`,
    });
  }

  args.onProgress?.({
    kind: 'stage',
    stage: 'done',
    label: '完成',
  });

  /**
   * ⚠️ 等叙述收尾。
   *
   *   为什么要等：它在仆人执行期间**并行**跑完了，但结果要落事件
   *   （`thought.done`），而落事件必须在本轮结束前完成 ——
   *   否则本轮 seq 区间会漏掉它，审计视图看不到这段。
   *
   *   ⚠️ 也可能它还在跑（叙述比仆人慢的情况，如 v4-pro 的 11.8 秒）。
   *      那就等它：已经有完整结果了，多等一两秒不影响正确性，
   *      而丢掉一段**已生成**的叙述是内容损失。
   */
  const narration = await narrationPromise;

  return {
    userMessageId: userMsg.id,
    replyMessageId: reply.id,
    servantReports,
    replyText,
    verdict,
    session,
    ...(reflection !== null ? { reflection } : {}),
    ...(narration !== null ? { narration } : {}),
  };
}

/**
 * 给叙述的上下文 —— 让管家「知道自己在为谁办这件事」。
 *
 * ★ 实测效果：带上「用户对花生严重过敏。」之后，叙述里自然出现了
 *   「花生过敏这条更是底线，绝不会碰」。
 *   **这就是「它记得你」在界面上可见的地方。**
 *
 * ⚠️ 硬约束排在**最前** —— 它是叙述里最该被提到的内容，
 *    而上下文有长度上限（`slice`），排后面可能被截掉。
 */
function narrationContext(
  store: MemoryStore,
  recalled: readonly ScoredMemory[],
  userId: string,
): readonly string[] {
  const out: string[] = [];

  // ① 硬约束无条件进（与召回层的处理一致）
  for (const m of store.visibleTo({ kind: 'butler', userId })) {
    if (m.memClass === 'global_constraint' && m.lifecycle === 'active') {
      out.push(m.content);
    }
  }

  // ② 其余按召回结果（已按分数排序）
  for (const r of recalled) {
    if (r.memory.memClass === 'global_constraint') continue;
    if (out.includes(r.memory.content)) continue;
    out.push(r.memory.content);
  }

  return out.slice(0, 12);
}

// ═══════════════════════════════════════════════════════════
// ★ 审查：管家唯一的决策点
// ═══════════════════════════════════════════════════════════

/**
 * 从编排结果生成审查结论。
 *
 * ★★ 分级是本项目的安全设计核心（对应方案 § 2.2⑤）：
 *
 *   | 严重度     | 来源                        | 处理              |
 *   | blocking   | 硬约束冲突                   | **打回** + 告知用户 |
 *   | advisory   | 软约束 / 跨领域冲突 / 原则违背 | 照常汇报 + 标注    |
 *   | info       | 遗漏、不确定性               | 附注              |
 *
 *   ⚠️ 为什么 advisory **不打回**：**偏好不是禁令**。
 *      用户偶尔就想吃顿油的，打回等于管家替他做了决定。
 *      而 blocking 之所以打回，是因为它涉及**安全**（如过敏原），不是偏好。
 *
 *   ⚠️ 另一处刻意的设计（按用户确认）：执行过程中管家**不拦截**仆人，
 *      只在审查时判断。所以"拦截"在这里表现为**不交付结果**，
 *      而不是中断执行 —— 这避免了"执行中被提醒过、结果又变了"
 *      这类无法回答的状态。
 */
export function buildVerdict(args: {
  readonly sessionId: string;
  readonly forMessageId: string;
  readonly session: RunSessionResult;
  readonly chat: SessionStore;
  readonly clock: ClockPort;
  readonly recalledCount: number;
}): Verdict {
  const issues: VerdictIssue[] = [];

  // ── ① 硬约束冲突 → blocking ──
  for (const v of args.session.hardConstraints.verdicts) {
    if (v.satisfied) continue;
    issues.push({
      severity: 'blocking',
      kind: 'hardConstraint',
      statement:
        v.unhandledBy.length > 0
          ? `产出没有处理硬约束「${v.content}」（${v.unhandledBy.join('、')} 未涉及）`
          : `产出与硬约束「${v.content}」冲突`,
      memoryId: v.constraintId,
      memoryContent: v.content,
      suggestion: '换个不涉及该约束的方案，或由你确认后继续',
    });
  }

  // ── ② 原则违背 → advisory ──
  for (const v of args.session.principles.violated) {
    issues.push({
      severity: 'advisory',
      kind: 'principle',
      statement: `已生效原则「${v.content}」在本次产出中未见落实`,
      memoryId: v.principleId,
      memoryContent: v.content,
      suggestion: '如果本次情况不适用这条原则，可以告诉我去调整它',
    });
  }

  // ── ③ 跨领域冲突 → advisory（软约束可协商）──
  for (const c of args.session.supervision.conflicts ?? []) {
    issues.push({
      severity: 'advisory',
      kind: 'conflict',
      statement: c.message,
      suggestion: '告诉我你更看重哪一边，我会记住这个选择',
    });
  }

  // ── ④ 步骤失败 → advisory（没做成的部分要说清）──
  for (const rep of args.session.reports) {
    if (rep.status === 'done') continue;
    issues.push({
      severity: rep.status === 'blocked' ? 'blocking' : 'advisory',
      kind: 'omission',
      statement: `${rep.servant} 这一步没能完成：${rep.uncertainties[0] ?? rep.status}`,
      suggestion: '可以让我换个思路重试',
    });
  }

  const blocking = issues.filter((i) => i.severity === 'blocking');
  const advisory = issues.filter((i) => i.severity === 'advisory');

  const steps = args.session.reports.map((r) => ({
    stepId: r.taskId,
    servant: r.servant as ServantId,
    ok: r.status === 'done',
  }));

  const artifactIds = args.session.artifacts.map((a) => a.id);

  const outcome = blocking.length > 0 ? 'rejected' : 'accepted';

  const summary =
    outcome === 'accepted'
      ? advisory.length > 0
        ? `已完成，但有 ${advisory.length} 处需要你留意`
        : '已完成'
      : `未通过审查：${blocking[0]?.statement ?? '存在不可协商的冲突'}`;

  return args.chat.addVerdict(args.sessionId, {
    forMessageId: args.forMessageId,
    outcome,
    summary,
    issues,
    steps,
    durationMs: args.session.endedAt - args.session.startedAt,
    usage: args.session.totalUsage,
    artifactIds,
  });
}

// ═══════════════════════════════════════════════════════════
// 汇报文本
// ═══════════════════════════════════════════════════════════

/**
 * 通过时的汇报。
 *
 * ★ 用户确认过：**没问题就直接汇报，不逐个征求同意**。
 *   所以这里不出现"是否继续？[是/否]"这类话 —— 那是把决策推回给用户。
 *   但**治理入口要留着**（"看依据"），因为本项目的主线是"可查看可修改"。
 */
function buildAcceptedReply(session: RunSessionResult, verdict: Verdict): string {
  const lines: string[] = [];

  // 管家自己的汇总（监督层产出的结论文本）
  if (session.supervision.summary.length > 0) {
    lines.push(session.supervision.summary.trim());
    lines.push('');
  }

  // 仆人的产出
  for (const rep of session.reports) {
    const arts = rep.artifacts;
    if (arts.length === 0) continue;

    for (const a of arts) {
      const body = Array.isArray(a.content) ? a.content.join('\n') : String(a.content);
      lines.push(body);
      lines.push('');
    }
  }

  const advisory = verdict.issues.filter((i) => i.severity === 'advisory');
  if (advisory.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('**有几处想让你知道：**');
    for (const a of advisory) {
      lines.push(`- ${a.statement}`);
      if (a.suggestion !== undefined) lines.push(`  （${a.suggestion}）`);
    }
  }

  return lines.join('\n').trim() || '已完成，但没有产出可展示的内容。';
}

/**
 * 打回时的告知。
 *
 * ★ 关键是**带上原因与可选的下一步**。
 *   "打回"如果只表现为"任务失败"，用户看到的是失败而不是问题 ——
 *   那保护不了他，只是让他困惑。
 *
 * ⚠️ 必须给用户**留门**（"我自己判断"）：
 *   他是最终决策者，管家说明风险、给建议，但门是开是关由他定。
 *   这与"唯一裁决者是管家"不矛盾 —— 管家裁决的是**内部冲突**，
 *   不是**用户的决定权**。
 */
function buildRejectedReply(session: RunSessionResult, verdict: Verdict): string {
  const blocking = verdict.issues.filter((i) => i.severity === 'blocking');
  const advisory = verdict.issues.filter((i) => i.severity === 'advisory');

  const lines: string[] = [];
  lines.push('这次的任务**没通过审查**，我没有把它交给你。');
  lines.push('');

  lines.push('**原因**');
  for (const b of blocking) {
    lines.push(`- ${b.statement}`);
    if (b.memoryContent !== undefined) {
      lines.push(`  关联的记忆：「${b.memoryContent}」`);
    }
  }

  lines.push('');
  lines.push('**你可以**');
  const suggestions = new Set<string>();
  for (const b of blocking) {
    if (b.suggestion !== undefined) suggestions.add(b.suggestion);
  }
  suggestions.add('告诉我你的想法，我按你的意思重做');
  for (const s of suggestions) lines.push(`- ${s}`);
  lines.push('- 或者直接说「我确认，继续」—— 你是最终决策者，我只负责说明风险');

  if (advisory.length > 0) {
    lines.push('');
    lines.push('**另外还有几处**');
    for (const a of advisory) lines.push(`- ${a.statement}`);
  }

  // 仆人确实做了事，产出仍可查看（不是"什么都没发生"）
  const totalArtifacts = session.reports.reduce((n, r) => n + r.artifacts.length, 0);
  if (totalArtifacts > 0) {
    lines.push('');
    lines.push(
      `（仆人确实产出了 ${totalArtifacts} 项内容，被我就地扣下。` +
        '如果你想看我也可以展示 —— 但要先让你知道问题在哪。）',
    );
  }

  return lines.join('\n');
}
