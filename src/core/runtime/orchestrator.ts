/**
 * 端到端编排 —— 一次完整会话
 *
 * 把路由 → 分解 → 派发 → 汇报 → 校验串起来，全程写入事件日志。
 *
 * 这是**验证脚本与未来 UI 共用的入口**：
 * UI 只是把这个流程的事件流渲染出来，不额外承载业务逻辑。
 */

import { writeContract } from '../butler/contract.js';
import { runButler } from '../butler/execute.js';
import { verifyHardConstraints, type HardConstraintReport } from '../butler/hardConstraints.js';
import { supervise, type NormalizedSupervisionOutput } from '../butler/supervisor.js';
import { EventLog } from '../events/log.js';
import { domainName } from '../domain/types.js';
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
import type { InjectedConstraint, DomainId, ExecutionReport } from '../execution/types.js';
import type { TaskContract } from '../butler/contract.js';
import type { ClockPort, ModelMessage, ModelPort } from '../ports/index.js';
import type { ModelStreamPort } from '../ports/stream.js';
import type { AgentProgressEvent } from '../tools/agentLoop.js';
import type { ApprovalAsker } from '../tools/approval.js';

export interface RunSessionArgs {
  readonly model: ModelPort;
  readonly clock: ClockPort;
  readonly sessionId: string;
  readonly userGoal: string;
  /**
   * 本轮附带的图片（**只在这一轮有效**，不落历史、不进事件）。
   * 见 `ButlerRunArgs.images` 的说明。
   */
  readonly images?: readonly {
    readonly url: string;
    readonly detail?: 'low' | 'high' | 'original' | 'auto';
  }[];

