/**
 * 直接与仆人对话
 *
 * ★★ 这是用户明确要求的能力：
 *
 *   「所有对话窗口，包括管家和仆人，都支持直接对话。
 *     注意：当直接与管家对话而不与仆人对话时，管家负责验收结果；
 *     当直接与仆人对话或先与管家对话再与仆人对话，
 *     则**管家退回提示而不直接截断仆人**。」
 *
 *   ★ 按这条规则，本函数与 `runTurn` 的分工是：
 *
 *     `runTurn`（走管家）：
 *       路由 → 拆解 → 派发 → **管家验收** → 打回或放行
 *
 *     `runServantTurn`（直接找仆人）：
 *       不派发、**不管家验收**（那正是"不截断"的落实）——
 *       用户说什么，仆人就直接做什么；
 *       管家只能在事后于对话流里提醒，不改动仆人的产出。
 *
 *   ⚠️ 一个必须守住的边界：**硬性要求仍然生效**。
 *      "管家可以提醒但不得拦截"讲的是**流程**（不打断、不打回），
 *      不是"安全底线可以让步"。所以这里照样注入硬约束 ——
 *      注入 ≠ 拦截：它让仆人**知道**约束，而不是阻止它干活。
 *
 * ⚠️ 与 `runTurn` 一样，这里也要走 `runServant`（那是唯一的执行路径），
 *    不能绕过 —— 绕过就没有参数校验、没有权限闸门、没有审计。
 */

import type { ModelPort } from '../ports/model.js';
import type { ModelStreamPort } from '../ports/stream.js';
import type { ClockPort, RandomPort } from '../ports/clock.js';
import type { EventLog } from '../events/log.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionStore } from './types.js';
import type { ServantId } from '../servants/types.js';

import { runServant } from '../servants/execute.js';
import { toServantReportData } from './reports.js';
import { createTraceCollector } from './trace.js';
import { extractFacts } from '../reflection/extractFacts.js';
import { sinkAndAdmit } from '../reflection/runReflection.js';
import { recall } from '../memory/recall.js';
import { DEFAULT_PARAMS } from '../memory/fitness.js';
import type { AgentProgressEvent } from '../tools/agentLoop.js';

/** 每轮给仆人注入的硬约束上限（与管家路径保持一致）。 */
const MAX_HARD_CONSTRAINTS = 8;

export interface RunServantTurnArgs {
  readonly servant: ServantId;
  readonly userText: string;
  readonly userId: string;
  readonly model: ModelPort;
  readonly streamModel?: ModelStreamPort | null;
  readonly log: EventLog;
  readonly clock: ClockPort;
  /** 随机源 —— 召回里的探索性取样要用（与管家路径一致） */
  readonly random: RandomPort;
  readonly store: MemoryStore;
  readonly chat: SessionStore;
  /**
   * 工具的框架。
   *
   * ⚠️ 不给它，仆人只能"纯推理" —— 读不了文件、看不到目录。
   *    与管家路径一样：这是"真的能动手"的前提。
   */
  readonly tools?: import('../tools/framework.js').ToolFramework;
  readonly onAgentProgress?: (e: AgentProgressEvent) => void;
}

export interface RunServantTurnResult {
  readonly userMessageId: string;
  readonly replyMessageId: string;
  readonly replyText: string;
  readonly servantReports: ReturnType<typeof toServantReportData>;
}

/**
 * 跑一轮「直接与仆人对话」。
 *
 * 与 `runTurn` 的关键差异（**不是简化，是刻意的边界**）：
 *   · 不路由：目标仆人由用户指定，不做领域判断
 *   · 不拆解：一条消息就是一个任务，不派发给多个仆人
 *   · **不验收**：产出直接呈现，管家不打回
 *     （这是"不截断仆人进程"的落实）
 *   · 仍然**提取事实并入库**：用户说的话照样要记住 ——
 *     否则"直接找仆人"就成了记忆系统的盲区
 *   · 仍然**注入硬约束**：注入是"让它知道"，不是"拦住它"
 */
