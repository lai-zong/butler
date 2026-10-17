/**
 * 端到端编排 —— 一次完整会话
 *
 * 把路由 → 分解 → 派发 → 汇报 → 校验串起来，全程写入事件日志。
 *
 * 这是**验证脚本与未来 UI 共用的入口**：
 * UI 只是把这个流程的事件流渲染出来，不额外承载业务逻辑。
 */

import { decompose } from '../butler/dispatch.js';
import { route } from '../butler/router.js';
import { verifyHardConstraints, type HardConstraintReport } from '../butler/hardConstraints.js';
import { supervise } from '../butler/supervisor.js';
import { EventLog } from '../events/log.js';
import { runServant } from '../servants/execute.js';
import { SERVANT_BOUNDARY } from '../servants/types.js';
import type { ToolFramework } from '../tools/framework.js';
import type { MemoryStore } from '../memory/store.js';
import type { ScoredMemory } from '../memory/recall.js';
import {
  checkPrinciples,
  recordInjection,
  recordViolation,
  selectPrinciples,
  type PrincipleCandidate,
  type PrincipleCheck,
} from '../memory/principles.js';
import type {
  DispatchStep,
  Finding,
  ServantArtifact,
  ServantId,
  ServantReport,
  UpstreamInput,
} from '../servants/types.js';
import type { ClockPort, ModelMessage, ModelPort } from '../ports/index.js';
import type { ModelStreamPort } from '../ports/stream.js';
import type { AgentProgressEvent } from '../tools/agentLoop.js';
import type { SupervisionOutput } from '../prompts/schemas.js';
import type { RoutingDecision } from '../prompts/schemas.js';

export interface RunSessionArgs {
  readonly model: ModelPort;
  readonly clock: ClockPort;
  readonly sessionId: string;
  readonly userGoal: string;
  readonly recalled: readonly ScoredMemory[];
  /**
   * 工具框架。给出时仆人走工具循环（能读写文件、跑命令）；
   * 不给时走纯推理路径。验证脚本两种都用得到。
   */
  readonly tools?: ToolFramework;
  /**
   * 记忆仓储。给出时管家会**注入该领域已生效的原则**并在收尾时检测违背。
   * 不给则跳过原则环节（纯编排验证时不必要）。
   */
  readonly store?: MemoryStore;
  /**
   * 事件日志。
   *
   * ★★ 必须由调用方传入（不传则内部新建一个**不落盘**的，仅供测试）。
   *
   *   ⚠️ 原先这里无条件 `new EventLog(sessionId)` ——
   *      后果是**一次会话产生的全部事件都不会落盘**：
   *      路由、派发、仆人汇报、工具调用、冲突、产出物……
   *      既不持久化，也无法重放。而审计与检查点回退都建立在事件流上，
   *      等于核心链路根本没接上。
   *
   *      这个缺口很隐蔽：所有验证脚本都通过，因为它们在**同一个进程内**
   *      用返回值断言结果，从没检查过「事件有没有落盘」。
   */
  readonly log?: EventLog;
  /**
   * 对话历史（供理解跨轮指代）。
   *
   * ⚠️ 不给则模型只看得到本轮 —— 实测后果：
   *    用户说「那今晚就按你说的做」，回复里明说
   *    「本次校验未收到该方案产出，无法核对」。
   *    因为它**真的**看不到上一轮。
   */
  readonly history?: readonly ModelMessage[];
  /**
   * 给仆人的**精简**历史（与 `history` 分开）。
   *
   * ⚠️ 为什么不复用 `history`：
   *    管家要理解指代（「按你说的」），仆人只要干活。
   *    同一份历史喂两边，仆人会被对话细节带偏到
   *    「回答用户」而不是「产出结构化报告」。
   */
  readonly servantHistory?: readonly ModelMessage[];
  /**
   * 流式端口。给出时**仆人的工具循环走流式** ——
   * 「思考 → 工具 → 再思考」画面的来源。
   *
   * ⚠️ 不给则行为与之前完全一致。
   */
  readonly streamPort?: ModelStreamPort;
  /** 工具循环进度（供界面实时渲染工具卡片） */
  readonly onAgentProgress?: (e: AgentProgressEvent) => void;
  /**
   * 进度回调 —— 让**界面能实时看到**任务执行到哪一步。
   *
   * ★ 为什么需要它：`runSession` 是「跑完才返回」，而界面需要在过程中
   *   就显示「正在派发给生活仆人」「健康仆人校验中」。
   *   没有这个回调，界面只能在结束时一次性拿到结果 ——
   *   那就成了「转圈等待」，而方案 § 13.3 要求的是**过程可见**。
   *
   * ⚠️ 回调是**单向的、纯通知**：
   *   它不能改变编排结果，也不能因抛错影响流程。
   *   调用点会把回调包在 try/catch 里 —— 界面出错不该拖垮任务。
   */
  readonly onProgress?: (e: ProgressEvent) => void;
}

