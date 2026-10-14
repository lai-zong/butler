/**
 * 管家 · 监督校验
 *
 * 设计依据：方案 § 2.2③（管家监督）
 *
 * 校验四类问题：遗漏 / 跨领域矛盾 / 记忆矛盾 / 原则违背。
 *
 * ⚠️ 关键区别：这里是**管家的校验层**在判定，不是某个仆人在否决另一个仆人。
 *    仆人只提交 findings，严重性由这里裁定。
 */

import { EventLog } from '../events/log.js';
import { msg, type ModelPort } from '../ports/model.js';
import { BUTLER_SYSTEM, PROMPT_VERSIONS, supervisionTask } from '../prompts/butler.js';
import { supervisionSchema, type SupervisionOutput } from '../prompts/schemas.js';
import type { ServantReport } from '../servants/types.js';

export interface SupervisionResult {
  readonly output: SupervisionOutput;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly promptVersion: string;
}

function summarize(report: ServantReport): string {
  const arts = report.artifacts
    .map((a) => (Array.isArray(a.content) ? a.content.join('；') : String(a.content)))
    .join(' | ');
  const findings = (report.findings ?? []).map((f) => `[${f.kind}] ${f.statement}`).join('；');
  return [arts, findings].filter((s) => s.length > 0).join(' ‖ ') || '(无产出)';
}

export async function supervise(args: {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly userGoal: string;
  readonly reports: readonly ServantReport[];
  readonly hardConstraints: readonly string[];
  readonly now: number;
}): Promise<SupervisionResult> {
  const result = await args.model.completeStructured({
    purpose: 'routing',
    schema: supervisionSchema,
    schemaName: 'SupervisionOutput',
    temperature: 0,
    maxOutputTokens: 1024,
    messages: [
      msg.system(BUTLER_SYSTEM),
      msg.user(
        supervisionTask({
          userGoal: args.userGoal,
          reports: args.reports.map((r) => ({ servant: r.servant, summary: summarize(r) })),
          hardConstraints: args.hardConstraints,
        }),
      ),
    ],
  });

  const output = result.value;

  args.log.append({
    type: 'supervisor.observe',
    actor: 'supervisor',
    payload: {
      conflictCount: output.conflicts.length,
      summary: output.summary,
      usage: result.usage,
      promptVersion: PROMPT_VERSIONS.supervisorTask,
    },
    createdAt: args.now,
  });

  for (const c of output.conflicts) {
    // 命中硬约束 → 管家机械拦截（不是任何仆人的权力）
    const isHardBlock = c.severity === 'block';
    args.log.append({
      type: isHardBlock ? 'constraint.hardBlocked' : 'conflict.detected',
      actor: 'supervisor',
      payload: {
        kind: c.kind,
        severity: c.severity,
        message: c.message,
        parties: c.parties,
        evidence: c.evidence,
      },
      createdAt: args.now,
    });
  }

  return { output, usage: result.usage, promptVersion: PROMPT_VERSIONS.supervisorTask };
}
