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
import { recall } from '../memory/recall.js';
import { DEFAULT_PARAMS } from '../memory/fitness.js';
import { runSession, type ProgressEvent, type RunSessionResult } from '../runtime/orchestrator.js';
import { SessionStore, type Verdict, type VerdictIssue } from './types.js';
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
}

export interface RunTurnResult {
  readonly userMessageId: string;
  readonly replyMessageId: string;
  readonly replyText: string;
  readonly verdict: Verdict;
  readonly session: RunSessionResult;
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
  const session = await runSession({
    model: args.model,
    clock: args.clock,
    sessionId,
    userGoal: userText,
    recalled,
    log: args.log,
    store: args.store,
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
  const replyText = verdict.outcome === 'accepted'
    ? buildAcceptedReply(session, verdict)
    : buildRejectedReply(session, verdict);

  const reply = chat.appendMessage(sessionId, {
    role: 'butler',
    text: replyText,
    status: 'done',
    memoryRefs: memRefs,
  });

  args.onProgress?.({
    kind: 'stage',
    stage: verdict.outcome === 'accepted' ? 'done' : 'rejected',
    label: verdict.outcome === 'accepted' ? '完成' : '打回',
  });

  return {
    userMessageId: userMsg.id,
    replyMessageId: reply.id,
    replyText,
    verdict,
    session,
  };
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