  /**
   * 本轮专用的询问通道（C6 询问开关）。
   *
   * ★ 有它时"需要确认"的动作会**真的停下来问用户**（SSE 推确认请求）；
   *   没有它时退回策略默认实现（Web 版直接拒绝）—— 与改造前一致。
   */
  readonly asker?: ApprovalAsker;
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
  readonly domainHistory?: readonly ModelMessage[];
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

/**
 * 编排进度事件。
 *
 * ★★ v8：原来有 `stepStarted` / `stepDone` / `stepFailed` 三个变体
 *    （带 `stepId` / `index` / `total`），那是**多步派发**时代的协议形状。
 *
 * ⚠️ 已删除，两点证据：
 *   ① 单执行者架构里「步骤」不存在 —— 之前的代码只是把它写死成
 *      `stepId: 'execute'` + `index: 1, total: 1` 来模拟「一步」，
 *      字段本身仍在暗示「有多步」。
 *   ② 这三个变体**没有任何消费者** —— `route.ts` 原样转发成
 *      SSE `{type:'progress'}`，而客户端 `conversation.tsx` 只处理
 *      `session`/`agent`/`narration`/`reply`/`reports`/`verdict`/`error`，
 *      **没有 `progress` 分支**。
 *
 *    ⚠️ 也就是说这条通道整体是**死的**（`stage` 也无人消费）。
 *       保留 `stage` 是因为它是通用形态、后续可能接界面；
 *       但**不要再基于它做新功能而不接消费端**。
 */
export type ProgressEvent = { readonly kind: 'stage'; readonly stage: string; readonly label: string };

export interface RunSessionResult {
  readonly log: EventLog;
  // ★★ v8（批次C）：原有的 `routing` 与 `confident` 两个字段已删除 ——
  //    它们来自**独立的 `route()` 调用**（`{servant, confidence, reason}`），
  //    而那次调用已并入写契约（方案 D-3）。
  //
  //    现在读这两样东西：
  //      · 领域    → `contract.domains`
  //      · 置信度  → `contract.confidence`
  //      · 要不要说明假设 → `assumption !== undefined`
  //        （低置信度时**照样干完活**，只是把假设告诉用户 · D-4）
  /**
   * 置信度不足时"按什么假设继续干的"（v7 · D-4）。
   *
   * ★ 与旧的"停下来问用户"不同：这里是**已经干完了**，
   *   只是要把假设告诉用户，让他知道"如果我理解偏了，说一声就重来"。
   *
   * `undefined` 表示置信度足够，没有假设需要说明。
   */
  readonly assumption?: {
    /** 假设涉及的领域（原 `servant` —— 它装的一直是领域值）*/
    readonly domains: readonly DomainId[];
    readonly confidence: number;
    readonly note: string;
    /** 本该向用户澄清的问题（现在不阻断，只是记录下来）*/
    readonly wouldHaveAsked?: string;
  };
  /**
   * 任务契约（v7 · D-5）—— 「要做什么」的权威描述。
   *
   * ★ 里面写着：交付物、判据、硬约束、涉及领域。
   *   监督员用它当核对标准，界面用它展示「这次答应做什么」。
   */
  readonly contract?: TaskContract;
  /**
   * 实际注入给执行的约束（v7）。
   *
   * ⚠️ 旧架构从 `steps[].injectedConstraints` 取，但那是「每步各自的约束」。
   *    现在只有一次执行 —— 约束是**整轮一份**，直接挂在结果上。
   */
  readonly injectedConstraints: readonly InjectedConstraint[];
  readonly reports: readonly ExecutionReport[];
  readonly supervision: NormalizedSupervisionOutput;
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
/**
 * 由契约的置信度构造「假设」说明（低置信度不阻断执行 · D-4）。
 *
 * ★★ v8（批次C）：入参从**路由结果**改为**契约**。
 *    原签名 `buildRouteAssumption(confident, {servant, confidence, clarifyingQuestion})`
 *    里的 `servant` 其实是领域值 —— 现在直接叫 `domains`。
 *
 * ⚠️ 阈值仍是 0.6：与提示词里"低于 0.6 就写 clarifyingQuestion"一致。
 *    两处必须同步，否则会出现"模型觉得该问、系统觉得不用问"。
 */
export function buildAssumption(
  contract: Pick<TaskContract, 'domains' | 'confidence' | 'clarifyingQuestion'>,
): RunSessionResult['assumption'] {
  if (contract.confidence >= CONFIDENCE_THRESHOLD) return undefined;

  const asked = contract.clarifyingQuestion?.trim() ?? '';
  const where = contract.domains.map(domainName).join('、');
  const head = `我不太确定你的意思，先按「${where}」这件事处理了。`;

  return {
    domains: contract.domains,
    confidence: contract.confidence,
    note:
      asked.length > 0
        ? `${head}如果我理解偏了，你其实是想问「${asked}」—— 直接说，我重来。`
        : `${head}不对的话直接说，我重来。`,
    ...(asked.length > 0 ? { wouldHaveAsked: asked } : {}),
  };
}

/**
 * 置信度阈值：低于它就记录一条「假设」告诉用户（但不阻断执行 · D-4）。
 *
 * ⚠️ 必须与提示词里的措辞一致 —— contractSchema.confidence 的 describe 写着
 *    「confidence < 0.6 时填 clarifyingQuestion」。两处不同步会出现
 *    「模型觉得该问、系统觉得不用问」的静默错位。
 */
const CONFIDENCE_THRESHOLD = 0.6;

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


  // ── ④ 写任务契约（v7 · D-5，替代原来的 route + decompose）──
  //
  // ★★ 这里合并了两件旧事：
  //   ① `route()`  —— 判断该派给谁。**砍掉**（D-3）：实测 4/4 全判同一个领域，
  //      没有信息量；真正的多领域由"拆解"完成。
  //   ② `decompose()` —— 拆成多步派发。**改为写契约**（D-2）：
  //      只有一个执行者，拆步骤没有意义。
  //
  //   ★ 但保留了 `decompose` 里真正有价值的部分：
  //     按相关性筛选要注入的约束（管家自己干同样需要知道哪些约束相关）。
  stage('contract', '写任务契约');
  const written = await writeContract({
    model: args.model,
    log,
    sessionId: args.sessionId,
    userGoal: args.userGoal,
    recalled: args.recalled,
    now: args.clock.now(),
    ...(args.history !== undefined ? { history: args.history } : {}),
  });
  inputTokens += written.usage.inputTokens;
  outputTokens += written.usage.outputTokens;
  const contract = written.contract;

