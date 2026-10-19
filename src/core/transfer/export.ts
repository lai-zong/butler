/**
 * 导出（v8 · 方案 §5.5；v9 改为**自动脱敏**）
 *
 * ★ 纯函数：不读文件、不写文件、不碰运行时的 log 实例。
 *
 * ★★ v9 的核心变化（针对真实缺陷）：
 *
 *   旧策略是"扫到疑似凭证 → 拒绝导出"。但脱敏规则把手机号/身份证/银行卡
 *   也算作凭证，而事件流是 append-only、用户无法清理历史 ——
 *   只要说过一次手机号，导出就**永久 400**（实测确认）。
 *
 *   新策略（无需用户确认，程序自动决定）：
 *     · 真凭证（sk-/JWT/私钥/Bearer/密码键值）→ 自动替换为占位符；
 *     · 个人信息（手机号/身份证/银行卡）→ 保留，但文件标记 containsPII；
 *     · 练习答案 `answers` → 一律不导出（它不该出现在任何可读文件里）；
 *     · 所有替换写入 `sanitization.fields`，导入方可核对，不是"悄悄改"。
 */

import { containsCredential, containsPII, redactCredentials } from '../tools/redact.js';
import {
  EXPORT_SCHEMA,
  exportDocumentSchema,
  type ExportDocument,
  type ExportEvent,
} from './schema.js';
import type { SessionEvent } from '../events/types.js';

export interface BuildExportArgs {
  readonly events: readonly SessionEvent[];
  readonly userId: string;
  readonly appVersion: string;
  readonly now: number;
}

interface SanitizeField {
  readonly path: string;
  readonly kind: string;
}

interface SanitizeState {
  redacted: number;
  pii: number;
  readonly fields: SanitizeField[];
}

const MAX_FIELDS = 200;

function record(state: SanitizeState, path: string, kind: string): void {
  state.redacted += 1;
  if (state.fields.length < MAX_FIELDS) state.fields.push({ path, kind });
}

function sanitizeString(value: string, path: string, state: SanitizeState): string {
  if (containsCredential(value)) {
    record(state, path, 'credential');
    return redactCredentials(value);
  }
  if (containsPII(value)) {
    state.pii += 1;
  }
  return value;
}

function sanitizeValue(value: unknown, path: string, state: SanitizeState): unknown {
  if (typeof value === 'string') return sanitizeString(value, path, state);
  if (Array.isArray(value)) {
    return value.map((v, i) => sanitizeValue(v, `${path}[${i}]`, state));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeValue(v, `${path}.${k}`, state);
    }
    return out;
  }
  return value;
}

/**
 * 练习答案不进入导出文件。
 *
 * 已批改的答案仍在 `quiz.graded.items[].correct`（那是批改结果，不是"答案卷"）。
 * 未批改的练习导入后会缺答案 —— 批改端点会明确拒绝，界面标注"来自脱敏备份"。
 */
function stripQuizAnswers(
  payload: unknown,
  path: string,
  state: SanitizeState,
): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const rec = payload as Record<string, unknown>;
  if (!('answers' in rec)) return payload;
  const { answers: _answers, ...rest } = rec;
  record(state, `${path}.answers`, 'quiz.answers');
  return rest;
}

/**
 * 构建导出文档。
 *
 * 不再因为"数据像凭证"而拒绝 —— 那是把不可执行的清理责任丢给用户。
 */
export function buildExport(args: BuildExportArgs): ExportDocument {
  const state: SanitizeState = { redacted: 0, pii: 0, fields: [] };

  const events: ExportEvent[] = [];
  for (const e of args.events) {
    const basePath = `${e.type}#seq${e.seq}`;
    const payload =
      e.type === 'quiz.created'
        ? stripQuizAnswers(e.payload, basePath, state)
        : e.payload;
    events.push({
      id: e.id,
      sessionId: e.sessionId,
      seq: e.seq,
      type: e.type,
      actor: e.actor,
      createdAt: e.createdAt,
      payload: sanitizeValue(payload, basePath, state),
      ...(e.parentEventId !== undefined ? { parentEventId: e.parentEventId } : {}),
      ...(e.servantId !== undefined ? { servantId: e.servantId } : {}),
    });
  }

  const lastSeq = events.reduce((max, e) => Math.max(max, e.seq), 0);

  return exportDocumentSchema.parse({
    schema: EXPORT_SCHEMA,
    exportedAt: args.now,
    userId: args.userId,
    appVersion: args.appVersion,
    counts: { events: events.length, lastSeq },
    includesCredentials: false,
    containsPII: state.pii > 0,
    sanitization: {
      policy: 'auto',
      redacted: state.redacted,
      pii: state.pii,
      fields: state.fields,
    },
    events,
  });
}