/** 编排进度事件（供界面实时展示）。 */
export type ProgressEvent =
  | { readonly kind: 'stage'; readonly stage: string; readonly label: string }
  | {
      readonly kind: 'stepStarted';
      readonly stepId: string;
      readonly servant: ServantId;
      readonly instruction: string;
      readonly index: number;
      readonly total: number;
    }
  | {
      readonly kind: 'stepDone';
      readonly stepId: string;
      readonly servant: ServantId;
      readonly ok: boolean;
      readonly artifactCount: number;
      readonly findingCount: number;
    }
  | {
      readonly kind: 'stepFailed';
      readonly stepId: string;
      readonly servant: ServantId;
      readonly reason: string;
    };

export interface RunSessionResult {
  readonly log: EventLog;
  readonly routing: RoutingDecision;
  /** 置信度是否达阈值。⚠️ `false` **不再意味着没干活** —— 见 `assumption` */
  readonly confident: boolean;
  /**
   * 置信度不足时"按什么假设继续干的"（v7 · D-4）。
   *
   * ★ 与旧的"停下来问用户"不同：这里是**已经干完了**，
   *   只是要把假设告诉用户，让他知道"如果我理解偏了，说一声就重来"。
   *
   * `undefined` 表示置信度足够，没有假设需要说明。
   */
  readonly assumption?: {
    readonly servant: string;
    readonly confidence: number;
    readonly note: string;
  };
  readonly steps: readonly DispatchStep[];
  readonly reports: readonly ServantReport[];
  readonly supervision: SupervisionOutput;
  /** 硬约束机械校验结果（确定性判定，见 hardConstraints.ts） */
  readonly hardConstraints: HardConstraintReport;
  /** 原则注入与违背检测结果（方案 § 8.8 效果验证） */
  readonly principles: {
    readonly injected: readonly PrincipleCandidate[];
    readonly checks: readonly PrincipleCheck[];
    readonly violated: readonly PrincipleCheck[];
  };
  /** 本次登记的产出物（检查点回退预览用） */
  readonly artifacts: readonly { readonly id: string; readonly label: string; readonly stepId: string }[];
  readonly totalUsage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly modelInfo: { readonly provider: string; readonly model: string };
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * 构造"低置信度时按什么假设继续干"的说明（v7 · D-4）。
 *
 * ★ 抽成纯函数的好处：
 *   ① 可单元测试（`runSession` 依赖真实模型，难测）
 *   ② 文案集中一处，改措辞不用碰编排逻辑
 *
 * ★★ 措辞的三条纪律：
 *   ① **不用内部术语** —— 不说"置信度不足 0.72"，用户不关心我们的概率
 *   ② **先说干了什么** —— "先按 X 处理了"，让他知道不是什么都没做
 *   ③ **给出纠正入口** —— "不对的话直接说"，而不是反问他"你到底想要什么"
 *      （反问等于把球踢回去，而用户可能已经去忙别的了）
 */
export function buildRouteAssumption(
  confident: boolean,
  decision: {
    readonly servant: string;
    readonly confidence: number;
    // ⚠️ `exactOptionalPropertyTypes` 下必须写成 `| undefined`，
    //    否则调用方传 `clarifyingQuestion: undefined` 会被判类型错
    readonly clarifyingQuestion?: string | undefined;
  },
): RunSessionResult['assumption'] {
  if (confident) return undefined;

  const asked = decision.clarifyingQuestion?.trim() ?? '';
  const head = `我不太确定你的意思，先按「${decision.servant}」这件事处理了。`;

  return {
    servant: decision.servant,
    confidence: decision.confidence,
    note:
      asked.length > 0
        ? `${head}如果我理解偏了，你其实是想问「${asked}」—— 直接说，我重来。`
        : `${head}不对的话直接说，我重来。`,
  };
}

export async function runSession(args: RunSessionArgs): Promise<RunSessionResult> {
  // ⚠️ 用传入的 log（它挂了持久化端口）；不传时内部新建一个仅内存的，供测试用
  const log = args.log ?? new EventLog(args.sessionId);

  /**
   * 进度上报。
   *
   * ⚠️ 必须包 try/catch —— 界面侧的异常**不该拖垮任务**。
   *    这是「回调是纯通知」这条约定的落实。
   */
  const progress = (e: ProgressEvent): void => {
    try {
      args.onProgress?.(e);
    } catch {
      // 界面出错不影响编排
    }
  };
  const stage = (s: string, label: string): void => {
    progress({ kind: 'stage', stage: s, label });
  };
  const startedAt = args.clock.now();
  let inputTokens = 0;
  let outputTokens = 0;

  // ── ① 理解目标 ──
  stage('understand', '理解目标');
  log.append({
    type: 'thought.done',
    actor: 'butler',
    payload: { stage: 'understand', userGoal: args.userGoal },
    createdAt: args.clock.now(),
  });

  // ── ② 召回记忆（本阶段由调用方注入；检索层后续实现）──
  stage('recall', '召回记忆');
  log.append({
    type: 'memory.recalled',
    actor: 'butler',
    payload: {
      count: args.recalled.length,
      items: args.recalled.map((r) => ({
        id: r.memory.id,
        memClass: r.memory.memClass,
        relevance: r.relevance,
      })),
    },
    createdAt: args.clock.now(),
  });

  // ── ③ 路由 ──
  stage('route', '判断该由谁处理');
  const r = await route({
    model: args.model,
    userGoal: args.userGoal,
    ...(args.history !== undefined ? { history: args.history } : {}),
  });
  inputTokens += r.usage.inputTokens;
  outputTokens += r.usage.outputTokens;

  log.append({
    type: 'route.decided',
    actor: 'butler',
    payload: {
      servant: r.decision.servant,
      confidence: r.decision.confidence,
      reason: r.decision.reason,
      confident: r.confident,
      usage: r.usage,
      promptVersion: r.promptVersion,
    },
    createdAt: args.clock.now(),
  });

  /**
   * ── ★ 低置信度：记录假设，**但不阻断**（v7 · D-4）──
   *
   * ★★ 这里原先是一道**硬门**：
   *
   *     if (!r.confident) {
   *       return { steps: [], reports: [], … };   // 不派发、不执行、什么都不干
   *     }
   *
   *   后果（用户实测撞到过）：回复是一句
   *   「置信度不足，已转入澄清提问，未执行派发。」
   *   然后整轮就这么结束了 —— 用户去干别的回来一看，**什么也没做**。
   *
   * ⚠️ 这与项目目标直接冲突：
   *   · 产品目标是「自主完成，不要用户逐次审核」
   *   · 而这道门把"我不确定"变成了"我不干活"
   *   · **不确定 ≠ 不能干** —— 路由本来就已经给出了最可能的判断
   *
   * ★ 改成：**照最可能的理解先干，把假设明说出来，给一条纠正的路**。
   *   这样用户回来看到的是**结果 + 假设**，而不是**一个未回答的问题**。
   *
   * ⚠️ 例外（不适用本条）：**权限类**决定不能这样处理 ——
   *    判断错了可以改，删掉的文件回不来。见方案 D-17。
   */
  const assumption = buildRouteAssumption(r.confident, r.decision);

  if (assumption !== undefined) {
    log.append({
      type: 'route.assumed',
      actor: 'butler',
      payload: {
        servant: assumption.servant,
        confidence: assumption.confidence,
        note: assumption.note,
        // ⚠️ 事件名从 route.clarify 改为 route.assumed ——
        //    "clarify" 意味着"停下来问"，而现在的语义是"带着假设继续干"。
        //    保留旧名会让审计视图与实现语义脱节。
        ...(r.decision.clarifyingQuestion !== undefined
          ? { wouldHaveAsked: r.decision.clarifyingQuestion }
          : {}),
      },
      createdAt: args.clock.now(),
    });
  }

  // ── ④ 任务分解（内部完成约束注入）──
  stage('decompose', '拆解任务');
  const { dispatch } = await decompose({
    model: args.model,
    log,
    sessionId: args.sessionId,
    userGoal: args.userGoal,
    primaryServant: r.decision.servant,
    recalled: args.recalled,
    now: args.clock.now(),
    ...(args.history !== undefined ? { history: args.history } : {}),
  });

  // ── ⑤ 逐步派发（含依赖检查与上游产出传递）──
  stage('dispatch', '派发给仆人');
  const reports: ServantReport[] = [];
  const done = new Set<string>();
  /** 本次会话实际注入过的原则（收尾时做违背检测） */
  const injectedPrinciples: PrincipleCandidate[] = [];
  /** stepId → 该步骤的产出，供下游步骤使用 */
  const outputs = new Map<string, { servant: string; artifacts: ServantArtifact[]; findings: Finding[] }>();

  for (const step of dispatch.decomposition) {
    const missing = step.dependsOn.filter((d) => !done.has(d));
    if (missing.length > 0) {
      log.append({
        type: 'dispatch.stepFailed',
        actor: 'butler',
        payload: { stepId: step.stepId, reason: `依赖未满足：${missing.join(', ')}` },
        createdAt: args.clock.now(),
      });
      continue;
    }

    // 汇总上游产出 —— 这一步让 dependsOn 从"顺序控制"变成真正的"数据流"
    const inputs: UpstreamInput[] = step.dependsOn.flatMap((d) => {
      const o = outputs.get(d);
      if (!o) return [];
      return [{ stepId: d, servant: o.servant, artifacts: o.artifacts, findings: o.findings }];
    });

    // 管家自己汇总的步骤不派发
    if (step.servant === 'butler') {
      log.append({
        type: 'dispatch.stepDone',
        actor: 'butler',
        payload: {
          stepId: step.stepId,
          by: 'butler',
          note: '由管家汇总',
          inputCount: inputs.length,
        },
        createdAt: args.clock.now(),
      });
      done.add(step.stepId);
      continue;
    }

    // ★ 原则注入：挑出本次任务适用的已生效原则（方案 § 8.8「学了要用」）
    //   没有这一步，反思产出的原则永远不会被执行，principle.applied 也永远不会发出。
    const principleCandidates =
      args.store !== undefined
        ? selectPrinciples({
            store: args.store,
            task: `${args.userGoal}\n${step.instruction}`,
            servant: step.servant,
          })
        : [];

    if (args.store !== undefined && principleCandidates.length > 0) {
      // 记 applied +1 并落 principle.applied 事件
      recordInjection({
        log,
        store: args.store,
        clock: args.clock,
        taskId: step.stepId,
        candidates: principleCandidates,
      });
      injectedPrinciples.push(...principleCandidates);
    }

    log.append({
      type: 'dispatch.stepStarted',
      actor: 'butler',
      payload: {
        stepId: step.stepId,
        servant: step.servant,
        instruction: step.instruction,
        injectedConstraints: step.injectedConstraints,
        // 可审计：这一步拿到了哪些上游产出
        upstream: inputs.map((i) => i.stepId),
      },
      createdAt: args.clock.now(),
    });

    // ★ 界面进度：这一步开始了
    progress({
      kind: 'stepStarted',
      stepId: step.stepId,
      servant: step.servant,
      instruction: step.instruction,
      index: dispatch.decomposition.indexOf(step) + 1,
      total: dispatch.decomposition.length,
    });

    /**
     * ★★ 单步失败**不能拖垮整轮**。
     *
     *   ⚠️ 原实现让 `runServant` 的异常直接冒泡 ——
     *      一次真实对话因此中断在第三个仆人上：
     *      前两个仆人的产出、全部进度、以及最重要的**审查结论**
     *      都没能产生，用户看到的是「任务失败」而不是「哪一步失败了」。
     *
     *   而方案 § 13.4 明确要求：
     *     「仆人执行失败 → 该步骤标红 + 「重派」按钮，**不影响其他步骤**」
     *
     *   所以这里把异常收敛成一条 `blocked` 报告：
     *   它照样进 reports，于是审查层能看到"这一步没做成"，
     *   验收卡上也会如实标出来。
     */
    let run: Awaited<ReturnType<typeof runServant>>;
    try {
      run = await runServant({
        model: args.model,
        log,
        clock: args.clock,
        servant: step.servant,
        taskId: step.stepId,
        instruction: step.instruction,
        injectedConstraints: step.injectedConstraints,
        ...(inputs.length > 0 ? { inputs } : {}),
        ...(principleCandidates.length > 0
          ? {
              principles: principleCandidates.map((pc) => ({
                content: pc.principle.content,
                action: pc.principle.principle?.action ?? pc.principle.content,
                why: pc.why,
              })),
            }
          : {}),
        ...(args.tools !== undefined ? { tools: args.tools } : {}),
        // 仆人用**精简历史**（只有用户本轮原话）——它需要的是上游产出，
        // 不是对话的来龙去脉
        ...(args.servantHistory !== undefined ? { history: args.servantHistory } : {}),
        // ★ 工具循环的流式（给出才走）
        ...(args.streamPort !== undefined ? { streamPort: args.streamPort } : {}),
        ...(args.onAgentProgress !== undefined
          ? { onAgentProgress: args.onAgentProgress }
          : {}),
        now: args.clock.now(),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      log.append({
        type: 'dispatch.stepFailed',
        actor: 'servant',
        servantId: step.servant,
        payload: {
          stepId: step.stepId,
          servant: step.servant,
          reason,
          note: '单步失败已收敛，不影响其它步骤与审查',
        },
        createdAt: args.clock.now(),
      });

      progress({
        kind: 'stepFailed',
        stepId: step.stepId,
        servant: step.servant,
        reason,
      });

      // 收敛成一条 blocked 报告 —— 让审查层能看见「这一步没做成」
      reports.push({
        taskId: step.stepId,
        servant: step.servant,
        status: 'blocked',
        /**
         * ⚠️ 这里给的是**一句人话**，而不是空串。
         *
         *   其它 blocked 分支（模型没提交汇报）给空串是对的 ——
         *   那种情况确实"仆人没说话"。
         *   但这一步是**抛异常了**，用户必须知道发生了什么，
         *   否则界面上这个仆人会显示成一片空白，看起来像卡住了。
         */
        reply: `这一步没能完成：${reason}`,
        artifacts: [],
        findings: [],
        uncertainties: [`执行失败：${reason}`],
        memoryRefs: [],
      });
      continue;
    }
    inputTokens += run.usage.inputTokens;
    outputTokens += run.usage.outputTokens;
    reports.push(run.report);

    outputs.set(step.stepId, {
      servant: step.servant,
      artifacts: [...run.report.artifacts],
      findings: [...(run.report.findings ?? [])],
    });

    log.append({
      type: run.report.status === 'done' ? 'dispatch.stepDone' : 'dispatch.stepFailed',
      actor: 'butler',
      payload: { stepId: step.stepId, servant: step.servant, status: run.report.status },
      createdAt: args.clock.now(),
    });

    // ★ 界面进度：这一步结束了（带产出数量，界面据此显示"产出 2 项"）
    if (run.report.status === 'done') {
      progress({
        kind: 'stepDone',
        stepId: step.stepId,
        servant: step.servant,
        ok: true,
        artifactCount: run.report.artifacts.length,
        findingCount: run.report.findings?.length ?? 0,
      });
    } else {
      progress({
        kind: 'stepFailed',
        stepId: step.stepId,
        servant: step.servant,
        reason: run.report.uncertainties?.[0] ?? `状态：${run.report.status}`,
      });
    }

    if (run.report.status === 'done') done.add(step.stepId);
  }

  // ── ⑥ 硬约束机械校验（确定性，先于 LLM 监督）──
  stage('verify', '校验产出');
  // 方案 § 2.1：硬约束拦截是"管家对全局层第 1 类记忆的机械校验"，
  // 不能交给模型的严重性判断 —— 验证 1 的实测教训。
  const hardConstraintMemories = args.recalled.filter(
    (x) => x.memory.memClass === 'global_constraint',
  );
  const hardReport = verifyHardConstraints({
    log,
    hardConstraints: hardConstraintMemories,
    reports,
    now: args.clock.now(),
  });

  // ── ⑦ 管家监督（LLM：软约束、跨领域矛盾等需要理解力的判断）──
  stage('supervise', '监督与审查');
  const sup = await supervise({
    model: args.model,
    log,
    userGoal: args.userGoal,
    reports,
    hardConstraints: hardConstraintMemories.map((x) => x.memory.content),
    now: args.clock.now(),
  });
  inputTokens += sup.usage.inputTokens;
  outputTokens += sup.usage.outputTokens;

  // ── ⑦b 原则违背检测（方案 § 2.2③ 第三类检查）──
  //
  // ⚠️ 这是"效果验证"闭环的收尾：原则被注入了（applied +1），
  //    必须也检查它有没有被遵守 —— 否则 applied 只涨不验，创新点 ② 就是空的。
  //
  //    关键词初筛只做"疑似违背"的报告，最终判定交由监督层（上面 ⑦ 的 LLM）。
  //    与硬约束校验同一套分工：确定性的用代码，需要理解力的交给模型。
  let principleReport: {
    readonly checks: readonly PrincipleCheck[];
    readonly violated: readonly PrincipleCheck[];
  } = { checks: [], violated: [] };
  if (args.store !== undefined && injectedPrinciples.length > 0) {
    const check = checkPrinciples({
      injected: injectedPrinciples,
      reports: reports.map((r) => ({
        servant: r.servant,
        text: JSON.stringify(r.artifacts) + JSON.stringify(r.findings ?? []),
      })),
    });
    principleReport = check;

    for (const v of check.violated) {
      recordViolation({ log, taskId: args.sessionId, check: v, clock: args.clock });
    }
  }

  // ── ⑧ 产出物登记（供检查点回退预览说清"哪些产出会被取代"）──
  const artifacts: { readonly id: string; readonly label: string; readonly stepId: string }[] = [];
  for (const rep of reports) {
    for (const [i, art] of rep.artifacts.entries()) {
      const id = `art_${rep.servant}_${rep.taskId}_${i}`;
      const label = `${SERVANT_BOUNDARY[rep.servant].name}产出 ${i + 1}`;
      artifacts.push({ id, label, stepId: rep.taskId });
      log.append({
        type: 'artifact.created',
        actor: 'butler',
        payload: {
          artifactId: id,
          label,
          stepId: rep.taskId,
          servant: rep.servant,
          kind: art.kind,
          // 只记大小不记内容：内容体积大且不属于"状态"，
          // 状态由事件流表达（见 ADR 0002 与检查点设计）
          size: Array.isArray(art.content) ? art.content.length : String(art.content).length,
        },
        createdAt: args.clock.now(),
      });
    }
  }

  log.append({
    type: 'session.ended',
    actor: 'butler',
    payload: {
      totalEvents: log.length,
      model: args.model.describe(),
      artifactCount: artifacts.length,
    },
    createdAt: args.clock.now(),
  });

  return {
    log,
    routing: r.decision,
    // ⚠️ 这里用**真实的** `r.confident`，不是写死 true ——
    //    低置信度时这一轮**确实干完活了**，只是带着一个假设。
    //    写死 true 会让上层无法把假设告诉用户。
    confident: r.confident,
    ...(assumption !== undefined ? { assumption } : {}),
    steps: dispatch.decomposition,
    reports,
    supervision: sup.output,
    hardConstraints: hardReport,
    principles: {
      injected: injectedPrinciples,
      checks: principleReport.checks,
      violated: principleReport.violated,
    },
    artifacts,
    totalUsage: { inputTokens, outputTokens },
    modelInfo: args.model.describe(),
    startedAt,
    endedAt: args.clock.now(),
  };
}
