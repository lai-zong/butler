/**
 * 仆人产出 → 界面数据
 *
 * ★★ 为什么需要这一层转换：
 *
 *   `ServantReport` 是**领域模型**（给管家校验与审计用），
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

import type { ServantId, ServantReport } from '../servants/types.js';
import type { ServantReportData } from './types.js';
import type { RunSessionResult } from '../runtime/orchestrator.js';

/** 单个产出物留存的最大字符数。 */
export const REPORT_ARTIFACT_LIMIT = 1500;

/** 单条发现留存的最大字符数。 */
export const REPORT_FINDING_LIMIT = 500;

/** 最多保留几条不确定声明。 */
export const REPORT_UNCERTAINTY_LIMIT = 6;

/**
 * 产出物 → 可显示的文本。
 *
 * ⚠️ `ServantArtifact` 有**四种**形态，不是两种：
 *     text   → 字符串
 *     list   → 字符串数组（清单）
 *     plan   → 字符串数组（步骤）
 *     file   → **对象** `{ name, ref }`（文件引用）
 *
 *    我第一版只处理了"字符串或数组"，遇到 `file` 会在
 *    `.join()` 上崩 —— 而 `file` 恰恰是"仆人真的产出了文件"那一类，
 *    漏掉它会静默丢掉最有价值的产出。
 */
function artifactText(content: ServantReport['artifacts'][number]['content']): {
  text: string;
  itemCount: number;
} {
  if (typeof content === 'string') return { text: content, itemCount: 1 };
  if (Array.isArray(content)) return { text: content.join('\n'), itemCount: content.length };
  // file 形态 —— ⚠️ `ref` 是内部引用，展示时用 name 更有意义
  const file = content as { readonly name: string; readonly ref: string };
  return { text: `${file.name}（引用 ${file.ref}）`, itemCount: 1 };
}

/**
 * 把一次会话的全部仆人产出转成界面数据。
 *
 * ★ 每份产出都带上**注入给它的约束** —— 这是「约束注入可见」
 *   （方案 § 2.2⑥）在仆人面板上的落点：
 *   用户能看到「这个仆人是在知道了什么的前提下给出这个结论的」。
 */
export function toServantReportData(session: RunSessionResult): readonly ServantReportData[] {
  return session.reports.map((r) => ({
    servant: r.servant,
    taskId: r.taskId,
    status: r.status,
    // ★ 仆人自己说的话 —— 界面上这就是它的消息正文
    reply: r.reply,
    instruction: instructionOf(session, r.taskId),
    artifacts: r.artifacts.map((a) => {
      const { text, itemCount } = artifactText(a.content);
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
    injectedConstraints: constraintsOf(session, r.taskId),
  }));
}

/**
 * 取出该步骤的指令。
 *
 * ⚠️ 取不到时**如实返回空串**，而不是编一个「（未知任务）」——
 *    界面据此决定是否显示那一行。编出来的占位符会被当成真内容。
 */
function instructionOf(session: RunSessionResult, taskId: string): string {
  const step = session.steps.find((s) => s.stepId === taskId);
  return step?.instruction ?? '';
}

/**
 * 取出该步骤注入的约束。
 *
 * ★ 这是「约束注入可见」（方案 § 2.2⑥ 第 ③ 步）在仆人面板上的落点：
 *   用户能看到"这个仆人是在知道了什么的前提下给出这个结论的"。
 *
 * ⚠️ 从 `steps` 取而不是扫事件流 ——
 *    事件流那些是**已发生**的记录（审计用），
 *    这里是"给它的输入是什么"（展示用）。
 *    两者在这件事上等价，但前者要扫全量事件，代价大得多。
 */
function constraintsOf(
  session: RunSessionResult,
  taskId: string,
): readonly { readonly content: string; readonly negotiable: boolean }[] {
  const step = session.steps.find((s) => s.stepId === taskId);
  if (step === undefined) return [];
  return step.injectedConstraints.map((c) => ({
    content: c.content,
    negotiable: c.negotiable,
  }));
}

/** 仆人的展示名（界面不该自己维护这份映射 —— 会与领域层漂移）。 */
export const SERVANT_DISPLAY_NAME: Record<ServantId, string> = {
  life: '生活仆人',
  health: '健康仆人',
  study: '学习仆人',
  work: '办公仆人',
  code: '代码仆人',
};

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
