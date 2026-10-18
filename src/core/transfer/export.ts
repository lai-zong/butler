/**
 * 导出（v8 · 方案 §5.5）
 *
 * ★ 纯函数：不读文件、不写文件、不碰运行时的 log 实例。
 *   调用方把事件数组传进来，拿到一个可序列化的文档。
 *   这样导出逻辑可以脱离环境单测，也不会顺手改到运行时状态。
 *
 * ⚠️ 凭证处理（方案 §5.5「凭证隔离」）：
 *   导出文件会经过用户的手，这是最常见的数据泄露路径。
 *   所以这里**先扫一遍**：任何 payload 里出现像凭证的字符串，
 *   **拒绝导出**并说明是哪条事件 —— 而不是悄悄写进文件、
 *   也不是悄悄替换成 `***`（那会让导入后的数据与原文不符）。
 */

import { containsCredentials } from '../tools/redact.js';
import { EXPORT_SCHEMA, exportDocumentSchema, type ExportDocument, type ExportEvent } from './schema.js';
import type { SessionEvent } from '../events/types.js';

/**
 * 递归收集一个值里所有"像凭证"的字符串。
 *
 * ⚠️ 只在导出时跑一次，所以用简单递归就够了 ——
 *    不需要为它做流式或剪枝。
 */
function findSuspicious(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'string') {
    if (containsCredentials(value)) out.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findSuspicious(v, `${path}[${i}]`, out));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      findSuspicious(v, `${path}.${k}`, out);
    }
  }
}

/** 导出失败的原因（调用方转成用户可读提示）*/
export type ExportRejection =
  | { readonly kind: 'credentials-found'; readonly where: readonly string[] };

export interface ExportResult {
  /** 成功时给文档；失败时给原因 */
  readonly doc?: ExportDocument;
  readonly rejection?: ExportRejection;
  /** 扫描到的事件条数（无论成败都给，便于排查）*/
  readonly scanned: number;
}

export interface BuildExportArgs {
  readonly events: readonly SessionEvent[];
  readonly userId: string;
  readonly appVersion: string;
  readonly now: number;
}

/**
 * 构建导出文档。
 *
 * ⚠️ 失败**不抛异常**：返回 `rejection`，由 API 层转成 400 + 明确原因。
 *    导出失败是"用户要求的事做不了"，不是程序异常。
 */
export function buildExport(args: BuildExportArgs): ExportResult {
  const suspicious: string[] = [];

  const events: ExportEvent[] = [];
  for (const e of args.events) {
    findSuspicious(e.payload, `${e.type}#seq${e.seq}`, suspicious);
    events.push({
      id: e.id,
      sessionId: e.sessionId,
      seq: e.seq,
      type: e.type,
      actor: e.actor,
      createdAt: e.createdAt,
      payload: e.payload,
      ...(e.parentEventId !== undefined ? { parentEventId: e.parentEventId } : {}),
      ...(e.servantId !== undefined ? { servantId: e.servantId } : {}),
    });
  }

  if (suspicious.length > 0) {
    return {
      rejection: { kind: 'credentials-found', where: suspicious },
      scanned: args.events.length,
    };
  }

  const lastSeq = events.reduce((max, e) => Math.max(max, e.seq), 0);

  const doc = exportDocumentSchema.parse({
    schema: EXPORT_SCHEMA,
    exportedAt: args.now,
    userId: args.userId,
    appVersion: args.appVersion,
    counts: { events: events.length, lastSeq },
    includesCredentials: false,
    credentialScan: { scannedEvents: events.length, suspicious: 0 },
    events,
  });

  return { doc, scanned: args.events.length };
}
