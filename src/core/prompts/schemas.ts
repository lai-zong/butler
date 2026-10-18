/**
 * 结构化输出的 Schema 定义
 *
 * 设计依据：方案 § 12「大模型集成质量 8%」—— 输出必须稳定可控。
 *
 * **所有 LLM 的结构化输出都先经过这里校验，校验失败由适配器重试。**
 * 未校验的结果绝不进入核心逻辑。
 */

import { z } from 'zod';

import type { QuizAnswer, QuizQuestion, TableContent } from '../execution/types.js';
// ★ 答案字母归一化只有一份实现（`core/quiz/letters.ts`）——
//   模型输出侧与用户提交侧共用，否则两侧规则漂移会导致"批改永远判错"。
import { stripOptionPrefix, toOptionLetter } from '../quiz/letters.js';

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


// ═══════════════════════════════════════════════════════════
// 管家 · 任务分解
// ═══════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════
// 任务契约（v7 · D-5）—— 替代 dispatchPlanSchema
// ═══════════════════════════════════════════════════════════

/**
 * 任务契约 —— 干活前先写下的"要做什么"。
 *
 * ★★ 与 `dispatchPlanSchema` 的**根本区别**：
 *
 *   | | dispatchPlan（旧）| contract（新）|
 *   |---|---|---|
 *   | 产物 | **分几步、每步派给谁** | **要做什么、怎样算做好** |
 *   | 用途 | 指挥多个执行者 | **给监督员当核对标准** |
 *   | 为什么改 | 只有一个执行者，拆步骤没意义 | 契约可以被逐条核对 |
 *
 * ⚠️ 刻意**不包含"步骤"与"派给谁"** ——
 *   那两样只在"多个执行者"的前提下才有意义。
 */
export const contractSchema = z.object({
  deliverable: z
    .string()
    .min(1)
    .describe('一句话说清交付物是什么（用户拿到什么）。不要写过程，写结果'),
  criteria: z
    .array(z.string().min(1))
    .min(1)
    .max(6)
    .describe(
      '判据：怎样算做好了。每条都要能被逐条核对（是/否），不要写"尽量""努力"这类无法判定的词',
    ),
  mustObey: z
    .array(z.string().min(1))
    .max(6)
    .describe('必须遵守的硬约束（过敏原、预算上限、截止时间等）。没有就填空数组'),
  domains: z
    .array(z.enum(['life', 'health', 'study', 'work', 'code', 'none']))
    .min(1)
    .describe('这件事涉及哪些领域（可多选）。判不出就填 none —— 不要硬猜'),
  /**
   * ★★ v8（批次C）：置信度**并入契约**，不再单独调一次路由。
   *
   * ⚠️ 原来有一次独立的 `route()` LLM 调用（`router.ts` + `routingSchema`），
   *    只为了产出 `confidence` / `reason` / `clarifyingQuestion` 三个值 ——
   *    而写契约时模型**已经读懂了同一句话**，再问一遍纯属浪费一次调用，
   *    而且两份判断可能互相矛盾（实测出现过：路由判 life、契约写 health）。
   *
   * ★ 方案 D-3 原文就写着"合并进写契约一步"，这里补上。
   *
   * ⚠️ `confidence` 低**不阻断执行**（D-4）：带着假设先干，把假设告诉用户。
   */
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('你对"理解对了用户意思"的置信度 0—1。必须诚实：不确定就打低分，不要为了显得确定而抬高'),
  /** 低置信度时给出需要向用户澄清的问题（可选） */
  clarifyingQuestion: z
    .string()
    .optional()
    .describe('confidence < 0.6 时填：你要向用户确认什么。其余情况省略'),
});

export type TaskContractPlan = z.infer<typeof contractSchema>;

// ═══════════════════════════════════════════════════════════
// 仆人 · 汇报
// ═══════════════════════════════════════════════════════════

/**
 * 产出物：接受扁平与结构化两种写法。
 *
 *  扁平：  { "kind": "list", "content": "条目1\n条目2" }
 *  结构化：{ "type": "list", "title": "标题", "items": ["…", { "name": "…" }] }
 *
 * ★ v8 新增 `table` 与 `quiz` 两种**真结构** ——
 *   它们不能压平成字符串：表格有行列，题目有选项与答案。
 *
 * 归一化在 `normalizeArtifact` 里完成。
 */