export async function runServantTurn(args: RunServantTurnArgs): Promise<RunServantTurnResult> {
  const sessionId = `servant_${args.servant}`;
  const chat = args.chat;

  // 会话不存在就建（一个仆人一个固定会话，历史累积）
  if (chat.getSession(sessionId) === undefined) {
    chat.createSession(sessionId);
  }

  const userMsg = chat.appendMessage(sessionId, { role: 'user', text: args.userText });

  /**
   * ── 记住用户说的话 ──
   *
   * ⚠️ 即使绕过管家，事实也必须入库。
   *    否则用户"直接跟健康仆人说我对花生过敏"，
   *    这条信息永远不会被记住 —— 那是记忆系统的盲区。
   *
   * ⚠️ 提取失败**不影响对话**：它不该让用户拿不到结果。
   */
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
      userText: args.userText,
      existing: existingFacts,
    });

    if (ex.candidates.length > 0) {
      sinkAndAdmit({
        log: args.log,
        store: args.store,
        clock: args.clock,
        candidates: ex.candidates,
      });
    }
  } catch {
    /* 学习失败不该让对话失败 */
  }

  // ── 召回（含硬约束，管家路径怎么召回这里就怎么召回）──
  let injected: import('../servants/types.js').InjectedConstraint[] = [];
  try {
    // ⚠️ 可见集合必须先过滤再交给 recall ——
    //    不能先全拿再筛：那等于把不该看的也读进内存，分权就成了摆设。
    const visible = args.store.visibleTo({ kind: 'butler', userId: args.userId });
    const recallResult = recall({
      query: args.userText,
      candidates: visible,
      limit: MAX_HARD_CONSTRAINTS,
      now: args.clock.now(),
      random: args.random,
      params: DEFAULT_PARAMS,
    });
    injected = recallResult.selected.map((s) => ({
      memoryId: s.memory.id,
      content: s.memory.content,
      source: s.memory.memClass,
      negotiable: s.memory.memClass !== 'global_constraint',
    }));
  } catch {
    /* 召回失败不该让对话失败 */
  }

  /**
   * ── 收集工具循环过程 ──
   * ⚠️ 必须在 `runServant` **之前**建：事件是同步推出来的，
   *    晚一步就漏掉前面的轮次。
   */
  const trace = createTraceCollector();

  const taskId = `direct_${args.servant}_${Date.now().toString(36)}`;

  const result = await runServant({
    model: args.model,
    log: args.log,
    servant: args.servant,
    taskId,
    // ★ 用户的原话就是指令 —— 不做改写（改写等于替用户说话）
    instruction: args.userText,
    injectedConstraints: injected,
    clock: args.clock,
    now: args.clock.now(),
    ...(args.tools !== undefined ? { tools: args.tools } : {}),
    ...(args.streamModel !== undefined && args.streamModel !== null
      ? { streamPort: args.streamModel }
      : {}),
    onAgentProgress: (e) => {
      trace.onEvent(e);
      args.onAgentProgress?.(e);
    },
  });

  // ★ 仆人自己说的话就是回复正文（与管家路径同一套数据形状）
  const replyText =
    result.report.reply.trim().length > 0
      ? result.report.reply
      : `（它这次没有留下说明，状态：${result.report.status}）`;

  const reply = chat.appendMessage(sessionId, {
    role: 'servant',
    servant: args.servant,
    text: replyText,
    status: 'done',
    ...(trace.hasContent() ? { agentTrace: trace.build() } : {}),
  });

  const servantReports = toServantReportData({
    // ⚠️ `toServantReportData` 要的是会话运行结果；这里只有单个仆人，
    //    所以手工组装最小形状 —— 不伪造 `dispatch`/`supervision` 等字段。
    reports: [result.report],
    steps: [],
  } as unknown as Parameters<typeof toServantReportData>[0]);

  return {
    userMessageId: userMsg.id,
    replyMessageId: reply.id,
    replyText,
    servantReports,
  };
}
