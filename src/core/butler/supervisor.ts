/**
 * 管家 · 监督复核（v7 · D-7 三视角改造）
 *
 * ★★ 与旧实现的根本区别：**核对对象从「仆人之间」变成「产出与契约之间」**。
 *
 * ═══ 为什么改（有实测依据，不是偏好）═══
 *
 *   旧实现让监督者比对多个仆人的产出、找 `crossServant`（跨领域矛盾）。
 *   实测：唯一一次检查报的是「结论一致、无实质冲突」——
 *   原因很实际：两个 Agent 都被要求「只提交发现、不做裁决」，
 *   各自说得保守，**反而不冲突**。
 *
 *   ★ 更要紧的是它**查不出「答非所问」**：
 *     两个仆人各答对了自己的题，但整体答偏了 —— 这种错没人看得见。
 *     现在有了契约（成文标准），可以**逐条核对**，这个盲区才补上。
 *
 * ═══ 三个视角 ═══
 *
 *   | 视角 | 核对什么 | 为什么需要它 |
 *   |---|---|---|
 *   | `contract` | 契约的每一条判据 | **唯一能查「答非所问」** |
 *   | `domain`   | `DOMAIN_DISCIPLINE` 的专业纪律 | 具体数字（油 ≤5g）全局视角看不出 |
 *   | `global`   | 硬约束 / 记忆 / 原则 | 安全底线 |
 *
 * ═══ 一个重要边界 ═══
 *
 *   ⚠️ 监督员**只告知，不阻断**（D-17 的延伸）。
 *     它不会把产出拿走重做，也不会让整轮失败 ——
 *     只写事件、给结论。理由：判断错了可以改，而阻断会让用户等不到结果。
 */

import type { EventLog } from '../events/log.js';
import { msg, type ModelPort } from '../ports/model.js';
import { BUTLER_SYSTEM, PROMPT_VERSIONS, supervisionTask } from '../prompts/butler.js';
import { supervisionSchema, type SupervisionOutput } from '../prompts/schemas.js';
import { renderContractForReview, type TaskContract } from './contract.js';
import { DOMAIN_DISCIPLINE, domainName } from '../domain/types.js';
import type { ServantReport } from '../servants/types.js';

/**
 * 归一化后的发现 —— message **必定存在**。
 *
 * ⚠️ schema 里 message 是可选（为了容忍模型用 statement/content），
 *    但**出了 supervise() 之后就不该再有可选的 message** ——
 *    否则每个消费方都要处理 undefined，而那个分支永远不该发生。
 */
export interface SupervisionFinding {
  readonly viewpoint: 'contract' | 'domain' | 'global';
  readonly severity: 'info' | 'warn' | 'block';
  readonly message: string;
  readonly evidence: readonly string[];
}

/** 归一化后的监督输出：findings 的 message 必有值。 */
export interface NormalizedSupervisionOutput {
  readonly criteriaChecks: SupervisionOutput['criteriaChecks'];
  readonly findings: readonly SupervisionFinding[];
  readonly summary: string;
}

export interface SupervisionResult {
  readonly output: NormalizedSupervisionOutput;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly promptVersion: string;
}

/**
 * 产出摘要的上限（字符）。
 *
 * ⚠️ 监督者要核对的是「产出有没有对得上判据」，需要**结论与关键依据**，
 *    不需要完整长文。实测超出部分对判定没有贡献，只推高输入 token。
 */
const SUMMARY_CHAR_LIMIT = 1_800;

function summarize(report: ServantReport): string {
  const arts = report.artifacts
    .map((a) => (Array.isArray(a.content) ? a.content.join('；') : String(a.content)))
    .join(' | ');
  const findings = (report.findings ?? []).map((f) => `[${f.kind}] ${f.statement}`).join('；');
  const reply = report.reply.length > 0 ? report.reply : '';
  const joined =
    [reply, arts, findings].filter((s) => s.length > 0).join(' ‖ ') || '(无产出)';
  return joined.length <= SUMMARY_CHAR_LIMIT
    ? joined
    : `${joined.slice(0, SUMMARY_CHAR_LIMIT)}…（已截断）`;
}

/**
 * 按契约的领域选出对应的专业纪律。
 *
 * ★ 这是「领域视角」的输入来源 —— 没有它，领域视角就退化成了常识检查。
 */
function disciplinesFor(
  contract: TaskContract,
): { domain: string; rules: readonly string[] }[] {
  return contract.domains
    .filter((d) => DOMAIN_DISCIPLINE[d] !== undefined)
    .map((d) => ({ domain: domainName(d), rules: DOMAIN_DISCIPLINE[d] }));
}

