/**
 * 结构化输出的 Schema 定义
 *
 * 设计依据：方案 § 12「大模型集成质量 8%」—— 输出必须稳定可控。
 *
 * **所有 LLM 的结构化输出都先经过这里校验，校验失败由适配器重试。**
 * 未校验的结果绝不进入核心逻辑。
 */

import { z } from 'zod';

import { SERVANT_IDS } from '../servants/types.js';

const servantIdSchema = z.enum(SERVANT_IDS as unknown as [string, ...string[]]);

// ═══════════════════════════════════════════════════════════
// 仆人提交的「发现」
// ═══════════════════════════════════════════════════════════

/**
 * ⚠️ 字段设计说明（重要，别随手"简化"）
 *
 * 这几个 schema 刻意**接受多种写法**，而不是逼模型用一套固定字段名。
 *
 * 原因：实测发现模型天然倾向于输出更结构化的形式 ——
 * 例如 artifacts 它会写成 `{type:'list', title:'…', items:[{…}]}`，
 * 而不是扁平化成 `{kind:'list', content:'一段字符串'}`。
 * 强行只接受后者会**逼模型丢掉结构化信息**（它宁可报错也不愿意压平），
 * 结果是重试三次仍然失败。
 *
 * 正确做法：在 **LLM 边界做归一化**（见 adapters 与 servants/execute.ts），
 * 领域模型保持干净。这是"防腐层"的标准用法。
 */

// ═══════════════════════════════════════════════════════════
// 仆人提交的「发现」
// ═══════════════════════════════════════════════════════════

/**
 * ⚠️ 注意字段设计：**这里没有 severity，也没有否决权**。
 *
 * 仆人只能陈述发现 + 证据，判定与拦截由管家校验层执行。
 * 这是"五个仆人完全平等"在 schema 层面的体现（方案 § 2.1）。
 */
export const findingSchema = z.object({
  kind: z
    .enum(['constraintRef', 'risk', 'alternative'])
    .describe('constraintRef=指向某条约束；risk=风险提示；alternative=备选方案'),
  // 接受 statement 或 content 两种命名
  statement: z.string().min(1).optional().describe('发现了什么，一句话说清'),
  content: z.string().min(1).optional().describe('statement 的别名，二选一'),
  evidence: z.array(z.string()).optional().describe('支撑证据；可以省略'),
  constraintRef: z.string().optional().describe('当 kind=constraintRef 时，指向约束的标识'),
});

/** 归一化后的 finding —— 领域模型只用这一种形状。 */
export interface NormalizedFinding {
  readonly kind: 'constraintRef' | 'risk' | 'alternative';
  readonly statement: string;
  readonly evidence: readonly string[];
  readonly constraintRef?: string;
}

export function normalizeFinding(f: z.infer<typeof findingSchema>): NormalizedFinding | null {
  const statement = f.statement ?? f.content;
  if (!statement) return null; // 两者都缺 → 丢弃这条，不让它污染领域模型
  return {
    kind: f.kind,
    statement,
    evidence: f.evidence ?? [],
    ...(f.constraintRef !== undefined ? { constraintRef: f.constraintRef } : {}),
  };
}


// ═══════════════════════════════════════════════════════════
// 管家 · 路由
// ═══════════════════════════════════════════════════════════

export const routingSchema = z.object({
  servant: servantIdSchema.describe('最合适的仆人'),
  confidence: z.number().min(0).max(1).describe('置信度 0—1；低于 0.6 会被转为询问用户'),
  reason: z.string().min(1).describe('选择理由，一句话'),
  /** 低置信度时给出需要向用户澄清的问题 */
  clarifyingQuestion: z.string().optional().describe('confidence < 0.6 时必填：要向用户问什么'),
});

export type RoutingDecision = z.infer<typeof routingSchema>;

// ═══════════════════════════════════════════════════════════
// 管家 · 任务分解
// ═══════════════════════════════════════════════════════════

export const dispatchPlanSchema = z.object({
  steps: z
    .array(
      z.object({
        stepId: z.string().min(1).describe('步骤标识，如 step1'),
        // 注意：这里允许 'butler' —— 管家汇总类步骤由自己执行，不派发给仆人。
        // 与 servantIdSchema 区分开，因为"谁能被派发"和"谁在执行"是两个集合。
        servant: z
          .enum(['life', 'health', 'study', 'work', 'code', 'butler'])
          .describe('这一步交给哪个仆人；管家自己汇总的步骤填 butler'),
        instruction: z.string().min(1).describe('给这个仆人的具体指令'),
        dependsOn: z.array(z.string()).describe('依赖哪些步骤的产出；无依赖填空数组'),
      }),
    )
    .min(1)
    .max(5)
    .describe('任务分解，最多 5 步'),
  reasoning: z.string().min(1).describe('为什么这样分解'),
});

