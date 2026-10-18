/**
 * 仆人产出 → 界面数据
 *
 * ★★ 为什么需要这一层转换：
 *
 *   `ExecutionReport` 是**领域模型**（给管家校验与审计用），
 *   而界面要的是**能排版的形状**（谁来做的、做了什么、依据什么）。
 *   两者字段相近但用途不同，混在一起会让两边都难改。
 *
 * ⚠️ 一处刻意的设计：**仆人只提交发现，管家才做裁决**（方案 § 2.2）。
 *    所以这里**不含**"这个产出对不对"的判断 ——
 *    那是 `Verdict` 的事。这一层只如实呈现仆人说了什么。
 *    把裁决混进来会让界面上的"仆人面板"变成第二个管家，
 *    而那恰恰是方案要避免的（仆人一味平等、无否决权）。
 *
 * ⚠️ 截断是必须的：仆人产出可能几千字，而它要随消息落事件。
 *    界面默认只显示前几行，需要详情时展开。
 *    完整内容在审计视图里能查。
 */

import { renderArtifact } from '../execution/render.js';
import type { ExecutionReportData } from './types.js';
import type { RunSessionResult } from '../runtime/orchestrator.js';

/** 单个产出物留存的最大字符数。 */
export const REPORT_ARTIFACT_LIMIT = 1500;

/** 单条发现留存的最大字符数。 */
export const REPORT_FINDING_LIMIT = 500;

/** 最多保留几条不确定声明。 */
export const REPORT_UNCERTAINTY_LIMIT = 6;

/**
 * 把一次会话的全部仆人产出转成界面数据。
 *
 * ★ 每份产出都带上**注入给它的约束** —— 这是「约束注入可见」
 *   （方案 § 2.2⑥）在仆人面板上的落点：
 *   用户能看到「这个仆人是在知道了什么的前提下给出这个结论的」。
 */
/**
 * ★ 这里只接受**真正用到的三个字段**，而不是整个 RunSessionResult。
 *
 * ⚠️ 为什么：旧签名要求整个 RunSessionResult，于是 directServant（旧仆人端点）
 *    只能手工拼一个最小对象再 s unknown as 强转 —— **强转把类型检查关掉了**。
 *    后来 P1 修改让函数读了一个那个对象没提供的字段，编译器完全无法提示。
 *
 *    ★ 窄化之后：调用方**漏字段就编译报错**，不需要强转。
 */
export type SessionReportSource = Pick<
  RunSessionResult,
  'reports' | 'contract' | 'injectedConstraints'
>;

export function toExecutionReportData(session: SessionReportSource): readonly ExecutionReportData[] {
  return session.reports.map((r) => ({
    /**
     * ⚠️ 下游 `ExecutionReportData` 的字段名仍是 `servant`（遗留），此处传领域值。
     *    改名它的类型是一次独立改动（批次2b）。
     */
    servant: (r.domain ?? '') as never,
    taskId: r.taskId,
    status: r.status,
    // ★ 仆人自己说的话 —— 界面上这就是它的消息正文
    reply: r.reply,
    instruction: instructionOf(session),
    artifacts: r.artifacts.map((a) => {
      // ★ 复用 `execution/render.ts` 的**唯一**渲染实现 ——
      //   不在这里再维护一份按 kind 展开的 switch（两份必然漂移）。
      const { text, itemCount } = renderArtifact(a);
      return {
        kind: a.kind,
        text:
          text.length > REPORT_ARTIFACT_LIMIT
            ? `${text.slice(0, REPORT_ARTIFACT_LIMIT)}…（已截断）`
            : text,
        itemCount,
      };
    }),
    findings: (r.findings ?? []).map((f) => ({
      kind: f.kind,
      statement:
        f.statement.length > REPORT_FINDING_LIMIT
          ? `${f.statement.slice(0, REPORT_FINDING_LIMIT)}…`
          : f.statement,
      evidence: f.evidence.slice(0, 5),
    })),
    uncertainties: r.uncertainties.slice(0, REPORT_UNCERTAINTY_LIMIT),
    ...(r.needsButlerDecision !== undefined
      ? { needsButlerDecision: r.needsButlerDecision }
      : {}),
    injectedConstraints: constraintsOf(session),
  }));
}

/**
 * 取出本次执行的指令 —— 即**契约的交付物**。
 *
 * ★★ v8 修复（这是一处**静默失效**，不报错的那种）：
 *
 *   ⚠️ 原来从 `session.steps` 里找：
 *       const step = session.steps.find((s) => s.stepId === taskId);
 *       return step?.instruction ?? '';
 *
 *   而 `steps` 在 v7 之后**恒为空数组**（orchestrator 里标了 `@deprecated`）——
 *   于是这个函数**恒返回空串**。不报错、不告警，就是一直没有值。
 *
 *   ★ 现在的数据来源是对的：单执行者架构下，"给它的指令"就是
 *     **契约里的交付物**（`session.contract.deliverable`）——
 *     而且那正是管家自己写下的承诺，语义比旧的 `instruction` 更准。
 *
 * ⚠️ 没有契约（如纯推理验证场景）时如实返回空串，不编占位符。
 */
function instructionOf(session: Pick<RunSessionResult, 'contract'>): string {
  return session.contract?.deliverable ?? '';
}

/**
 * 取出本次执行注入的约束。
 *
 * ★ 这是「约束注入可见」（方案 § 2.2⑥ 第 ③ 步）的落点：
 *   用户能看到"它是在知道了什么的前提下给出这个结论的"。
 *
 * ★★ v8 修复（同一处静默失效）：
 *   原来从 `session.steps[i].injectedConstraints` 取，而 `steps` 恒为空 →
 *   **恒返回 `[]`**，界面上那一条"它知道了什么"永远不出现。
 *
 *   现在改读 `session.injectedConstraints` —— v7 起约束是**整轮一份**
 *   （单执行者，没有"每步各自的约束"这回事）。
 */
function constraintsOf(
  session: Pick<RunSessionResult, 'injectedConstraints'>,
): readonly { readonly content: string; readonly negotiable: boolean }[] {
  /**
   * ⚠️ `?? []` 不是多余防御：这条路径有两个调用方，
   *    其中 `directServant`（旧仆人端点）传的是**手工组装的最小对象**。
   *
   *    实测撞到过：P1 修复把它从 `steps[i].injectedConstraints` 改成本函数的
   *    `.map()` 之后，那个对象**没有 `injectedConstraints`** → TypeError。
   *    而当时代码里是 `as unknown as` 强转，**类型系统和测试都没拦住**。
   *
   *    ★ 现在两头都收紧了：
   *      · 参数类型改成 `Pick<...>` —— 调用方必须给这个字段，否则编译报错
   *      · 这里再 `?? []` —— 防运行时的历史数据/半成品对象
   */
  return (session.injectedConstraints ?? []).map((c) => ({
    content: c.content,
    negotiable: c.negotiable,
  }));
}


/** 产出物类型的展示名。 */
export const ARTIFACT_KIND_LABEL: Record<string, string> = {
  text: '正文',
  list: '清单',
  plan: '方案',
  file: '文件',
};

/** 发现类型的展示名。 */
export const FINDING_KIND_LABEL: Record<string, string> = {
  constraintRef: '约束相关',
  risk: '风险',
  alternative: '备选',
};
