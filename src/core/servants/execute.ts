/**
 * 仆人 · 执行与结构化汇报
 *
 * 设计依据：方案 § 2.1（平等编排）、§ 2.2②（仆人汇报）
 *
 * 注意：
 * - 仆人**只提交 findings（发现 + 证据），不做裁决**
 * - `uncertainties` 是诚实声明，不是客套话
 * - 本阶段仆人尚无工具；工具将在后续提交引入（届时循环会带上 toolCalls）
 */

import { EventLog } from '../events/log.js';
import { msg, type ModelMessage, type ModelPort } from '../ports/model.js';
import type { ClockPort } from '../ports/clock.js';
import { runAgentLoop } from '../tools/agentLoop.js';
import { extractReport, submitReportTool } from '../tools/builtin/report.js';
import type { ToolFramework } from '../tools/framework.js';
import type { ActionTier } from '../tools/types.js';
import { PROMPT_VERSIONS, servantSystem, servantTask } from '../prompts/butler.js';
import {
  normalizeArtifact,
  normalizeFinding,
  normalizeReport,
  servantReportSchema,
  type ServantReportOutput,
} from '../prompts/schemas.js';
import type {
  InjectedConstraint,
  ServantArtifact,
  ServantId,
  ServantReport,
  UpstreamInput,
} from '../servants/types.js';

export interface ServantRunResult {
  readonly report: ServantReport;
  readonly raw: ServantReportOutput;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly attempts: number;
  readonly promptVersions: readonly string[];
}

/**
 * 上游产出物传给下游时的截断上限。
 *
 * 取舍依据：下游要判断的是"上游做出来的东西对不对"，
 * 需要看到**实质内容**，但不需要看到上游的逐条实现细节。
 * 实测：健康仆人拿到截断后的菜单，已能指出
 * "喷雾油或菜籽油/橄榄油"的"或"字表述存在被替换成花生调和油的风险" ——
 * 这类实质结论不依赖完整长度。
 */
const UPSTREAM_ARTIFACT_CHAR_LIMIT = 1200;
const UPSTREAM_MAX_ITEMS = 40;
const UPSTREAM_MAX_FINDINGS = 5;

function trimArtifact(a: ServantArtifact): ServantArtifact {
  switch (a.kind) {
    case 'text':
      return a.content.length <= UPSTREAM_ARTIFACT_CHAR_LIMIT
        ? a
        : { kind: 'text', content: `${a.content.slice(0, UPSTREAM_ARTIFACT_CHAR_LIMIT)}…（已截断）` };

    case 'list':
    case 'plan':
      return a.content.length <= UPSTREAM_MAX_ITEMS
        ? a
        : {
            kind: a.kind,
            content: [
              ...a.content.slice(0, UPSTREAM_MAX_ITEMS),
              `…（另有 ${a.content.length - UPSTREAM_MAX_ITEMS} 条，已省略）`,
            ],
          };

    case 'file':
      // 文件引用本身很小，原样透传
      return a;
  }
}

/**
 * 仆人可用的工具集（按领域收窄）。
 *
 * ⚠️ 这是**能力声明**，不是安全边界 —— 安全由 ToolFramework 的闸门负责。
 *    收窄的理由是"减少干扰、降低选错工具的概率"：
 *    健康仆人不需要执行命令，给它那个工具只会增加误用机会。
 *
 * 领域差异的依据是职责边界表（生活=去哪买什么 / 代码=怎么实现）。
 */
export const SERVANT_TOOL_POLICY: Record<
  ServantId,
  { readonly allowTiers: readonly ActionTier[]; readonly includeTerminal: boolean }
> = {
  // 生活：查资料、读写清单。不需要执行命令。
  life: { allowTiers: ['readOnly', 'normal'], includeTerminal: true },
  // 健康：主要做核对与评估，写文件都很少。
  health: { allowTiers: ['readOnly'], includeTerminal: true },
  // 学习：整理资料，需要读写。
  study: { allowTiers: ['readOnly', 'normal'], includeTerminal: true },
  // 办公：文档处理，需要读写与移动。
  work: { allowTiers: ['readOnly', 'normal', 'highRisk'], includeTerminal: true },
  // 代码：需要执行命令（跑测试、装依赖）。
  code: { allowTiers: ['readOnly', 'normal', 'highRisk'], includeTerminal: true },
};

