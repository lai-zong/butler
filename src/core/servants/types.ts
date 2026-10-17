/**
 * 仆人身份与职责边界
 *
 * 设计依据：参赛方案 v6.5 § 2.1
 *
 * ⚠️ 编排原则：**五个仆人完全平等，唯一裁决者是管家。**
 *    仆人只提交 findings（发现 + 证据），不做裁决、不排序、不判定严重性。
 *    硬约束的拦截由管家校验层机械执行，不是某个仆人的权力。
 */

// ═══════════════════════════════════════════════════════════
// 仆人身份
// ═══════════════════════════════════════════════════════════

import type { DomainId } from '../domain/types.js';

export type ServantId = 'life' | 'health' | 'study' | 'work' | 'code';

export const SERVANT_IDS: readonly ServantId[] = ['life', 'health', 'study', 'work', 'code'];

/**
 * 职责边界 —— 防重合的依据（答辩可直接引用）。
 *
 * 边界测试法：**这个决定的核心依据是"方便/划算"，还是"对身体好不好"？**
 * 注意「选择」与「评价」是两件事：生活仆人负责选，健康仆人负责评价。
 */
export const SERVANT_BOUNDARY: Record<ServantId, { name: string; domain: string; test: string }> = {
  life: {
    name: '生活仆人',
    domain: '外部世界的资源获取',
    test: '去哪、买什么、怎么去',
  },
  health: {
    name: '健康仆人',
    domain: '身体与习惯的约束和分析（含营养 / 运动 / 作息）',
    test: '能不能、该不该、多少量',
  },
  study: {
    name: '学习仆人',
    domain: '知识获取、技能训练、资料整理',
    test: '学什么、怎么练',
  },
  work: {
    name: '办公仆人',
    domain: '文档、日程、会议、文件整理',
    test: '写什么、安排在哪天',
  },
  code: {
    name: '代码仆人',
    domain: '编程、调试、脚本、自动化',
    test: '怎么实现、怎么自动化',
  },
};


// ═══════════════════════════════════════════════════════════
// 任务分解与派发
// ═══════════════════════════════════════════════════════════

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** 注入给某个仆人的约束（§ 2.2⑥ 第 ③ 步，可审计）。 */
export interface InjectedConstraint {
  readonly memoryId: string;
  readonly content: string;
  readonly source: 'global_constraint' | 'global_shared' | 'sensitive' | 'domain';
  /** 硬约束不可协商；软约束冲突时上报用户裁决 */
  readonly negotiable: boolean;
}

/** 上游步骤传给本步骤的产出物（方案 § 2.2① 依赖关系的实际语义）。 */
export interface UpstreamInput {
  readonly stepId: string;
  readonly servant: string;
  readonly artifacts: readonly ServantArtifact[];
  /** 上游的发现（仅陈述，不含裁决） */
  readonly findings: readonly Finding[];
}

export interface DispatchStep {
  readonly stepId: string;
  readonly servant: ServantId | 'butler';
  readonly instruction: string;
  readonly dependsOn: readonly string[];
  readonly status: StepStatus;
  /** 管家按任务相关性注入，而非仆人读取全部记忆 */
  readonly injectedConstraints: readonly InjectedConstraint[];
  /**
   * 依赖步骤的产出物。
   *
   * ⚠️ 没有这个字段，"依赖"就只是**顺序控制**，下游拿不到上游做出来的东西——
   *    实测表现为：健康仆人声称"未收到菜单原文，无法独立复核"，
   *    于是它只能声明风险而无法真正审核（由监督层 crossServant 检出）。
   */
  readonly inputs?: readonly UpstreamInput[];
  readonly report?: ServantReport;
}

export interface Dispatch {
  readonly id: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly decomposition: readonly DispatchStep[];
  /** 路由置信度。低于阈值时转入澄清提问（route.clarify） */
  readonly routingConfidence: number;
  readonly createdAt: number;
}

// ═══════════════════════════════════════════════════════════
// 仆人汇报
// ═══════════════════════════════════════════════════════════

