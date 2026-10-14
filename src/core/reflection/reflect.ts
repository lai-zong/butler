/**
 * 分层反思 —— 创新点 ①：学得「对」
 *
 * 设计依据：方案 § 2.2④、§ 8.8
 *
 * 反思分两层，**作用域被结构性隔离**：
 *
 *   第一层 · 仆人自省（各领域独立）
 *     · 我在这个领域哪里做得好 / 不好
 *     · 本领域是否出现了可复用的规律
 *     → 产出【领域记忆候选 / 领域原则候选】
 *     ⚠️ 反思范围被限制在本领域，不会污染全局
 *
 *   第二层 · 管家复盘（跨领域）
 *     · 跨领域协作是否顺畅
 *     · 是否有跨领域的规律
 *     · 用户的生活节奏是否发生变化
 *     → 产出【全局记忆候选 / 跨领域原则候选】
 *
 * ★ 关键设计：隔离**不是靠提示词请求模型自律**，而是靠**输入构造**：
 *   仆人的反思材料里根本不含其它领域的记忆与产出（见 `buildServantReflectionInput`）。
 *   模型看不到，就无从被污染。这比"请只关注你的领域"可靠得多。
 */

import { EventLog } from '../events/log.js';
import { msg, type ModelPort } from '../ports/model.js';
import { PROMPT_VERSIONS, reflectionButlerTask, reflectionServantTask } from '../prompts/butler.js';
import { reflectionSchema } from '../prompts/schemas.js';
import type { MemoryClass, MemoryKind } from '../memory/types.js';
import { SERVANT_BOUNDARY, type ServantId, type ServantReport } from '../servants/types.js';
import type { ClockPort } from '../ports/clock.js';

// ═══════════════════════════════════════════════════════════
// 反思产出的候选
// ═══════════════════════════════════════════════════════════

/** 候选的归属与作用域 —— 决定它进入哪一层记忆。 */
export interface CandidateScope {
  /** 领域反思 → 'domain'；跨领域复盘 → 全局层 */
  readonly memClass: MemoryClass;
  /** 领域反思必填：属于哪个仆人 */
  readonly domainOwner?: ServantId;
}

export interface MemoryCandidate {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly confidence: number;
  /** 证据链：来自哪些事件 / 哪些产出 */
  readonly evidence: readonly string[];
  readonly scope: CandidateScope;
  /** 反思者的理由 —— 用户审核时要能看到"你为什么这么认为" */
  readonly rationale: string;
  /** 由哪一层反思产出 */
  readonly layer: 'servant' | 'butler';
  /** 仆人层反思时是哪个仆人 */
  readonly by: ServantId | 'butler';
  readonly createdAt: number;
  /**
   * 原则专属：适用条件与行为要求。
   *
   * ⚠️ 没有它，这条原则**无法被正确注入**（系统不知道何时该用它），
   *    也无法被检测是否被违背。所以 kind=principle 时要求模型必须给出。
   */
  readonly principle?: { readonly condition: string; readonly action: string };
}

