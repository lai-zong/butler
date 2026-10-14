/**
 * 端到端编排 —— 一次完整会话
 *
 * 把路由 → 分解 → 派发 → 汇报 → 校验串起来，全程写入事件日志。
 *
 * 这是**验证脚本与未来 UI 共用的入口**：
 * UI 只是把这个流程的事件流渲染出来，不额外承载业务逻辑。
 */

import { decompose, type RecallResult } from '../butler/dispatch.js';
import { route } from '../butler/router.js';
import { verifyHardConstraints, type HardConstraintReport } from '../butler/hardConstraints.js';
import { supervise } from '../butler/supervisor.js';
import { EventLog } from '../events/log.js';
import { runServant } from '../servants/execute.js';
import type {
  DispatchStep,
  Finding,
  ServantArtifact,
  ServantReport,
  UpstreamInput,
} from '../servants/types.js';
import type { ClockPort, ModelPort } from '../ports/index.js';
import type { SupervisionOutput } from '../prompts/schemas.js';
import type { RoutingDecision } from '../prompts/schemas.js';

export interface RunSessionArgs {
  readonly model: ModelPort;
  readonly clock: ClockPort;
  readonly sessionId: string;
  readonly userGoal: string;
  readonly recalled: readonly RecallResult[];
}

export interface RunSessionResult {
  readonly log: EventLog;
  readonly routing: RoutingDecision;
  readonly confident: boolean;
  readonly steps: readonly DispatchStep[];
  readonly reports: readonly ServantReport[];
  readonly supervision: SupervisionOutput;
  /** 硬约束机械校验结果（确定性判定，见 hardConstraints.ts） */
  readonly hardConstraints: HardConstraintReport;
  readonly totalUsage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly modelInfo: { readonly provider: string; readonly model: string };
  readonly startedAt: number;
  readonly endedAt: number;
}

export async function runSession(args: RunSessionArgs): Promise<RunSessionResult> {
  const log = new EventLog(args.sessionId);
  const startedAt = args.clock.now();
  let inputTokens = 0;
  let outputTokens = 0;

  // ── ① 理解目标 ──
  log.append({
    type: 'thought.done',
    actor: 'butler',
    payload: { stage: 'understand', userGoal: args.userGoal },
    createdAt: args.clock.now(),
  });

  // ── ② 召回记忆（本阶段由调用方注入；检索层后续实现）──
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
  const r = await route({ model: args.model, userGoal: args.userGoal });
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

  if (!r.confident) {
    log.append({
      type: 'route.clarify',
      actor: 'butler',
      payload: {
        question: r.decision.clarifyingQuestion ?? '(模型未给出澄清问题)',
        confidence: r.decision.confidence,
      },
      createdAt: args.clock.now(),
    });
    // 低置信度不猜测 —— 返回，交由上层向用户提问
    return {
      log,
      routing: r.decision,
      confident: false,
      steps: [],
      reports: [],
      supervision: { conflicts: [], summary: '置信度不足，已转入澄清提问，未执行派发。' },
      hardConstraints: { verdicts: [], mustBlock: false },
      totalUsage: { inputTokens, outputTokens },
      modelInfo: args.model.describe(),
      startedAt,
      endedAt: args.clock.now(),
    };
  }

  // ── ④ 任务分解（内部完成约束注入）──
  const { dispatch } = await decompose({
    model: args.model,
    log,
    sessionId: args.sessionId,
    userGoal: args.userGoal,
    primaryServant: r.decision.servant,
    recalled: args.recalled,
    now: args.clock.now(),
  });

  // ── ⑤ 逐步派发（含依赖检查与上游产出传递）──
  const reports: ServantReport[] = [];
  const done = new Set<string>();
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

    const run = await runServant({
      model: args.model,
      log,
      servant: step.servant,
      taskId: step.stepId,
      instruction: step.instruction,
      injectedConstraints: step.injectedConstraints,
      ...(inputs.length > 0 ? { inputs } : {}),
      now: args.clock.now(),
    });
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
    if (run.report.status === 'done') done.add(step.stepId);
  }

  // ── ⑥ 硬约束机械校验（确定性，先于 LLM 监督）──
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

  log.append({
    type: 'session.ended',
    actor: 'butler',
    payload: { totalEvents: log.length, model: args.model.describe() },
    createdAt: args.clock.now(),
  });

  return {
    log,
    routing: r.decision,
    confident: true,
    steps: dispatch.decomposition,
    reports,
    supervision: sup.output,
    hardConstraints: hardReport,
    totalUsage: { inputTokens, outputTokens },
    modelInfo: args.model.describe(),
    startedAt,
    endedAt: args.clock.now(),
  };
}