  /**
   * ── ★ 低置信度：记录假设，**但不阻断**（v7 · D-4；v8 批次C 改为读契约）──
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
   * ⚠️ 这与项目目标直接冲突：产品目标是「自主完成，不要用户逐次审核」，
   *   而那道门把「我不确定」变成了「我不干活」。**不确定 ≠ 不能干。**
   *
   * ★ 现在是：**照最可能的理解先干，把假设明说出来，给一条纠正的路**。
   *
   * ★ v8（批次C）：置信度来源从**独立的 `route()` 调用**改为**契约自带的
   *   `confidence`** —— 写契约时模型已经在读同一句话，不必再问一遍。
   *
   * ⚠️ 例外（不适用本条）：**权限类**决定不能这样处理 ——
   *    判断错了可以改，删掉的文件回不来。见方案 D-17。
   */
  const assumption = buildAssumption(contract);

  if (assumption !== undefined) {
    log.append({
      type: 'route.assumed',
      actor: 'butler',
      payload: {
        domains: contract.domains,
        confidence: assumption.confidence,
        note: assumption.note,
        // ⚠️ 事件名从 route.clarify 改为 route.assumed ——
        //    "clarify" 意味着"停下来问"，而现在的语义是"带着假设继续干"。
        ...(assumption.wouldHaveAsked !== undefined
          ? { wouldHaveAsked: assumption.wouldHaveAsked }
          : {}),
      },
      createdAt: args.clock.now(),
    });
  }

  // ── ⑤ 管家自己干（v7 · D-2 / B6）──
  //
  // ★★ 这一步替代了原来的"逐步派发"循环（220 行）。
  //    旧循环做的事（依赖检查、上游产出传递、逐步骤事件）全都消失了 ——
  //    因为只有一个执行者，没有"步骤之间"这回事。
  //
  //   ⚠️ 保留了两样东西，它们与"多仆人"无关、但仍然需要：
  //     · **原则注入**（§8.8「学了要用」）—— 反思产出的原则要被执行
  //     · **进度事件** —— 界面「边说边想」画面的来源
  stage('execute', '开始执行');

  const reports: ExecutionReport[] = [];
  /** 本次会话实际注入过的原则（收尾时做违背检测） */
  const injectedPrinciples: PrincipleCandidate[] = [];

  // ★ 原则注入：挑出本次任务适用的已生效原则
  //   没有这一步，反思产出的原则永远不会被执行，principle.applied 也永远不会发出。
  const principleCandidates =
    args.store !== undefined
      ? selectPrinciples({
          store: args.store,
          task: args.userGoal,
          // ⚠️ 单执行者下"哪个仆人"这个参数改成"主领域" ——
          //    原则仍按领域加权（本领域的原则更相关），只是没有仆人身份了。
          ...(contract.domains[0] !== undefined ? { domain: contract.domains[0] } : {}),
        })
      : [];

  if (args.store !== undefined && principleCandidates.length > 0) {
    recordInjection({
      log,
      store: args.store,
      clock: args.clock,
      taskId: args.sessionId,
      candidates: principleCandidates,
    });
    injectedPrinciples.push(...principleCandidates);
  }

  // ★ 进度：开始执行
  //
  // ⚠️ v8：原来发的是 `stepStarted`（带 stepId/index/total，多步派发语义）。
  //    已改为通用 `stage` —— 单执行者架构没有「步骤」。
  progress({ kind: 'stage', stage: 'execute', label: `开始执行：${contract.deliverable.slice(0, 24)}` });

  const injectedConstraints = written.constraints.map((c) => ({
    memoryId: c.memoryId,
    content: c.content,
    source: c.source,
    negotiable: c.negotiable,
  }));