export interface ReflectionRunResult {
  readonly layer: 'servant' | 'butler';
  readonly by: ServantId | 'butler';
  readonly candidates: readonly MemoryCandidate[];
  /** 本次反思观察到的协作问题（管家层） */
  readonly collaborationIssues: readonly string[];
  /** 本次反思观察到的节奏变化（管家层） */
  readonly rhythmChanges: readonly string[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly promptVersion: string;
}

// ═══════════════════════════════════════════════════════════
// 第一层 · 仆人自省
// ═══════════════════════════════════════════════════════════

/**
 * 仆人反思的输入材料。
 *
 * ⚠️ **这个结构本身就是隔离机制**：
 *    它只包含"本仆人的产出"与"本领域的记忆"，
 *    **没有**其它仆人的产出、**没有**全局记忆、**没有**敏感域内容。
 *    所以即便提示词失效，污染也无从发生 —— 模型看不到别的领域。
 */
export interface ServantReflectionInput {
  readonly servant: ServantId;
  /** 本次会话中该仆人的全部产出 */
  readonly ownReports: readonly ServantReport[];
  /** 该仆人领域内的既有记忆（仅 content 与 kind，不含其它领域） */
  readonly ownDomainMemories: readonly { readonly id: string; readonly kind: MemoryKind; readonly content: string; readonly lifecycle: string }[];
  /** 用户对该仆人产出的反馈（采纳 / 纠正） */
  readonly feedback: readonly { readonly onArtifact: string; readonly effective: boolean; readonly note?: string }[];
  /** 本次任务的目标（仆人知道自己在为什么服务） */
  readonly userGoal: string;
}

export async function reflectServant(args: {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly input: ServantReflectionInput;
}): Promise<ReflectionRunResult> {
  const now = args.clock.now();
  const { servant } = args.input;

  args.log.append({
    type: 'reflection.started',
    actor: 'servant',
    servantId: servant,
    payload: {
      layer: 'servant',
      materials: {
        ownReports: args.input.ownReports.length,
        ownDomainMemories: args.input.ownDomainMemories.length,
        feedback: args.input.feedback.length,
      },
    },
    createdAt: now,
  });

  const result = await args.model.completeStructured({
    purpose: 'reflection',
    schema: reflectionSchema,
    schemaName: 'ReflectionOutput',
    temperature: 0.3,
    maxOutputTokens: 2048,
    messages: [
      msg.system(servantReflectionSystem(servant)),
      msg.user(
        reflectionServantTask({
          servant: `${SERVANT_BOUNDARY[servant].name}（${servant}）`,
          userGoal: args.input.userGoal,
          ownReports: args.input.ownReports.map((r) => ({
            stepId: r.taskId,
            status: r.status,
            summary: summarizeReport(r),
          })),
          ownDomainMemories: args.input.ownDomainMemories,
          feedback: args.input.feedback,
        }),
      ),
    ],
  });

  const candidates = result.value.candidates
    .map((c, i) => toCandidate(c, i, { memClass: 'domain', domainOwner: servant }, 'servant', servant, now))
    .filter((c): c is MemoryCandidate => c !== null);

  args.log.append({
    type: 'reflection.done',
    actor: 'servant',
    servantId: servant,
    payload: {
      layer: 'servant',
      candidateCount: candidates.length,
      candidates: candidates.map((c) => ({ kind: c.kind, content: c.content, confidence: c.confidence })),
      usage: result.usage,
      promptVersion: PROMPT_VERSIONS.reflectionServantTask,
    },
    createdAt: now,
  });

  return {
    layer: 'servant',
    by: servant,
    candidates,
    collaborationIssues: [],
    rhythmChanges: [],
    usage: result.usage,
    promptVersion: PROMPT_VERSIONS.reflectionServantTask,
  };
}

/** 仆人反思的系统提示。 */
export function servantReflectionSystem(servant: ServantId): string {
  const b = SERVANT_BOUNDARY[servant];
  return `你是「${b.name}」，现在做**会话后的自我反思**。

## 你的反思范围（不可越界）

你的领域是：${b.domain}
判据：${b.test}

**你只能反思你自己领域内的事。** 关于其它领域：
- 不要提建议（那是别的仆人的职责）
- 不要评价别的仆人做得对不对
- 如果发现某件事"看起来跨领域"，写进 uncertainties，交由管家处理

## 反思要产出什么

两类东西，**只提真正有复用价值的**：

1. **领域事实 / 偏好候选** —— 用户在你这领域表现出的稳定特征
2. **领域原则候选** —— 你在这个领域总结出的"下次该怎么做"的行为准则

## 质量要求

- **宁可少提，不要凑数。** 一次反思 0—3 条候选是正常的；
  提不出可复用规律就返回空数组，**不要为了显得有产出而编造**。
- 每条候选必须有**证据**：引用具体的产出或用户反馈。
- 置信度要诚实：只有一次观察的给 0.4—0.6，多次验证过的才给 0.8 以上。
- **不要提出与既有记忆重复的候选** —— 材料里给了你的既有记忆，先对照。`;
}

// ═══════════════════════════════════════════════════════════
// 第二层 · 管家复盘
// ═══════════════════════════════════════════════════════════

export interface ButlerReflectionInput {
  /** 全部仆人的产出摘要 */
  readonly reports: readonly { readonly servant: ServantId; readonly summary: string }[];
  /** 本次会话检出的冲突与裁决 */
  readonly conflicts: readonly { readonly message: string; readonly severity: string; readonly resolvedBy?: string }[];
  /** 全局层的既有记忆 */
  readonly globalMemories: readonly { readonly id: string; readonly kind: MemoryKind; readonly content: string; readonly lifecycle: string }[];
  /** 已有的跨领域原则及其效果（用于判断该降权还是强化） */
  readonly existingPrinciples: readonly {
    readonly id: string;
    readonly content: string;
    readonly applied: number;
    readonly succeeded: number;
  }[];
  readonly userGoal: string;
  /** 时间维度规律（来自行为观察，尚未实现时为空） */
  readonly temporalPatterns: readonly string[];
}

export async function reflectButler(args: {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly input: ButlerReflectionInput;
}): Promise<ReflectionRunResult> {
  const now = args.clock.now();

  args.log.append({
    type: 'reflection.started',
    actor: 'butler',
    payload: {
      layer: 'butler',
      materials: {
        reports: args.input.reports.length,
        conflicts: args.input.conflicts.length,
        globalMemories: args.input.globalMemories.length,
        existingPrinciples: args.input.existingPrinciples.length,
      },
    },
    createdAt: now,
  });

  const result = await args.model.completeStructured({
    purpose: 'reflection',
    schema: reflectionSchema,
    schemaName: 'ReflectionOutput',
    temperature: 0.3,
    maxOutputTokens: 2048,
    messages: [
      msg.system(butlerReflectionSystem()),
      msg.user(
        reflectionButlerTask({
          userGoal: args.input.userGoal,
          reports: args.input.reports.map((r) => ({ servant: r.servant, summary: r.summary })),
          conflicts: args.input.conflicts.map((c) => ({
            message: c.message,
            severity: c.severity,
            ...(c.resolvedBy !== undefined ? { resolvedBy: c.resolvedBy } : {}),
          })),
          globalMemories: args.input.globalMemories,
          existingPrinciples: args.input.existingPrinciples,
          temporalPatterns: args.input.temporalPatterns,
        }),
      ),
    ],
  });

  const candidates = result.value.candidates
    .map((c, i) =>
      toCandidate(
        c,
        i,
        // 管家层产出跨领域原则 → 进全局共享层（不是硬约束，硬约束只能来自用户）
        { memClass: 'global_shared' },
        'butler',
        'butler',
        now,
      ),
    )
    .filter((c): c is MemoryCandidate => c !== null);

  args.log.append({
    type: 'reflection.done',
    actor: 'butler',
    payload: {
      layer: 'butler',
      candidateCount: candidates.length,
      collaborationIssues: result.value.collaborationIssues,
      rhythmChanges: result.value.rhythmChanges,
      usage: result.usage,
      promptVersion: PROMPT_VERSIONS.reflectionButlerTask,
    },
    createdAt: now,
  });

  return {
    layer: 'butler',
    by: 'butler',
    candidates,
    collaborationIssues: result.value.collaborationIssues ?? [],
    rhythmChanges: result.value.rhythmChanges ?? [],
    usage: result.usage,
    promptVersion: PROMPT_VERSIONS.reflectionButlerTask,
  };
}

/** 把仆人汇报压成一句摘要，供反思材料使用（避免 prompt 过长）。 */
export function summarizeReport(r: ServantReport): string {
  const arts = r.artifacts
    .map((a) => (Array.isArray(a.content) ? a.content.join('；') : String(a.content)))
    .join(' | ');
  const finds = (r.findings ?? []).map((f) => `[${f.kind}] ${f.statement}`).join('；');
  const joined = [arts, finds].filter((s) => s.length > 0).join(' ‖ ') || '(无产出)';
  return joined.length <= 700 ? joined : `${joined.slice(0, 700)}…（已截断）`;
}

export function butlerReflectionSystem(): string {
  return `你是这个系统的「管家」，现在做**会话后的跨领域复盘**。

## 你的视角与仆人的区别

仆人只能看到自己领域；**你能看到全局**。所以你要反思的是
**仆人看不到的那些东西**：

1. **跨领域协作是否顺畅** —— 有没有该派发却没派发的、派发顺序不合理的、
   两个仆人的产出需要来回返工的
2. **跨领域规律** —— 多个领域共同反映出的用户特征
   （例：生活领域"常点外卖" + 健康领域"作息不规律" → 跨领域规律"工作繁忙期饮食不规律"）
3. **生活节奏变化** —— 与既有全局记忆相比，用户的行为模式是否在变

## 你能产出什么

**跨领域原则候选**（进入全局共享层）—— 例：
- "涉及时间安排时先确认是工作日还是周末"
- "跨领域冲突时，安全类约束优先于体验类偏好"

以及**全局事实 / 偏好候选**。

## 你**不能**产出什么

- ❌ **硬约束**（如过敏原）—— 那只能由用户设定，反思不能凭空造出安全约束
- ❌ 领域内的具体偏好 —— 那是仆人的职责，你越界会产生重复

## 质量要求

- **宁可少提。** 0—2 条候选是正常的；没有跨领域规律就返回空数组。
- 每条候选必须有证据，置信度要诚实。
- 材料里给了既有全局记忆与已有原则的**效果数据**，
  如果某条原则 applied 很多但 succeeded 很少，说明它**不管用**，
  可以提一条修正候选（而不是重复提原话）。`;
}

// ═══════════════════════════════════════════════════════════
// 内部
// ═══════════════════════════════════════════════════════════

interface RawReflectionCandidate {
  readonly kind: 'fact' | 'preference' | 'principle';
  readonly content: string;
  readonly confidence: number;
  readonly evidence?: readonly string[];
  readonly rationale?: string;
  // exactOptionalPropertyTypes 下必须显式允许 undefined —— 
  // Zod 的 .optional() 产出的类型是 string | undefined
  readonly principleCondition?: string | undefined;
  readonly principleAction?: string | undefined;
}

function toCandidate(
  c: RawReflectionCandidate,
  index: number,
  scope: CandidateScope,
  layer: 'servant' | 'butler',
  by: ServantId | 'butler',
  now: number,
): MemoryCandidate | null {
  const content = c.content.trim();
  if (content.length === 0) return null; // 空候选直接丢弃，不制造噪声

  return {
    id: `cand_${layer}_${by}_${now.toString(36)}_${index}`,
    kind: c.kind,
    content,
    // 无需 clamp：reflectionSchema 已约束 confidence ∈ [0,1]，
    // 越界输出会在适配器层被拒绝并重试（见 schemas.ts）
    confidence: c.confidence,
    evidence: c.evidence ?? [],
    scope,
    rationale: c.rationale ?? '',
    layer,
    by,
    createdAt: now,
  };
}

/**
 * 构造仆人反思材料 —— **隔离在类型层面就已完成**。
 *
 * 这个函数刻意不接受 globalMemories / otherServantReports 之类的参数：
 * 参数列表里没有，就没人能顺手传进来。这是比"提示词请求自律"可靠得多的隔离。
 */
export function buildServantReflectionInput(args: {
  readonly servant: ServantId;
  readonly userGoal: string;
  readonly ownReports: readonly ServantReport[];
  readonly ownDomainMemories: readonly { readonly id: string; readonly kind: MemoryKind; readonly content: string; readonly lifecycle: string }[];
  readonly feedback?: readonly { readonly onArtifact: string; readonly effective: boolean; readonly note?: string }[];
}): ServantReflectionInput {
  return {
    servant: args.servant,
    userGoal: args.userGoal,
    ownReports: args.ownReports,
    ownDomainMemories: args.ownDomainMemories,
    feedback: args.feedback ?? [],
  };
}
