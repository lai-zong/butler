/**
 * 产出物 → 纯文本 的**唯一**渲染实现。
 *
 * ★★ 为什么必须集中在一处：
 *
 *   在 `table` / `quiz` 出现之前，各处都用同一个"聪明"写法把产出物压成文本：
 *
 *     `Array.isArray(a.content) ? a.content.join('；') : String(a.content)`
 *
 *   这个写法对 `text`/`list`/`plan`/`file` 恰好都正确，于是被复制到了 7 处
 *   （硬约束校验、监督员复核、反思、validate…）。
 *
 *   ⚠️ 一旦出现真结构，它就**静默降级**：
 *     · `quiz` 的 content 是**对象数组** → `Array.isArray` 为真 → `join()` → `[object Object]`
 *     · `table` 的 content 是**对象** → 走 `String()` → `[object Object]`
 *
 *   不报错、不崩，只是**监督员和反思从此读到一堆垃圾** ——
 *   这正是最难发现的那类缺陷：功能看起来正常，判断质量悄悄下降。
 *
 *   所以这里不提供"就地一行写完"的写法，只提供这个函数。
 */

import type { ExecutionArtifact } from './types.js';

/** 选项字母，与 `prompts/schemas.ts` 归一化出的答案字母一致 */
const OPTION_LETTERS = 'ABCDEFGH';

/** 渲染结果的两种用途：给人看的文本，以及"有几条"。 */
export interface RenderedArtifact {
  readonly text: string;
  readonly itemCount: number;
}

/**
 * 渲染单个产出物。
 *
 * ⚠️ `quiz` 分支**不输出答案** —— 答案根本不在产出物里（见 `types.ts` 的类型设计）。
 */
export function renderArtifact(artifact: ExecutionArtifact): RenderedArtifact {
  switch (artifact.kind) {
    case 'text':
      return { text: artifact.content, itemCount: 1 };

    case 'list':
    case 'plan':
      return { text: artifact.content.join('\n'), itemCount: artifact.content.length };

    case 'table': {
      const { columns, rows } = artifact.content;
      // Markdown 表格：既适合直接展示，也适合喂给模型的复核材料
      const header = `| ${columns.join(' | ')} |`;
      const divider = `| ${columns.map(() => '---').join(' | ')} |`;
      const body = rows.map(
        (r) => `| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`,
      );
      return { text: [header, divider, ...body].join('\n'), itemCount: rows.length };
    }

    case 'quiz': {
      const questions = artifact.content;
      const text = questions
        .map((q, i) => {
          const head = `${i + 1}. ${q.stem}`;
          const opts = q.options.map((o, j) => `   ${OPTION_LETTERS[j] ?? '?'}. ${o}`);
          return [head, ...opts].join('\n');
        })
        .join('\n\n');
      return { text, itemCount: questions.length };
    }

    case 'file':
      // ⚠️ `ref` 是内部引用，展示时用 name 更有意义
      return { text: `${artifact.content.name}（引用 ${artifact.content.ref}）`, itemCount: 1 };
  }
}

/**
 * 渲染成一行可拼接的文本，供"把产出物当材料读"的调用方使用。
 *
 * @param separator 条目之间的分隔符。不同用途取值不同：
 *   硬约束校验看整段文本（`\n`）；监督员/反思看摘要（`；`）。
 */
export function artifactToText(artifact: ExecutionArtifact, separator = '\n'): string {
  switch (artifact.kind) {
    case 'list':
    case 'plan':
      // 保留调用方指定的分隔符 —— 不要退化成 renderArtifact 的固定 `\n`
      return artifact.content.join(separator);
    case 'table':
      return renderArtifact(artifact).text;
    case 'quiz':
      return renderArtifact(artifact).text;
    case 'text':
      return artifact.content;
    case 'file':
      return renderArtifact(artifact).text;
  }
}