  let run: Awaited<ReturnType<typeof runButler>>;
  try {
    run = await runButler({
      model: args.model,
      log,
      clock: args.clock,
      taskId: args.sessionId,
      contract,
      injectedConstraints,
      userGoal: args.userGoal,
      // ★ 本轮图片透传给管家执行层（模型在那里才真正看到图）
      ...(args.images !== undefined && args.images.length > 0 ? { images: args.images } : {}),
      // ★ 询问通道（C6）继续往下传
      ...(args.asker !== undefined ? { asker: args.asker } : {}),
      ...(args.domainHistory !== undefined ? { history: args.domainHistory } : {}),
      ...(args.streamPort !== undefined ? { streamPort: args.streamPort } : {}),
      ...(args.onAgentProgress !== undefined ? { onAgentProgress: args.onAgentProgress } : {}),
      ...(args.tools !== undefined ? { tools: args.tools } : {}),
      now: args.clock.now(),
    });
  } catch (err) {
    /**
     * ⚠️ 执行抛异常 — **不让整轮失败**，而是产出一份"失败的汇报"。
     *
     *   理由（与旧实现一致）：用户必须知道发生了什么，
     *   否则界面上会显示成一片空白，看起来像卡住了。
     */
    const reason = err instanceof Error ? err.message : String(err);
    run = {
      report: {
        taskId: args.sessionId,
        // ★ 诚实：领域为空就不写，不编造
        ...(contract.domains[0] !== undefined ? { domain: contract.domains[0] } : {}),
        status: 'failed',
        reply: `这次没能完成：${reason}`,
        artifacts: [],
        findings: [],
        uncertainties: [`执行失败：${reason}`],
        memoryRefs: [],
      },
      raw: {
        reply: `这次没能完成：${reason}`,
        status: 'failed',
        artifacts: [],
        findings: [],
        uncertainties: [`执行失败：${reason}`],
      },
      usage: { inputTokens: 0, outputTokens: 0 },
      attempts: 0,
      promptVersions: [],
    };
  }

  inputTokens += run.usage.inputTokens;
  outputTokens += run.usage.outputTokens;
  reports.push(run.report);

  // ★ 进度：执行结束
  //
  // ⚠️ v8：原来发 `stepDone` / `stepFailed`（多步派发语义），已改为通用 `stage`。
  if (run.report.status === 'done') {
    const arts = run.report.artifacts.length;
    const finds = run.report.findings?.length ?? 0;
    progress({ kind: 'stage', stage: 'executed', label: `执行完成（${arts} 项产出、${finds} 条发现）` });
  } else {
    progress({
      kind: 'stage',
      stage: 'executeFailed',
      label: `执行未完成：${run.report.uncertainties?.[0] ?? run.report.status}`,
    });
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

  // ── ⑦ 管家监督（v7 · D-7 三视角：契约 / 领域 / 全局）──
  stage('supervise', '监督与审查');
  const sup = await supervise({
    model: args.model,
    log,
    userGoal: args.userGoal,
    // ★ 契约是核对的唯一标准 —— 没有它，监督员只能凭感觉评价
    contract,
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
        // ⚠️ checkPrinciples 的参数名仍是 servant（遗留），此处传领域值
        domain: r.domain ?? '',
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
      const id = `art_${rep.domain ?? ''}_${rep.taskId}_${i}`;
      /**
       * ★ v7（批次2）：产出物的显示标签不再查 `SERVANT_BOUNDARY`。
       *
       * ⚠️ 原来写 `SERVANT_BOUNDARY[rep.servant].name` —— 用领域值去查
       *    「仆人边界表」的名字。领域为空时还会直接抛 TypeError（查 undefined）。
       *
       * ✅ 改为直接用领域名；没有领域就写「未标注领域」——**不编造**。
       */
      const label = `${rep.domain !== undefined ? domainName(rep.domain) : '未标注领域'}产出 ${i + 1}`;
      artifacts.push({ id, label, stepId: rep.taskId });
      log.append({
        type: 'artifact.created',
        actor: 'butler',
        payload: {
          artifactId: id,
          label,
          stepId: rep.taskId,
          // ⚠️ 产出物事件的字段名仍是 servant（属事件线格式，批次1b 统一处理）`n          servant: rep.domain ?? '',
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
    /**
     * ★★ v8（批次C）：`routing` 字段已删除 —— 它装的是**独立路由调用**的产物
     *    （`{servant, confidence, reason}`），而那次调用已经并入写契约。
     *
     * ⚠️ 原来读 `result.routing.servant` 的地方，现在读
     *    `result.contract.domains`（领域）与 `result.contract.confidence`（置信度）。
     */
    ...(assumption !== undefined ? { assumption } : {}),
    contract,
    injectedConstraints,
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