export async function supervise(args: {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly userGoal: string;
  /** 任务契约 —— 监督员核对的唯一标准 */
  readonly contract: TaskContract;
  readonly reports: readonly ServantReport[];
  readonly hardConstraints: readonly string[];
  readonly now: number;
}): Promise<SupervisionResult> {
  const outputSummary = args.reports.map(summarize).join('\n---\n');

  const result = await args.model.completeStructured({
    purpose: 'routing',
    schema: supervisionSchema,
    schemaName: 'SupervisionOutput',
    // ⚠️ 结构化调用关思考 —— 思考会吃掉 max_tokens 导致 JSON 截断
    thinking: 'disabled',
    temperature: 0,
    maxOutputTokens: 1_400,
    messages: [
      msg.system(BUTLER_SYSTEM),
      msg.user(
        supervisionTask({
          userGoal: args.userGoal,
          contractText: renderContractForReview(args.contract),
          outputSummary,
          hardConstraints: args.hardConstraints,
          disciplines: disciplinesFor(args.contract),
        }),
      ),
    ],
  });

  const raw = result.value;

  /**
   * ⚠️ 归一化 findings：模型可能用 `statement` / `content` 而不是 `message`
   *    （它在本项目里见过 `servantReportSchema` 的同类字段）。
   *    实测撞到过：`message` 缺失 → 整次监督调用重试 3 次后失败。
   *
   * ★ 缺 message 的条目**直接丢弃并记数**，不编造内容 ——
   *   一条没有描述的问题对对账毫无用处，留着只会让摘要变噪。
   */
  let droppedFindings = 0;
  const normalizedFindings = raw.findings.flatMap((f) => {
    const message = (f.message ?? f.statement ?? f.content ?? '').trim();
    if (message.length === 0) {
      droppedFindings += 1;
      return [];
    }
    return [
      {
        viewpoint: f.viewpoint,
        severity: f.severity,
        message,
        evidence: f.evidence,
      },
    ];
  });

  const output = {
    ...raw,
    findings: normalizedFindings,
  };

  // ═══════════════════════════════════════════════════════════
  // ★★ 补齐漏核的判据（fail-closed）
  // ═══════════════════════════════════════════════════════════
  //
  //   ⚠️ 实测发现：提示词要求「每一条判据都要核对，不能漏」，
  //      但模型**偶尔会漏一条**（验证时撞到过：契约 6 条、只核了 5 条）。
  //
  //   ★ 为什么不能"重跑一次碰运气"：
  //     漏核 = 那条判据**没被验证**，而没被验证的承诺等于放过了。
  //     靠重跑让验证变绿，就是把不确定性当成了通过。
  //
  //   ★ 所以在这里**强制补齐**，并把补的那条标为 `met: false`：
  //     · 不假装满足（fail-closed）
  //     · 用户能看见"监督员漏核了这一条"，这是**真实信息**，不是噪音
  //
  //   ★ 补齐规则（两次修正后的最终版）：
  //     · 模型核对的条数 **≥ 契约条数** → 原样保留。
  //       ⚠️ 模型常会**改写判据措辞**（把"给出具体用量"写成"每样食材都标了克数"），
  //          所以不能靠文本匹配判断"核过没核过" —— 第一版这么做，
  //          匹配失败后我把 6 条重复补上去，变成 12 条（验证时撞到）。
  //     · 模型核对的条数 **< 契约条数** → 补上没被覆盖的原文判据，标 `met: false`。
  const normalized = (s: string): string => s.replace(/[\s，。、；：""''（）()]/g, '');
  const checkedTexts = new Set(output.criteriaChecks.map((c) => normalized(c.criterion)));
  const missing =
    output.criteriaChecks.length >= args.contract.criteria.length
      ? []
      : args.contract.criteria.filter((c) => !checkedTexts.has(normalized(c)));
  const criteriaChecks =
    missing.length === 0
      ? output.criteriaChecks
      : [
          ...output.criteriaChecks,
          ...missing.map((c) => ({
            criterion: c,
            met: false,
            note: '监督员未核对这一条（视为未满足）',
          })),
        ];

  // ── 判据核对统计：这是"答非所问"能否被看见的地方 ──
  const met = criteriaChecks.filter((c) => c.met).length;
  const unmet = criteriaChecks
    .filter((c) => !c.met)
    .map((c) => ({ criterion: c.criterion, note: c.note ?? '' }));

  args.log.append({
    type: 'supervisor.observe',
    actor: 'supervisor',
    payload: {
      findingCount: output.findings.length,
      /** 因缺 message 被丢弃的条目数（非 0 说明模型输出不规范） */
      droppedFindings,
      /** 判据总数 / 满足数 —— 界面可直接显示「5/6 条判据满足」 */
      criteriaTotal: args.contract.criteria.length,
      criteriaChecked: criteriaChecks.length,
      criteriaMet: met,
      ...(unmet.length > 0 ? { unmet } : {}),
      /** 模型漏核的判据数 —— 非 0 说明监督员没尽责，这个数要看 */
      uncheckedByModel: missing.length,
      /** 按视角分组计数，便于看"哪个视角查出了东西" */
      byViewpoint: {
        contract: output.findings.filter((f) => f.viewpoint === 'contract').length,
        domain: output.findings.filter((f) => f.viewpoint === 'domain').length,
        global: output.findings.filter((f) => f.viewpoint === 'global').length,
      },
      summary: output.summary,
      usage: result.usage,
      promptVersion: PROMPT_VERSIONS.supervisorTask,
    },
    createdAt: args.now,
  });

  for (const c of output.findings) {
    // 命中硬约束 → 管家机械拦截（不是任何执行者的权力）
    const isHardBlock = c.severity === 'block';
    args.log.append({
      type: isHardBlock ? 'constraint.hardBlocked' : 'conflict.detected',
      actor: 'supervisor',
      payload: {
        viewpoint: c.viewpoint,
        severity: c.severity,
        message: c.message,
        evidence: c.evidence,
      },
      createdAt: args.now,
    });
  }

  return {
    // ⚠️ 返回**补齐后**的 output —— 调用方拿到的判据核对永远是完整的
    output: { ...output, criteriaChecks },
    usage: result.usage,
    promptVersion: PROMPT_VERSIONS.supervisorTask,
  };
}
