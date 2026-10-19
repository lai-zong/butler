/**
 * 执行的产物类型（报告 / 发现 / 约束注入）
 *
 * ★★ v8：本文件原名 `servants/types.ts`，描述的是「五个仆人各自汇报」。
 *    那个架构**已经不存在** —— 现在只有一个执行者（管家），
 *    执行完产出一份 `ExecutionReport`，再交给监督员复核。
 *
 * ⚠️ 读这些类型时请注意：
 *   · `Finding` 是**执行者自己的发现**（陈述 + 证据），不是「仆人提交给上级」
 *   · 硬约束的拦截由校验层**机械执行**，不靠执行者自觉
 */

// ═══════════════════════════════════════════════════════════
// 领域标识（重导出）
// ═══════════════════════════════════════════════════════════

/**
 * ★ v8（批次E）：`DomainId` 的**唯一来源**是 `domain/types.ts`。
 *
 * ⚠️ 这里原先自己定义了一份 `'life' | 'health' | ...`，与 `domain/types.ts`
 *    的字面量集合完全相同 —— 属于**两份真相**，早晚漂移。
 */
export type { DomainId } from '../domain/types.js';
import type { DomainId } from '../domain/types.js';

// ═══════════════════════════════════════════════════════════
// 约束注入
// ═══════════════════════════════════════════════════════════

/** 注入给本次执行的约束（§ 2.2⑥ 第 ③ 步，可审计）。v7：整轮一份，不再是「每步各自」。 */
export interface InjectedConstraint {
  readonly memoryId: string;
  readonly content: string;
  readonly source: 'global_constraint' | 'global_shared' | 'sensitive' | 'domain';
  /** 硬约束不可协商；软约束冲突时上报用户裁决 */
  readonly negotiable: boolean;
}

// ═══════════════════════════════════════════════════════════
// 执行汇报
// ═══════════════════════════════════════════════════════════

/**
 * 执行过程中发现的「发现」。
 *
 * ⚠️ **没有 severity 决定权，也没有否决权** —— 判定与拦截由校验层执行。
 *    这条边界比「仆人平等」更本质：**执行者只陈述，不裁决**。
 */
export interface Finding {
  readonly kind: 'constraintRef' | 'risk' | 'alternative';
  readonly statement: string;
  readonly evidence: readonly string[];
  /** 指向全局约束 id，供校验层机械核对 */
  readonly constraintRef?: string;
}

export interface ExecutionReport {
  readonly taskId: string;
  /**
   * 这件事属于哪个领域。
   *
   * ★★ v7（批次2）：由 `readonly servant: DomainId` 改来，两点理由：
   *
   *   ① **值本来就是领域**：`runButler` 写的是 `contract.domains[0]`。
   *      字段名说「哪个仆人」，装的是「哪个领域」—— 数据在撒谎。
   *
   *   ② **改为可选**：`contract.domains` 可以为空（判不出领域）。
   *      旧写法 `?? 'life'` 会**编造**归属，把无关任务挂到「生活」名下。
   *      可选 = 诚实：没有领域就说没有。
   */
  readonly domain?: DomainId;
  readonly status: 'done' | 'failed' | 'blocked';
  /**
   * ★★ 该对**用户**说的那段话（自然语言）。
   *
   * ⚠️ 与 `artifacts` / `findings` 的分工必须分清：
   *   · `reply`     —— 给用户看。界面上那一段正文就是它。
   *   · `artifacts` —— 给监督员核对用的结构化产出。
   *   · `findings`  —— 给监督员复核用的发现与证据。
   *
   * ⚠️ 历史遗留：`servantId` 字段已删除（v8），
   *    领域归属看 `domain`。
   */
  readonly reply: string;
  readonly artifacts: readonly ExecutionArtifact[];
  /** 本次实际用到（注入过）的记忆 id —— 检查点回退靠它建立依赖 */
  readonly memoryRefs: readonly string[];
  readonly uncertainties: readonly string[];
  readonly findings: readonly Finding[];
  /** 需要管家裁决的问题（旧语义：仆人上报）*/
  readonly needsButlerDecision?: string;
}

/**
 * 表格产出物的内容。
 *
 * ★ `columns` 是**单一真相**：每一行都按它对齐（多了截断、少了补空）。
 *   不这么做的话，模型偶尔漏列会让调用方错列渲染。
 */
export interface TableContent {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * 一道题 —— **刻意没有答案字段**。
 *
 * ★★ 答案在 `QuizAnswer` 里，落事件而不进产出物。
 *    "把答案留在产出物里"这件事在类型层面写不出来（不是靠约定）。
 */
export interface QuizQuestion {
  readonly id: string;
  readonly stem: string;
  readonly options: readonly string[];
}

/** 题目的正确答案（服务端专用，落 `quiz.created` 事件）。 */
export interface QuizAnswer {
  readonly id: string;
  /** 正确选项字母（A/B/C…），已归一化 */
  readonly correct: string;
  readonly explanation?: string;
}

/**
 * 产出物。
 *
 * ★ v8（批次E）：类型名由 `ServantArtifact` 改为 `ExecutionArtifact` ——
 *   它描述的是"执行产出了什么"，不是"某个仆人交付了什么"。
 *
 * ★ v8（批次A）：新增 `table` / `quiz` 两种**真结构**。
 *   它们不能压平成字符串 —— 表格有行列，题目要能作答与批改。
 */
export type ExecutionArtifact =
  | { readonly kind: 'text'; readonly content: string }
  | { readonly kind: 'list'; readonly content: readonly string[] }
  | { readonly kind: 'plan'; readonly content: readonly string[] }
  | { readonly kind: 'table'; readonly content: TableContent }
  | { readonly kind: 'quiz'; readonly content: readonly QuizQuestion[] }
  /**
   * ⚠️ `file` **当前没有任何生产者**（模型 schema 里产不出这一种）。
   *
   * 刻意保留而不是删掉：它描述的是「产出物引用了一个文件」这个**真实需求**
   * （例如生成的表格落盘后给出引用）。等真正实现时按它接上即可。
   * `reports.ts` 已能渲染这一种，所以接上时不用改展示层。
   */
  | { readonly kind: 'file'; readonly content: { readonly name: string; readonly ref: string } };
