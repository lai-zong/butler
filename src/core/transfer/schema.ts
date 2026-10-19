/**
 * 数据导出/导入的文档格式（v8 · 方案 §5.5）
 *
 * ★★ 一条贯穿设计的事实（见 `bootstrap.ts`）：
 *
 *   **所有状态都由事件流重建** —— 记忆、产出物、操作记忆、检查点、
 *   会话与消息、画像快照（`profile.snapshot` 事件）全都在里头。
 *   生产代码里唯一的**数据文件**就是 `events.jsonl`。
 *
 *   → 所以「导出全量数据」= **搬走唯一真相源**，
 *     不是"打包一堆文件"。导入 = 换成这份事件流并重建。
 *
 * ★ 为什么必须是**单文件 JSON**（方案 §5.5 原话）：
 *   导出文件会经过用户的手（网盘 / 聊天工具 / U 盘）。
 *   多文件包会让"漏了一个文件"变成静默的数据缺失；
 *   单文件则可以在导入时**整体校验**，不兼容就明确拒绝。
 *
 * ⚠️ 凭证默认排除（方案 §5.5）：导出文档里**没有** API 密钥。
 *    `includesCredentials` 字段显式声明这一点，导入方据此判断，
 *    而不是靠"看文档里有没有看起来像 key 的字符串"去猜。
 */

import { z } from 'zod';

/**
 * 导出文档的格式版本。
 *
 * ★ 版本号是**给未来的自己**用的：格式一改，旧文件就导不进来。
 *   所以导入时必须**精确匹配**而不是"兼容就好" ——
 *   猜错字段语义比拒绝导入危险得多。
 */
export const EXPORT_SCHEMA = 'butler-export@2';

/** 事件的最小结构校验（宽容：只要求导入后能重放的基本字段） */
const eventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  seq: z.number().int().min(1),
  type: z.string().min(1),
  actor: z.string().min(1),
  createdAt: z.number(),
  // payload 的语义由各模块负责，这里不做深校验 ——
  // 深校验会把"某个模块加字段"变成"旧导出文件导不进来"
  payload: z.unknown(),
  parentEventId: z.string().optional(),
  servantId: z.string().optional(),
});

/**
 * 导出文档。
 *
 * ⚠️ 字段顺序与注释都是**给导入方看的契约**：
 *    任何字段缺失或版本不符，导入必须**明确拒绝**，不许静默降级。
 */
export const exportDocumentSchema = z.object({
  /** 格式版本，必须精确等于 `EXPORT_SCHEMA` */
  schema: z.literal(EXPORT_SCHEMA),
  /** 导出时刻（毫秒） */
  exportedAt: z.number(),
  /** 所属用户（本地账号） */
  userId: z.string().min(1),
  /** 应用版本（便于排查"哪一版导出的"） */
  appVersion: z.string().min(1),

  /** 事件条数与上限序号 —— 便于导入时先做一眼校验 */
  counts: z.object({
    events: z.number().int().min(0),
    lastSeq: z.number().int().min(0),
  }),

  /**
   * ★ 是否包含凭证。**恒为 false** —— 导出时会自动把凭证替换成占位符。
   *
   * 与 v1 的区别：v1 是"扫到就拒绝导出"；v2 是"自动脱敏、写清单"。
   * 这样用户不会因为说过一次手机号就永远导不出备份（v1 的真实缺陷）。
   */
  includesCredentials: z.literal(false),

  /** 导出文件里是否含个人信息（手机号/身份证/银行卡）—— 保留但标记。 */
  containsPII: z.boolean(),

  /**
   * 自动脱敏清单（**不是**悄悄替换）：
   * 文件自己声明改了哪些路径、每处是什么类型，导入方/用户都能核对。
   */
  sanitization: z.object({
    policy: z.literal('auto'),
    /** 被替换的字段数（凭证 + 被移除的练习答案） */
    redacted: z.number().int().min(0),
    /** 检测到的个人信息条数（未替换） */
    pii: z.number().int().min(0),
    fields: z
      .array(
        z.object({
          path: z.string().min(1),
          kind: z.string().min(1),
        }),
      )
      .max(200),
  }),

  /** 事件流（唯一真相源）*/
  events: z.array(eventSchema),
});

/** v1（旧版本）导出文档：导入时仍然接受。 */
export const exportDocumentV1Schema = z.object({
  schema: z.literal('butler-export@1'),
  exportedAt: z.number(),
  userId: z.string().min(1),
  appVersion: z.string().min(1),
  counts: z.object({
    events: z.number().int().min(0),
    lastSeq: z.number().int().min(0),
  }),
  includesCredentials: z.literal(false),
  credentialScan: z.object({
    scannedEvents: z.number().int().min(0),
    suspicious: z.number().int().min(0),
  }),
  events: z.array(eventSchema),
});

export type ExportDocument = z.infer<typeof exportDocumentSchema>;
export type ExportDocumentV1 = z.infer<typeof exportDocumentV1Schema>;
export type ExportEvent = z.infer<typeof eventSchema>;

/** 导入判定的结果（**为什么不抛错**：调用方要把原因转成用户可读提示）*/
export type ImportRejection =
  | { readonly kind: 'not-json'; readonly detail: string }
  | { readonly kind: 'schema-mismatch'; readonly got: string; readonly want: string }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'unknown-event-type'; readonly eventType: string; readonly seq: number }
  | { readonly kind: 'seq-not-contiguous'; readonly detail: string }
  | { readonly kind: 'empty' };

export interface ImportCandidate {
  readonly doc: ExportDocument;
  /** 导入后的事件条数（= doc.events.length）*/
  readonly eventCount: number;
  /**
   * 强类型的事件数组 —— 供 `bootstrap` 直接重建。
   *
   * ★ 为什么单独给一份：导出的 JSON 里 `type` 是 `string`（格式要能表达未来类型），
   *   而重放需要 `EventType`。**校验时已确认每个 type 都已知**，
   *   所以这里给的是**经过类型守卫收窄**的结果，而不是 `as` 强转。
   */
  readonly events: readonly import('../events/types.js').SessionEvent[];
}