export const artifactSchema = z.object({
  kind: z.enum(['text', 'list', 'plan', 'table', 'quiz']).optional(),
  /** 模型的常见别名 */
  type: z.enum(['text', 'list', 'plan', 'table', 'quiz']).optional(),
  content: z.string().optional(),
  title: z.string().optional(),
  /** items 里可以是字符串，也可以是任意对象（模型常带丰富字段） */
  items: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
  /** 有的模型会额外给一句总结 */
  summary: z.string().optional(),

  /**
   * ★ 表格的**专用字段**（首选写法）。
   *
   * ⚠️ 为什么不只用 `items`：`items` 是"任意对象数组"，模型写表格时
   *    列名散落在每行的键里，缺列、列序不一致都无法发现。
   *    显式给 `columns` 才能保证**每一行都对齐同一组列**。
   */
  table: z
    .object({
      columns: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    })
    .optional(),

  /**
   * ★ 题目的**专用字段**（首选写法）。
   *
   * ⚠️ `answer` 会由 `normalizeArtifact` **搬走**，绝不进入 `ExecutionArtifact`。
   *    这是「答案不出现在前端」的第一道防线。
   */
  quiz: z
    .array(
      z.object({
        id: z.string().optional(),
        stem: z.string().optional(),
        question: z.string().optional(),
        options: z.array(z.string()).optional(),
        choices: z.array(z.string()).optional(),
        answer: z.union([z.string(), z.number()]).optional(),
        correct: z.union([z.string(), z.number()]).optional(),
        explanation: z.string().optional(),
      }),
    )
    .optional(),
});

export type RawArtifact = z.infer<typeof artifactSchema>;

// ═══════════════════════════════════════════════════════════
// 产出物归一化的结果类型
// ═══════════════════════════════════════════════════════════

/**
 * 一道题 —— **刻意没有 `answer` 字段**，答案在 `QuizAnswer` 里。
 *
 * ★ 直接复用 `core/execution/types` 的领域类型，不在这里再定义一份 ——
 *   两份同形定义迟早漂移（本项目已经因为"两份 ServantId 字面量"吃过一次亏）。
 */
export type NormalizedQuizQuestion = QuizQuestion;

/** 题目的正确答案（服务端专用；落事件，不进前端）。 */
export type NormalizedQuizAnswer = QuizAnswer;

export type NormalizedTable = TableContent;

/**
 * 归一化后的产出物。
 *
 * ★★ 关键设计：**`quiz` 分支的 content 里没有答案** ——
 *    "把答案留在产出物里"这件事在**类型层面就写不出来**。
 *    不靠注释提醒、不靠代码审查，靠类型不可表示。
 */
export type NormalizedArtifact =
  | { readonly kind: 'text'; readonly content: string }
  | { readonly kind: 'list' | 'plan'; readonly content: readonly string[] }
  | { readonly kind: 'table'; readonly content: NormalizedTable }
  | { readonly kind: 'quiz'; readonly content: readonly NormalizedQuizQuestion[] };