export async function runServant(args: {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly servant: ServantId;
  readonly taskId: string;
  readonly instruction: string;
  readonly injectedConstraints: readonly InjectedConstraint[];
  /** 依赖步骤的产出物 */
  readonly inputs?: readonly UpstreamInput[];
  /**
   * 对话历史（**精简版**，只带用户本轮原话）。
   *
   * ⚠️ 仆人刻意用比管家**少得多**的历史：
   *    它的职责是「按指令干活」，需要的是**上游产出**
   *    （通过 `inputs` 精确传递），不是对话的来龙去脉。
   *    给多了会让它跑偏到「回答用户」而不是「产出结构化报告」。
   */
  readonly history?: readonly ModelMessage[];
  readonly now: number;
  readonly clock: ClockPort;
  /**
   * 工具框架。给出时仆人走**工具循环**，否则走原来的单次结构化输出。
   *
   * ⚠️ 两者必须都支持：验证脚本与纯推理场景不需要工具，
   *    强行走循环会让每次调用都多花一轮 token。
   */
  readonly tools?: ToolFramework;
  readonly maxRounds?: number;
}): Promise<ServantRunResult> {
  // 截断上游产出 —— 控制 prompt 体积，同时保留判断所需的信息
  const trimmedInputs: UpstreamInput[] | undefined = args.inputs?.map((inp) => ({
    stepId: inp.stepId,
    servant: inp.servant,
    artifacts: inp.artifacts.map(trimArtifact),
    findings: inp.findings.slice(0, UPSTREAM_MAX_FINDINGS),
  }));

  const baseMessages: ModelMessage[] = [
    msg.system(servantSystem(args.servant)),
    // 精简历史放在指令之前 —— 让它先有语境，再读指令
    ...(args.history ?? []),
    msg.user(
      servantTask({
        instruction: args.instruction,
        injectedConstraints: args.injectedConstraints,
        ...(trimmedInputs !== undefined ? { inputs: trimmedInputs } : {}),
      }),
    ),
  ];

  const { raw, usage, attempts } = args.tools
    ? await runWithTools(args, baseMessages)
    : await runSingleShot(args, baseMessages);

  // ── 归一化：把模型的多种自然写法收敛成领域模型 ──
  // 这是"防腐层"的落点：LLM 的输出形状会变，领域模型不变。
  const artifacts: ServantArtifact[] = [];
  for (const a of raw.artifacts) {
    const n = normalizeArtifact(a);
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
    .map(normalizeFinding)
    .filter((f): f is NonNullable<typeof f> => f !== null);

  const decision = normalizeReport(raw).needsButlerDecision;

  const report: ServantReport = {
    taskId: args.taskId,
    servant: args.servant,
    status: raw.status,
    artifacts,
    memoryRefs: args.injectedConstraints.map((c) => c.memoryId),
    uncertainties: raw.uncertainties,
    ...(decision !== undefined ? { needsButlerDecision: decision } : {}),
    findings,
  };

  args.log.append({
    type: report.status === 'blocked' ? 'servant.blocked' : 'servant.report',
    actor: 'servant',
    servantId: args.servant,
    payload: {
      taskId: args.taskId,
      status: report.status,
      artifacts: report.artifacts,
      findings: report.findings,
      uncertainties: report.uncertainties,
      needsButlerDecision: report.needsButlerDecision ?? null,
      memoryRefs: report.memoryRefs,
      usage,
      attempts,
      promptVersions: [PROMPT_VERSIONS.servantSystem, PROMPT_VERSIONS.servantTask],
    },
    createdAt: args.now,
  });

  if (report.needsButlerDecision !== undefined) {
    args.log.append({
      type: 'servant.needsDecision',
      actor: 'servant',
      servantId: args.servant,
      payload: { taskId: args.taskId, question: report.needsButlerDecision },
      createdAt: args.now,
    });
  }

  return {
    report,
    raw,
    usage,
    attempts,
    promptVersions: [PROMPT_VERSIONS.servantSystem, PROMPT_VERSIONS.servantTask],
  };
}

// ═══════════════════════════════════════════════════════════
// 两条执行路径
// ═══════════════════════════════════════════════════════════

/** 原路径：单次结构化输出。无工具需求时用它，省一轮 token。 */
async function runSingleShot(
  args: ServantRunArgs,
  messages: readonly ModelMessage[],
): Promise<{ raw: ServantReportOutput; usage: ServantRunResult['usage']; attempts: number }> {
  const result = await args.model.completeStructured({
    purpose: 'servant',
    schema: servantReportSchema,
    schemaName: 'ServantReport',
    temperature: 0.2,
    maxOutputTokens: 3072,
    messages,
  });
  return { raw: result.value, usage: result.usage, attempts: result.attempts };
}

/**
 * 工具路径：模型可以反复调用工具，最后通过 `submit_report` 提交结构化汇报。
 *
 * ★ 关键设计：汇报做成**终止工具**，而不是让模型在自由文本里同时兼顾
 *   "调工具"与"交结构化结果" —— 后者模型很容易在中间写一段散文导致解析失败。
 */
async function runWithTools(
  args: ServantRunArgs,
  messages: readonly ModelMessage[],
): Promise<{ raw: ServantReportOutput; usage: ServantRunResult['usage']; attempts: number }> {
  const tools = args.tools;
  if (!tools) throw new Error('runWithTools 需要 tools');

  // 汇报工具在这里注册（幂等）—— 谁用循环谁负责保证终止工具存在
  tools.register(submitReportTool(), { overwrite: true });
  const policy = SERVANT_TOOL_POLICY[args.servant];
  const loop = await runAgentLoop(
    {
      model: args.model,
      tools,
      log: args.log,
      clock: args.clock,
      taskId: args.taskId,
      toolFilter: (t) => t.name === 'submit_report' || policy.allowTiers.includes(t.tier),
      ...(args.maxRounds !== undefined ? { maxRounds: args.maxRounds } : {}),
      terminalTool: 'submit_report',
    },
    messages,
  );

  const submitted = extractReport(loop.traces);
  if (submitted === undefined) {
    // 模型没有提交汇报（可能是轮次用尽或一直调工具）——
    // 如实反映为 blocked，而不是伪造一份空汇报
    return {
      raw: {
        status: 'blocked',
        artifacts: [],
        uncertainties: [
          loop.hitRoundLimit
            ? `达到工具调用轮次上限，未能提交汇报。已执行 ${loop.traces.length} 次工具调用。`
            : '模型未调用 submit_report 提交汇报。',
        ],
        findings: [],
      },
      usage: loop.usage,
      attempts: loop.rounds,
    };
  }

  const parsed = servantReportSchema.safeParse(submitted);
  if (!parsed.success) {
    return {
      raw: {
        status: 'blocked',
        artifacts: [],
        uncertainties: [`提交的汇报格式不合规：${parsed.error.issues[0]?.message ?? '未知'}`],
        findings: [],
      },
      usage: loop.usage,
      attempts: loop.rounds,
    };
  }

  return { raw: parsed.data, usage: loop.usage, attempts: loop.rounds };
}

type ServantRunArgs = Parameters<typeof runServant>[0];