/**
 * 仆人提交的"发现"。
 *
 * ⚠️ **没有 severity 决定权，也没有否决权** —— 判定与拦截由管家校验层执行。
 * 这是"仆人完全平等"在类型层面的体现。
 */
export interface Finding {
  readonly kind: 'constraintRef' | 'risk' | 'alternative';
  readonly statement: string;
  readonly evidence: readonly string[];
  /** 指向全局约束 id，供管家机械校验 */
  readonly constraintRef?: string;
}

export interface ServantReport {
  readonly taskId: string;
  /**
   * 这件事属于哪个领域。
   *
   * ★★ v7（批次2）：由 `readonly servant: ServantId` 改来，两点理由：
   *
   *   ① **值本来就是领域**：`runButler` 写的是 `contract.domains[0]`。
   *      字段名说「哪个仆人」，装的是「哪个领域」—— 数据在撒谎。
   *
   *   ② **改为可选**：`contract.domains` 可以为空（判不出领域）。
   *      旧写法 `?? 'life'` 会**编造**归属，把无关任务挂到「生活」名下。
   *      可选 = 诚实：没有领域就说没有。
   *
   * ⚠️ 类型名仍叫 `ServantReport` —— 改名会波及 50+ 引用，
   *    与字段语义修正混在一起会让 diff 无法审阅。类型名单独一次改。
   */
  readonly domain?: DomainId;
  readonly status: 'done' | 'failed' | 'blocked';
  /**
   * ★★ 该对**用户**说的那段话（自然语言）。
   *
   * ⚠️ 与 `artifacts` / `findings` 的分工必须分清：
   *   · `reply`     —— 给用户看。界面上仆人说的话就是它。
   *   · `artifacts` —— 给管家核对用的结构化产出。
   *   · `findings`  —— 给管家裁决用的发现与证据。
   *
   * ★ 为什么两套都要：结构删了就没法做机械硬约束校验
   *   （方案 § 2.2 要求 `verifyHardConstraints` 是确定性判定，
   *   不能靠模型判断），也没法在失败时打回重做。
   *   所以不是「用 reply 替换结构」，而是**两者并存、各司其职**。
   */
  readonly reply: string;
  readonly artifacts: readonly ServantArtifact[];
  /** 本次用到了哪些记忆（可审计） */
  readonly memoryRefs: readonly string[];
  /** 诚实声明不确定的地方，而不是硬着头皮给答案 */
  readonly uncertainties: readonly string[];
  /** 需要管家裁决的问题 */
  readonly needsButlerDecision?: string;
  /** 只提交发现，不做裁决 */
  readonly findings?: readonly Finding[];
}

export type ServantArtifact =
  | { readonly kind: 'text'; readonly content: string }
  | { readonly kind: 'list'; readonly content: readonly string[] }
  | { readonly kind: 'plan'; readonly content: readonly string[] }
  | { readonly kind: 'file'; readonly content: { readonly name: string; readonly ref: string } };

// ═══════════════════════════════════════════════════════════
// 冲突
// ═══════════════════════════════════════════════════════════

export type ConflictKind =
  | 'crossServant' // 跨领域建议矛盾
  | 'memoryInconsistency' // 新旧记忆矛盾
  | 'principleViolation' // 违背已生效原则
  | 'omission'; // 遗漏关键约束

export type ConflictSeverity = 'info' | 'warn' | 'block';

export type ConflictResolution =
  | { readonly kind: 'askUser' }
  | { readonly kind: 'autoResolved'; readonly by: string; readonly reason: string }
  | { readonly kind: 'dismissed'; readonly by: string; readonly reason: string }
  | { readonly kind: 'hardBlocked'; readonly constraintId: string; readonly reason: string };

export interface MemoryConflict {
  readonly id: string;
  readonly kind: ConflictKind;
  readonly severity: ConflictSeverity;
  readonly message: string;
  readonly evidence: readonly string[];
  readonly parties?: readonly ServantId[];
  readonly resolution: ConflictResolution;
}