export type DispatchPlan = z.infer<typeof dispatchPlanSchema>;

// ═══════════════════════════════════════════════════════════
// 仆人 · 汇报
// ═══════════════════════════════════════════════════════════

/**
 * 产出物：接受扁平与结构化两种写法。
 *
 *  扁平：  { "kind": "list", "content": "条目1\n条目2" }
 *  结构化：{ "type": "list", "title": "标题", "items": ["…", { "name": "…" }] }
 *
 * 归一化在 `normalizeArtifact` 里完成。
 */
export const artifactSchema = z.object({
  kind: z.enum(['text', 'list', 'plan']).optional(),
  /** 模型的常见别名 */
  type: z.enum(['text', 'list', 'plan']).optional(),
  content: z.string().optional(),
  title: z.string().optional(),
  /** items 里可以是字符串，也可以是任意对象（模型常带丰富字段） */
  items: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
  /** 有的模型会额外给一句总结 */
  summary: z.string().optional(),
});

export type RawArtifact = z.infer<typeof artifactSchema>;

/** 归一化产出物。内容为空时返回 null，由调用方丢弃。 */
export function normalizeArtifact(
  a: RawArtifact,
): { kind: 'text' | 'list' | 'plan'; content: string } | null {
  const kind = a.kind ?? a.type ?? 'text';

  const lines: string[] = [];
  if (a.title) lines.push(a.title);
  if (a.items && a.items.length > 0) {
    for (const item of a.items) {
      if (typeof item === 'string') {
        lines.push(item);
      } else {
        // 对象条目：优先 name/title，其余字段作为补充说明拼在后面
        const rec = item as Record<string, unknown>;
        const head = String(rec['name'] ?? rec['title'] ?? rec['label'] ?? '');
        const rest = Object.entries(rec)
          .filter(([k]) => !['name', 'title', 'label'].includes(k))
          .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join('；');
        lines.push([head, rest].filter((s) => s.length > 0).join(' — '));
      }
    }
  }
  if (a.content) lines.push(a.content);
  if (a.summary) lines.push(a.summary);

  const content = lines.filter((l) => l.trim().length > 0).join('\n');
  if (content.length === 0) return null;
  return { kind, content };
}

/**
 * `needsButlerDecision` 的兼容处理。
 *
 * 实测：模型有时输出 `true`（想说"需要管家裁决"但没给具体问题），
 * 有时输出问题字符串。字段名是个疑问句，两种读法都合理。
 *
 * 处理方式：接受联合类型，归一化成"要么没有，要么是有内容的字符串"。
 */
const needsDecisionSchema = z
  .union([z.string(), z.boolean()])
  .optional()
  .describe('需要管家裁决的问题；没有就省略或填 false');

function normalizeNeedsDecision(v: string | boolean | undefined): string | undefined {
  if (v === undefined || v === false) return undefined;
  if (v === true) return '仆人声明需要管家裁决，但未给出具体问题';
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

export const servantReportSchema = z.object({
  status: z.enum(['done', 'failed', 'blocked']),
  artifacts: z.array(artifactSchema).describe('产出物，可为空数组'),
  /** 诚实声明不确定的地方，而不是硬着头皮给答案 */
  uncertainties: z.array(z.string()).describe('自己不确定的地方；没有就填空数组'),
  needsButlerDecision: needsDecisionSchema,
  findings: z.array(findingSchema).describe('发现清单；没有就填空数组'),
});

export type ServantReportOutput = z.infer<typeof servantReportSchema>;

/** 把报告里的 needsButlerDecision 归一化（在适配边界调用）。 */
export function normalizeReport(raw: ServantReportOutput): {
  needsButlerDecision: string | undefined;
} {
  return { needsButlerDecision: normalizeNeedsDecision(raw.needsButlerDecision) };
}


// ═══════════════════════════════════════════════════════════
// 管家 · 监督校验
// ═══════════════════════════════════════════════════════════

export const supervisionSchema = z.object({
  conflicts: z
    .array(
      z.object({
        kind: z.enum(['crossServant', 'memoryInconsistency', 'principleViolation', 'omission']),
        severity: z.enum(['info', 'warn', 'block']),
        message: z.string().min(1).describe('冲突是什么'),
        parties: z.array(servantIdSchema).describe('涉及哪些仆人'),
        evidence: z.array(z.string()).describe('证据'),
      }),
    )
    .describe('发现的冲突；没有就填空数组'),
  summary: z.string().min(1).describe('整体结论，一句话'),
});

export type SupervisionOutput = z.infer<typeof supervisionSchema>;
