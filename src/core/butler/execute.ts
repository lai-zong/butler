/**
 * 管家执行器 —— 「管家自己干」（v7 · D-2 / B6）
 *
 * ★★ 这是替代 `runServant` 的执行入口。
 *
 * ═══ 与 `runServant` 的三处根本区别 ═══
 *
 *   | | runServant（旧）| runButler（新）|
 *   |---|---|---|
 *   | 人格提示词 | `servantSystem(servant)` —— 五个领域各一套 | **`BUTLER_SYSTEM`** —— 一个管家 |
 *   | 任务说明 | `servantTask(instruction, constraints)` —— 别人给的指令 | **契约 + 自己的判断** |
 *   | 工具白名单 | `SERVANT_TOOL_POLICY[servant]` —— 每个仆人不同权限 | **无按领域区分**（权限统一由故障闸门管）|
 *
 *   ⚠️ 第三行是**安全语义的变化**，必须说清：
 *     旧架构里"健康仆人不能写文件、代码仆人才能执行命令"是**按领域分权**。
 *     新架构只有一个执行者，按领域分权失去意义 ——
 *     权限改由 `ToolFramework` 的**分级闸门**统一管（readOnly/normal/highRisk/dangerous）。
 *     **这不是放宽安全**：分级闸门本来就比"按领域白名单"更严格、更可审计。
 *
 * ═══ 保留了什么 ═══
 *
 *   · 工具循环（`runAgentLoop`）—— 多轮思考 + 调用工具
 *   · `submit_report` 终止工具 —— 结构化汇报，不靠自由文本
 *   · 产出归一化（artifacts / findings / uncertainties）
 *   · 流式进度回调（界面"边说边想"画面的来源）
 */

import type { ClockPort } from '../ports/clock.js';
import { msg, type ModelMessage, type ModelPort } from '../ports/model.js';
import type { ModelStreamPort } from '../ports/stream.js';
import type { EventLog } from '../events/log.js';
import type { ToolFramework } from '../tools/framework.js';
import { runAgentLoop, type AgentProgressEvent } from '../tools/agentLoop.js';
import { submitReportTool } from '../tools/builtin/report.js';
import {
  normalizeArtifact as normalizeArtifactShape,
  normalizeFinding as normalizeFindingShape,
  normalizeReport,
  servantReportSchema,
  type ServantReportOutput,
} from '../prompts/schemas.js';
import { BUTLER_SYSTEM, butlerExecuteTask, PROMPT_VERSIONS } from '../prompts/butler.js';
import type { TaskContract } from './contract.js';
import type { DomainId } from '../domain/types.js';
import type {
  Finding,
  InjectedConstraint,
  ServantArtifact,
  ServantReport,
} from '../servants/types.js';

/** 管家回复的长度上限（与仆人一致，避免超长正文挤掉工具过程）。 */
export const BUTLER_REPLY_LIMIT = 4_000;

export interface ButlerRunArgs {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly taskId: string;
  /** 任务契约 —— 管家自己写的，也是监督员核对的唯一标准 */
  readonly contract: TaskContract;
  /** 注入的约束（硬约束 + 相关软约束） */
  readonly injectedConstraints: readonly InjectedConstraint[];
  /** 用户原话（供指代理解） */
  readonly userGoal: string;
  /** 对话历史（精简版） */
  readonly history?: readonly ModelMessage[];
  readonly streamPort?: ModelStreamPort;
  readonly onAgentProgress?: (e: AgentProgressEvent) => void;
  /** 工具框架。不给时走单次结构化输出（纯推理场景） */
  readonly tools?: ToolFramework;
  readonly maxRounds?: number;
  readonly now: number;
}

export interface ButlerRunResult {
  /** 汇报（形状与 `ServantReport` 兼容，但**不带仆人身份**，改带领域标签） */
  readonly report: ServantReport;
  readonly raw: ServantReportOutput;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly attempts: number;
  readonly promptVersions: readonly string[];
}

/**
 * 跑一次管家执行。
 *
 * ★ 与 `runServant` 一样支持两条路径：
 *   有 `tools` → 工具循环（能读写文件、跑命令）
 *   无 `tools` → 单次结构化输出（省一轮 token，验证脚本与纯推理用它）
 */
