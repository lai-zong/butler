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
import { msg, type ModelPort } from '../ports/model.js';
import { PROMPT_VERSIONS, servantSystem, servantTask } from '../prompts/butler.js';
import {
  normalizeArtifact,
  normalizeFinding,
  servantReportSchema,
  type ServantReportOutput,
} from '../prompts/schemas.js';
import type { InjectedConstraint, ServantArtifact, ServantId, ServantReport } from '../servants/types.js';

export interface ServantRunResult {
  readonly report: ServantReport;
  readonly raw: ServantReportOutput;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly attempts: number;
  readonly promptVersions: readonly string[];
}

export async function runServant(args: {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly servant: ServantId;
  readonly taskId: string;
  readonly instruction: string;
  readonly injectedConstraints: readonly InjectedConstraint[];
  readonly now: number;
}): Promise<ServantRunResult> {
  const result = await args.model.completeStructured({
    purpose: 'servant',
    schema: servantReportSchema,
    schemaName: 'ServantReport',
    temperature: 0.2,
    maxOutputTokens: 2048,
    messages: [
      msg.system(servantSystem(args.servant)),
      msg.user(
        servantTask({
          instruction: args.instruction,
          injectedConstraints: args.injectedConstraints,
        }),
      ),
    ],
  });

  const raw = result.value;

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

  const report: ServantReport = {
    taskId: args.taskId,
    servant: args.servant,
    status: raw.status,
    artifacts,
    memoryRefs: args.injectedConstraints.map((c) => c.memoryId),
    uncertainties: raw.uncertainties,
    ...(raw.needsButlerDecision !== undefined
      ? { needsButlerDecision: raw.needsButlerDecision }
      : {}),
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
      usage: result.usage,
      attempts: result.attempts,
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
    usage: result.usage,
    attempts: result.attempts,
    promptVersions: [PROMPT_VERSIONS.servantSystem, PROMPT_VERSIONS.servantTask],
  };
}
