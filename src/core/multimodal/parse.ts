/**
 * 附件解析：把用户上传的东西变成**结构化结果**（E1/E2 的核心缺口）
 *
 * ★★ 这个文件补的是一个"以为只差接线、其实是空的"缺口。
 *
 *   核查代码发现：`ParsedAttachment` 类型、`extractMemoryCandidates`、
 *   `routeAttachment`、`classifyAttachment` 全都写好了**并有测试**，
 *   但 **`parseAttachment` 根本不存在** ——
 *   也就是说"附件 → 结构化结果"这一环**从未实现**，
 *   于是 `extractMemoryCandidates` 永远拿不到输入，多模态进记忆是断的。
 *
 * ⚠️ 三条如实说明的能力边界：
 *
 *   ① **图片**：走视觉模型（需要 `supportsVision`）。
 *      ⚠️ 必须**先查能力再调用** —— 实测 `deepseek-v4-pro` 收到图片**不报错**，
 *      HTTP 200，只在正文里回一句"抱歉，我无法查看这张图片"。
 *      不查能力就会无声降级。
 *
 *   ② **纯文本**：直接内联进提示词（有长度上限）。
 *
 *   ③ **PDF / docx 等二进制文档**：**做不到** —— 我们没有任何文本抽取器。
 *      与其"猜一份内容"，不如明确返回失败原因。
 *      这也是 E1 的真实边界，不该在文档里含糊过去。
 */

import { z } from 'zod';

import { msg, type ModelPort } from '../ports/model.js';
import type { ClockPort } from '../ports/clock.js';
import type { EventLog } from '../events/log.js';
import {
  extractMemoryCandidates,
  type AttachmentKind,
  type MemoryCandidateFromAttachment,
  type ParsedAttachment,
} from './attach.js';

/** 解析输入：图片给 URL，文本给正文 */
export type ParseSource =
  | { readonly kind: 'image'; readonly url: string }
  | { readonly kind: 'text'; readonly text: string };

/** 纯文本内联上限：再长就不该当成"一次解析"塞进提示词 */
export const MAX_INLINE_TEXT_CHARS = 8_000;

/**
 * 解析输出的结构。
 *
 * ★ `fields` 的键名**刻意与 `MEMORY_WORTHY` 的规则对齐**（品牌/品类/金额/日期…），
 *   否则解析出来的东西提取不到记忆候选 —— 那一环就白做了。
 */
export const attachmentParseSchema = z.object({
  fields: z
    .record(z.string(), z.string())
    .describe(
      '结构化键值。**只写图上/文中真实出现的信息**，不要推断。' +
        '常见键名：品牌 / 商家 / 品类 / 金额 / 日期 / 商品 / 数量。' +
        '拿不准的项宁可不写，不要编造。',
    ),
  summary: z
    .string()
    .min(1)
    .describe('这份附件是什么、关键信息是什么，2—3 句；只描述看得见的内容'),
});

export type AttachmentParseOutput = z.infer<typeof attachmentParseSchema>;

export type ParseOutcome =
  | {
      readonly ok: true;
      readonly parsed: ParsedAttachment;
      /** 顺手提炼出的记忆候选（走 `extractMemoryCandidates`，仍**待用户审核**）*/
      readonly candidates: readonly MemoryCandidateFromAttachment[];
    }
  | { readonly ok: false; readonly reason: string };

export interface ParseAttachmentArgs {
  readonly model: ModelPort;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly attachmentId: string;
  readonly kind: AttachmentKind;
  readonly fileName: string;
  readonly source: ParseSource;
}

function systemPrompt(): string {
  return `你在做「附件解析」：把用户给的一张图或一段文本，抽成结构化键值 + 一句摘要。

## 铁律

1. **只写真实出现的信息**。看不清、拿不准的**宁可不写**，绝不猜。
2. 不要补充"合理推断"（比如看到咖啡就写"用户喜欢咖啡"）—— 那是猜测，不是解析。
3. 金额、日期按原文写，不要换算格式。
4. 摘要只描述**这份附件是什么、关键信息是什么**，2—3 句。`;
}

function userPrompt(fileName: string): string {
  return `请解析这份附件（文件名：${fileName}），输出 fields 与 summary。`;
}

/**
 * 解析一个附件。
 *
 * ⚠️ 失败**不抛异常**，返回 `{ ok: false, reason }` ——
 *    附件解析失败是"这件事做不成"，不是程序异常；
 *    调用方要把原因如实转给用户（"这个类型的文件暂不支持"）。
 */
export async function parseAttachment(args: ParseAttachmentArgs): Promise<ParseOutcome> {
  /**
   * ★ 模型标识与能力都来自 `describe()` —— 不需要调用方另传名字。
   *   能力检查**必须在调模型之前**：实测 `deepseek-v4-pro` 收到图片**不报错**，
   *   HTTP 200，只在正文里回一句"抱歉，我无法查看这张图片"。
   */
  const desc = args.model.describe();
  const modelName = desc.model;

  // ── ① 能力与输入检查（**先查再调**，避免无声降级）──
  if (args.source.kind === 'image') {
    if (desc.capabilities.supportsVision !== true) {
      return {
        ok: false,
        reason: `当前模型（${modelName}）不支持读图，无法解析图片附件。请换支持视觉的模型。`,
      };
    }
  }

  const text = args.source.kind === 'text' ? args.source.text : '';
  if (args.source.kind === 'text' && text.trim().length === 0) {
    return { ok: false, reason: '文本附件是空的，没有可解析的内容' };
  }
  const inlineText =
    text.length > MAX_INLINE_TEXT_CHARS ? text.slice(0, MAX_INLINE_TEXT_CHARS) : text;

  // ── ② 调模型（结构化输出；schema 校验失败由适配器重试）──
  let output: AttachmentParseOutput;
  let usage: { readonly inputTokens: number; readonly outputTokens: number };
  try {
    const result = await args.model.completeStructured({
      purpose: 'attachmentParse',
      schema: attachmentParseSchema,
      schemaName: 'AttachmentParse',
      temperature: 0.1,
      messages: [
        msg.system(systemPrompt()),
        args.source.kind === 'image'
          ? msg.userWithImages(userPrompt(args.fileName), [
              { url: args.source.url, detail: 'high' },
            ])
          : msg.user(`${userPrompt(args.fileName)}\n\n---\n${inlineText}\n---`),
      ],
    });
    output = result.value;
    usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `模型解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── ③ 组装 + 留痕 ──
  const parsed: ParsedAttachment = {
    attachmentId: args.attachmentId,
    kind: args.kind,
    fields: output.fields,
    summary: output.summary,
    model: modelName,
    usage,
  };

  args.log.append({
    type: 'attachment.parsed',
    actor: 'butler',
    payload: {
      attachmentId: args.attachmentId,
      kind: args.kind,
      fileName: args.fileName,
      // ⚠️ 只记字段个数与摘要，不记原始内容 —— 附件可能含隐私
      fieldCount: Object.keys(parsed.fields).length,
      summaryChars: parsed.summary.length,
      model: modelName,
      usage,
    },
    createdAt: args.clock.now(),
  });

  return { ok: true, parsed, candidates: extractMemoryCandidates({ parsed }) };
}