export async function runButler(args: ButlerRunArgs): Promise<ButlerRunResult> {
  const baseMessages: ModelMessage[] = [
    msg.system(BUTLER_SYSTEM),
    ...(args.history ?? []),
    msg.user(
      butlerExecuteTask({
        userGoal: args.userGoal,
        contract: args.contract,
        injectedConstraints: args.injectedConstraints,
      }),
    ),
  ];

  const { raw, usage, attempts } = args.tools
    ? await runWithTools(args, baseMessages)
    : await runSingleShot(args, baseMessages);

  // ── 归一化：把模型的多种自然写法收敛成领域模型 ──
  // ⚠️ 复用 `schemas.ts` 里现成的实现，不自己重写 ——
  //    那两个函数处理了模型的各种别名（kind/type、statement/content、items 嵌套对象），
  //    重写必然漏掉其中某一种，而漏掉的表现是"产出悄悄少了一条"。
  const artifacts: ServantArtifact[] = [];
  for (const a of raw.artifacts) {
    const n = normalizeArtifactShape(a);
    if (!n) continue; // 空产出直接丢弃，不制造空条目
    artifacts.push(
      n.kind === 'text'
        ? { kind: 'text', content: n.content }
        : {
            kind: n.kind,
            content: n.content
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length > 0),
          },
    );
  }

  const findings = raw.findings
    .map(normalizeFindingShape)
    .filter((f): f is Finding => f !== null);

  // ⚠️ `needsButlerDecision` 可能被模型写成 bool 或 null，现成函数会归一化
  const decision = normalizeReport(raw).needsButlerDecision;

  const mainDomain: DomainId | undefined = args.contract.domains[0];

  const report: ServantReport = {
    taskId: args.taskId,
    /**
     * ⚠️ 过渡字段：`ServantReport.servant` 仍是必填（旧类型），
     *    但管家没有"仆人身份"。这里填契约的主领域 —— 语义从
     *    "哪个仆人在干"变成"这件事属于哪个领域"。
     *
     *    ★ 下一步会把 `servant` 从 `ServantReport` 里彻底删掉、改为 `domain`。
     *      现在填领域而不是随便填一个仆人，是为了**让数据不撒谎**。
     */
    // ★ 诚实：没有领域就不写（旧写法 `?? 'life'` 会编造归属）
    ...(mainDomain !== undefined ? { domain: mainDomain } : {}),
    status: raw.status,
    reply: raw.reply.trim().slice(0, BUTLER_REPLY_LIMIT),
    artifacts,
    memoryRefs: args.injectedConstraints.map((c) => c.memoryId),
    uncertainties: raw.uncertainties,
    ...(decision !== undefined ? { needsButlerDecision: decision } : {}),
    findings,
  };

  args.log.append({
    type: 'butler.executed',
    actor: 'butler',
    payload: {
      taskId: args.taskId,
      status: report.status,
      rounds: 0,
      artifacts: artifacts.length,
      findings: findings.length,
      uncertainties: report.uncertainties.length,
      domains: args.contract.domains,
      usage,
    },
    createdAt: args.now,
  });

  return {
    report,
    raw,
    usage,
    attempts,
    promptVersions: [PROMPT_VERSIONS.butlerSystem, PROMPT_VERSIONS.butlerExecuteTask],
  };
}

// ═══════════════════════════════════════════════════════════
// 两条执行路径
// ═══════════════════════════════════════════════════════════

async function runSingleShot(
  args: ButlerRunArgs,
  messages: readonly ModelMessage[],
): Promise<{ raw: ServantReportOutput; usage: ButlerRunResult['usage']; attempts: number }> {
  const result = await args.model.completeStructured({
    purpose: 'servant',
    schema: servantReportSchema,
    schemaName: 'ServantReport',
    thinking: 'disabled',
    temperature: 0.2,
    maxOutputTokens: 3_072,
    messages,
  });
  return { raw: result.value, usage: result.usage, attempts: result.attempts };
}

async function runWithTools(
  args: ButlerRunArgs,
  messages: readonly ModelMessage[],
): Promise<{ raw: ServantReportOutput; usage: ButlerRunResult['usage']; attempts: number }> {
  const tools = args.tools;
  if (!tools) throw new Error('runWithTools 需要 tools');

  tools.register(submitReportTool(), { overwrite: true });

  const loop = await runAgentLoop(
    {
      model: args.model,
      tools,
      log: args.log,
      clock: args.clock,
      taskId: args.taskId,
      /**
       * ★ 与旧 `runServant` 的关键差别：**没有按领域的工具白名单**。
       *   只排除终止工具本身（它由循环内部处理）。
       *   权限由 `ToolFramework` 的分级闸门统一管 —— 那比按领域白名单更严格。
       */
      toolFilter: (t) => t.name === 'submit_report' || t.tier !== 'dangerous',
      ...(args.maxRounds !== undefined ? { maxRounds: args.maxRounds } : {}),
      terminalTool: 'submit_report',
      ...(args.streamPort !== undefined ? { streamPort: args.streamPort } : {}),
      ...(args.onAgentProgress !== undefined ? { onProgress: args.onAgentProgress } : {}),
    },
    messages,
  );

  // 终止工具的参数就是结构化汇报
  const last = loop.traces[loop.traces.length - 1];
  const submitted = last?.toolName === 'submit_report' ? last.args : undefined;

  if (submitted === undefined) {
    /**
     * ⚠️ 循环结束但没提交汇报 —— 不编造一个"成功"。
     *    如实返回 failed + 把模型的最后文本作为 reply，让上层看得见发生了什么。
     */
    return {
      raw: {
        reply: loop.finalText.slice(0, BUTLER_REPLY_LIMIT),
        status: loop.hitRoundLimit ? 'failed' : 'blocked',
        artifacts: [],
        uncertainties: [
          loop.hitRoundLimit
            ? '达到工具调用轮次上限，未能完成汇报'
            : '未能产出结构化汇报',
        ],
        findings: [],
      },
      usage: loop.usage,
      attempts: 1,
    };
  }

  const parsed = servantReportSchema.safeParse(submitted);
  if (!parsed.success) {
    return {
      raw: {
        reply: loop.finalText.slice(0, BUTLER_REPLY_LIMIT),
        status: 'failed',
        artifacts: [],
        uncertainties: [`汇报格式不合法：${parsed.error.issues[0]?.message ?? '未知'}`],
        findings: [],
      },
      usage: loop.usage,
      attempts: 1,
    };
  }

  return { raw: parsed.data, usage: loop.usage, attempts: 1 };
}