/** 归一化结果：产出物 + 需要单独落库的答案。 */
export interface ArtifactNormalization {
  readonly artifact: NormalizedArtifact;
  /** 非 quiz 时为空数组 */
  readonly answers: readonly NormalizedQuizAnswer[];
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

/** 从 `items` 的任意对象里取一道题（模型常把题目塞进 items）。 */
function quizFromRecord(
  rec: Record<string, unknown>,
  index: number,
): { question: NormalizedQuizQuestion; answer: NormalizedQuizAnswer } | null {
  const stem = asText(rec['stem'] ?? rec['question'] ?? rec['q'] ?? rec['title']);
  const rawOptions = rec['options'] ?? rec['choices'];
  const rawAnswer = rec['answer'] ?? rec['correct'] ?? rec['answerKey'];

  if (stem.length === 0) return null;
  if (!Array.isArray(rawOptions)) return null;

  const options = rawOptions
    .map((o) => (typeof o === 'string' ? stripOptionPrefix(o) : ''))
    .filter((o) => o.length > 0);
  if (options.length < 2) return null;

  const answerText =
    typeof rawAnswer === 'string' || typeof rawAnswer === 'number' ? rawAnswer : '';
  const correct = toOptionLetter(answerText, options);
  // 没有可判定的答案 → 这道题无法批改，整题丢弃（宁可少一题，也不给错判）
  if (correct === undefined) return null;

  const id = asText(rec['id']) || `q${index + 1}`;
  const explanation = asText(rec['explanation'] ?? rec['analysis']);

  return {
    question: { id, stem, options },
    answer: explanation.length > 0 ? { id, correct, explanation } : { id, correct },
  };
}

/** 归一化表格：优先专用 `table` 字段，退回 `items` 的对象数组。 */
function normalizeTable(a: RawArtifact): NormalizedTable | null {
  if (a.table) {
    const columns = a.table.columns.map((c) => c.trim()).filter((c) => c.length > 0);
    if (columns.length === 0) return null;
    const rows = a.table.rows
      .map((r) => r.map((cell) => String(cell).trim()))
      // 对齐列数：多了截断、少了补空 —— 否则前端渲染会错列
      .map((r) => columns.map((_, i) => r[i] ?? ''))
      .filter((r) => r.some((cell) => cell.length > 0));
    if (rows.length === 0) return null;
    return { columns, rows };
  }

  if (a.items && a.items.length > 0) {
    const records = a.items.filter(
      (i): i is Record<string, unknown> => typeof i === 'object' && i !== null,
    );
    if (records.length === 0) return null;
    // 列名 = 所有对象键的并集（按首次出现顺序），保证不漏列
    const columns: string[] = [];
    for (const rec of records) {
      for (const k of Object.keys(rec)) {
        if (!columns.includes(k)) columns.push(k);
      }
    }
    if (columns.length === 0) return null;
    const rows = records.map((rec) => columns.map((c) => asText(rec[c])));
    return { columns, rows };
  }

  return null;
}

/** 归一化题目：优先专用 `quiz` 字段，退回 `items` 的对象数组。 */
function normalizeQuiz(a: RawArtifact): {
  questions: NormalizedQuizQuestion[];
  answers: NormalizedQuizAnswer[];
} {
  const parsed: { question: NormalizedQuizQuestion; answer: NormalizedQuizAnswer }[] = [];

  if (a.quiz && a.quiz.length > 0) {
    a.quiz.forEach((q, i) => {
      const rawOptions = q.options ?? q.choices ?? [];
      const options = rawOptions.map((o) => stripOptionPrefix(o)).filter((o) => o.length > 0);
      const stem = asText(q.stem ?? q.question);
      if (stem.length === 0 || options.length < 2) return;

      const correct = toOptionLetter(q.answer ?? q.correct ?? '', options);
      if (correct === undefined) return;

      const id = asText(q.id) || `q${i + 1}`;
      const explanation = asText(q.explanation);
      parsed.push({
        question: { id, stem, options },
        answer: explanation.length > 0 ? { id, correct, explanation } : { id, correct },
      });
    });
  }

  if (parsed.length === 0 && a.items) {
    a.items.forEach((item, i) => {
      if (typeof item !== 'object' || item === null) return;
      const got = quizFromRecord(item as Record<string, unknown>, i);
      if (got) parsed.push(got);
    });
  }

  return {
    questions: parsed.map((p) => p.question),
    answers: parsed.map((p) => p.answer),
  };
}

/**
 * 归一化产出物。内容为空时返回 null，由调用方丢弃。
 *
 * ★ 返回 `ArtifactNormalization`（产出物 + 答案）而不是单个产出物 ——
 *   因为 quiz 的答案**必须与题目分离**，由调用方拿去落事件。
 */
export function normalizeArtifact(a: RawArtifact): ArtifactNormalization | null {
  const kind = a.kind ?? a.type ?? 'text';

  // ── table：真结构 ──
  if (kind === 'table') {
    const table = normalizeTable(a);
    if (!table) return null;
    return { artifact: { kind: 'table', content: table }, answers: [] };
  }

  // ── quiz：题目与答案分离 ──
  if (kind === 'quiz') {
    const { questions, answers } = normalizeQuiz(a);
    if (questions.length === 0) return null;
    return { artifact: { kind: 'quiz', content: questions }, answers };
  }

  // ── text / list / plan：保持原有压平行为（这几类本来就没有结构）──
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

  const kept = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (kept.length === 0) return null;

  return {
    artifact:
      kind === 'text' ? { kind: 'text', content: kept.join('\n') } : { kind, content: kept },
    answers: [],
  };
}

/**
 * `needsButlerDecision` 的兼容处理。
 *
 * 实测：模型有时输出 `true`（想说「需要管家裁决」但没给具体问题），
 * 有时输出问题字符串，**有时明确输出 `null` 表示「没有」**。
 *
 * ⚠️ 最后一种最容易漏：只写 `.optional()` 表示「字段可以不存在」，
 *    并不接受「字段存在但值是 null」。于是 `{ needsButlerDecision: null }`
 *    被判为非法 —— 实测一次真实对话因此中断在第三步仆人上。
 *
 *    处理方式：schema 负责「收得进来」（接受 string / boolean / null），
 *    归一化在适配边界做（`normalizeNeedsDecision`）。
 *    **schema 的职责是收，不是已经规整。**
 */
const needsDecisionSchema = z
  .union([z.string(), z.boolean(), z.null()])
  .optional()
  .describe('需要管家裁决的问题；没有就省略、填 false 或 null');

function normalizeNeedsDecision(v: string | boolean | null | undefined): string | undefined {
  if (v === undefined || v === null || v === false) return undefined;
  if (v === true) return '声明需要管家裁决，但未给出具体问题';
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

export const executionReportSchema = z.object({
  /**
   * ★★ 给**用户**看的那段话 —— 界面上显示的主体。
   *
   * ⚠️ 这一步原先缺失：仆人只交结构化报告，从不说话。
   *    于是界面只能把它显示成报表，而用户要的是
   *    「仆人窗口与管家窗口一样，是一段段话」。
   *
   * ⚠️ `.default('')` 而不是 `.min(1)`：
   *    旧数据与旧测试没有这个字段，收紧会让它们全部失败。
   *    空串时界面退回只显示结构化部分（见 `servantMessageText`）。
   */
  reply: z.string().default('').describe('对用户说的那段话（自然语言，非结构说明）'),
  status: z.enum(['done', 'failed', 'blocked']),
  artifacts: z.array(artifactSchema).describe('产出物，可为空数组'),
  /** 诚实声明不确定的地方，而不是硬着头皮给答案 */
  uncertainties: z.array(z.string()).describe('自己不确定的地方；没有就填空数组'),
  needsButlerDecision: needsDecisionSchema,
  findings: z.array(findingSchema).describe('发现清单；没有就填空数组'),
});

export type ExecutionReportOutput = z.infer<typeof executionReportSchema>;

/** 把报告里的 needsButlerDecision 归一化（在适配边界调用）。 */
export function normalizeReport(raw: ExecutionReportOutput): {
  needsButlerDecision: string | undefined;
} {
  return { needsButlerDecision: normalizeNeedsDecision(raw.needsButlerDecision) };
}


// ═══════════════════════════════════════════════════════════
// 反思（分层反思 · 创新点 ①）
// ═══════════════════════════════════════════════════════════

export const reflectionSchema = z.object({
  candidates: z
    .array(
      z.object({
        kind: z
          .enum(['fact', 'preference', 'principle', 'summary'])
          .describe(
            'fact=客观事实；preference=倾向习惯；principle=可复用的行为准则；' +
              'summary=**跨会话的长期状态汇总**（只在周期复盘时产出，见下）',
          ),
        content: z
          .string()
          .min(1)
          .describe(
            '候选内容。fact/preference/principle 一句话说清，不要写成长段落；' +
              'summary 例外 —— 它本来就是长内容汇总，可以写 3—6 句（时间段、状态、成因、建议）',
          ),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe('置信度要诚实：单次观察 0.4—0.6，多次验证才给 0.8 以上'),
        evidence: z.array(z.string()).describe('证据：引用具体的产出或用户反馈'),
        rationale: z.string().describe('你为什么这样判断'),
        // ★ 原则专属：拆成条件与动作，系统才能判断"何时注入"与"是否违背"
        principleCondition: z
          .string()
          .optional()
          .describe(
            '仅当 kind=principle 时填：这条原则在**什么情况下**适用。' +
              '例："推荐餐厅或安排聚餐时"。不填则该原则无法被正确注入。',
          ),
        principleAction: z
          .string()
          .optional()
          .describe(
            '仅当 kind=principle 时填：**具体该怎么做**，要可检查。' +
              '例："先问清同行人的饮食禁忌再给方案"。' +
              '不要写"注意一下"这类无法检查的空话。',
          ),
      }),
    )
    .max(5)
    .describe('反思产出的候选；**没有可复用规律就返回空数组**，不要凑数'),
  /** 仅管家层使用 */
  collaborationIssues: z
    .array(z.string())
    .optional()
    .describe('跨领域协作中发现的问题（单领域反思看不到这些）'),
  /** 仅管家层使用 */
  rhythmChanges: z
    .array(z.string())
    .optional()
    .describe('观察到的生活节奏变化'),
});

export type ReflectionOutput = z.infer<typeof reflectionSchema>;

// ═══════════════════════════════════════════════════════════
// 管家 · 监督校验
// ═══════════════════════════════════════════════════════════

/**
 * 监督复核的输出（v7 · D-7 三视角改造）
 *
 * ★★ 与旧版的根本区别：
 *
 *   | | 旧（crossServant）| 新（三视角 + 契约核对）|
 *   |---|---|---|
 *   | 核对对象 | **仆人与仆人之间是否矛盾** | **产出与契约之间是否对得上** |
 *   | 视角 | 一个（全局看一遍）| **三个**（契约 / 领域 / 全局）|
 *   | 为什么改 | 实测走不通：两个 Agent 都被要求「只提交发现、不做裁决」，各自说得保守，**反而不冲突** | 契约是成文标准，可逐条核对 |
 *
 * ⚠️ 三个视角**是分工，不是修辞**：
 *   · `contract` 契约视角 —— 逐条核对 criteria。**唯一能查「答非所问」**的视角
 *     （旧交叉检查查不出：两个仆人都答对了各自的题，但整体答偏了，没人看得见）
 *   · `domain`   领域视角 —— 用 `DOMAIN_DISCIPLINE` 的专业纪律复核
 *     （如「油 ≤ 5g/人/餐」这种具体标准，全局视角看不出问题）
 *   · `global`   全局视角 —— 硬约束、记忆一致性、原则违背
 */
export const supervisionSchema = z.object({
  criteriaChecks: z
    .array(
      z.object({
        criterion: z.string().min(1).describe('复述契约里的某一条判据（原文）'),
        met: z.boolean().describe('这条判据满足了吗'),
        note: z.string().optional().describe('没满足时说明差在哪；满足了就省略'),
      }),
    )
    .describe('契约里每一条判据都要核对一次，不能漏。判据为 0 条时填空数组'),
  findings: z
    .array(
      z.object({
        viewpoint: z
          .enum(['contract', 'domain', 'global'])
          .describe('contract=契约视角；domain=领域纪律；global=硬约束/记忆/原则'),
        severity: z.enum(['info', 'warn', 'block']),
        /**
         * ⚠️ 这里**接受三个字段名**，是因为实测撞到过：
         *    模型在同一个项目里见过 `executionReportSchema.findings`
         *    （字段叫 `statement`），于是写监督结果时也用了 `statement`，
         *    导致 `message` 缺失、整次调用重试 3 次后失败。
         *
         * ★ 这是项目里已有的做法（见 `findingSchema` 也接受 statement/content）：
         *   不是放宽校验，而是**承认模型会混用同义字段名**，
         *   再由 `normalizeSupervisionFinding` 收敛成一个。
         */
        message: z.string().min(1).optional().describe('问题是什么，一句话'),
        statement: z.string().min(1).optional().describe('message 的别名'),
        content: z.string().min(1).optional().describe('message 的别名'),
        evidence: z.array(z.string()).describe('支撑证据（引用产出里的原话）'),
      }),
    )
    .describe('三个视角发现的问题；没有问题就填空数组'),
  summary: z.string().min(1).describe('整体结论，一句话'),
});

export type SupervisionOutput = z.infer<typeof supervisionSchema>;

// ═══════════════════════════════════════════════════════════
// 事实提取（从用户发言里抽出关于用户本人的事实）
// ═══════════════════════════════════════════════════════════

/**
 * 一条提取出的事实。
 *
 * ⚠️ `quote` 是**必填**且由调用方核对（见 `extractFacts` 里的
 *    `quoteAppearsIn`）。理由：模型很擅长把"常识"写成"用户说过"，
 *    而记忆库一旦被这种内容污染，用户很难发现 ——
 *    他会以为是自己说过的。
 *
 *    ⚠️ 实测踩过：`needsButlerDecision` 那类字段只写 `.optional()`
 *       不接受 `null`，而模型常用明确的 `null` 表示"没有"。
 *       这里同理 —— 用 `.nullable().optional()` 收下它。
 */
export const extractedFactSchema = z.object({
  content: z
    .string()
    .min(2)
    .max(120)
    .describe('第三人称陈述句，不超过 40 字，如「用户对花生严重过敏」'),
  confidence: z.number().min(0).max(1).describe('0—1'),
  category: z
    .enum(['identity', 'constraint', 'preference', 'context'])
    .describe('identity=身份 / constraint=约束 / preference=长期偏好 / context=长期背景'),
  quote: z
    .string()
    .min(2)
    .describe('用户原话片段，必须逐字出现在用户这句话里（这是防幻觉的关键）'),
});

export const memoryExtractionSchema = z.object({
  facts: z
    .array(extractedFactSchema)
    .describe('关于用户本人且长期有效的事实；没有就填空数组（这是正常答案）'),
});

export type ExtractedFactsOutput = z.infer<typeof memoryExtractionSchema>;
