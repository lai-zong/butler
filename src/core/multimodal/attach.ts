/**
 * 多模态输入 —— 数据模型与分类路由
 *
 * 设计依据：方案 § 5.3（多模态处理流程）
 *
 * ★ 方案给的处理流程：
 *     用户上传图片/文件
 *        ↓ 管家初判类型（收据 / 截图 / 文档 / 表格 / 代码 / 语音）
 *        ↓ 路由决策：需要哪个仆人处理？
 *        │   ├─ 收据账单 → 健康仆人
 *        │   ├─ 代码截图 → 代码仆人
 *        │   ├─ 文档资料 → 学习 / 办公仆人
 *        │   ├─ 语音指令 → 管家（转写后进入正常流程）
 *        │   └─ 不确定   → 反问用户
 *        ↓ 仆人解析 → 结构化结果进入任务上下文
 *
 * ★ 关键增分点（方案原文）：**多模态信息进记忆**
 *     收据截图 → OCR → 发现「常购品牌 A」→ 生成记忆候选
 *   这条把"看图"从一次性能力变成了**会沉淀的经验** ——
 *   与整个项目的记忆治理主线接上，是本模块真正的价值点。
 *
 * ⚠️ 诚实边界：本模块**不做 OCR 本身**。
 *    识别交给模型（走 ModelPort 的图片能力），
 *    本模块负责的是**分类、路由、把结果变成记忆候选**。
 */

import type { DomainId } from '../execution/types.js';

// ═══════════════════════════════════════════════════════════
// 附件
// ═══════════════════════════════════════════════════════════

/**
 * 附件的种类。
 *
 * 与方案 § 5.3 的初判类型一一对应。
 */
export type AttachmentKind =
  | 'receipt' // 收据账单 → 健康（消费与饮食）
  | 'screenshot' // 截图 → 按内容路由
  | 'document' // 文档资料 → 学习 / 办公
  | 'spreadsheet' // 表格 → 办公
  | 'code' // 代码截图/文件 → 代码
  | 'image' // 普通图片 → 待判断
  | 'audio' // 语音 → 管家（转写）
  | 'unknown'; // 不确定 → 反问用户

export const KIND_LABEL: Record<AttachmentKind, string> = {
  receipt: '收据账单',
  screenshot: '截图',
  document: '文档资料',
  spreadsheet: '表格',
  code: '代码',
  image: '图片',
  audio: '语音',
  unknown: '未知类型',
};

/** 附件引用（不携带内容本身 —— 内容存在产出物或临时区）。 */
export interface Attachment {
  readonly id: string;
  readonly userId: string;
  /** 原始文件名（仅用于展示与初判，**不作为内容解释依据**）*/
  readonly filename: string;
  /** 声明的内容类型（可能不准 —— 官方文档明确说按文件内容识别）*/
  readonly declaredMime: string;
  readonly sizeBytes: number;
  /** 已识别的真实内容类型 */
  readonly detectedMime?: string;
  readonly kind: AttachmentKind;
  /** data: URL 或 http(s) 链接（供模型输入）*/
  readonly url?: string;
  readonly receivedAt: number;
}

// ═══════════════════════════════════════════════════════════
// 内容类型识别（按**文件内容**，不按扩展名）
// ═══════════════════════════════════════════════════════════

/**
 * 支持的图片格式。**与官方文档一致**：
 * JPEG / PNG / GIF / WebP，且按文件内容识别。
 *
 * ⚠️ 为什么不按扩展名：实测中一张 8×8 的无效 PNG
 *    （扩展名对、MIME 声明对、但内容不完整）
 *    被 API 以 "unsupported image" 拒绝。
 *    **扩展名会撒谎，魔数不会。**
 */
const MAGIC: readonly { readonly mime: string; readonly bytes: readonly number[]; readonly kind: AttachmentKind }[] = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], kind: 'image' },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff], kind: 'image' },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38], kind: 'image' },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], kind: 'image' },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46], kind: 'document' },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04], kind: 'unknown' },
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33], kind: 'audio' },
  { mime: 'audio/wav', bytes: [0x52, 0x49, 0x46, 0x46], kind: 'audio' },
];

/** 模型能直接读的图片格式（其余要转换或拒绝）。 */
export const VISION_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * 按**字节内容**识别类型。
 *
 * ⚠️ webp 与 wav 都以 `RIFF` 开头，需要再看偏移 8 的标记。
 */
export function detectMime(bytes: Uint8Array): string | null {
  for (const m of MAGIC) {
    if (m.bytes.every((b, i) => bytes[i] === b)) {
      // RIFF 需要进一步区分 webp / wav
      if (m.mime === 'image/webp' || m.mime === 'audio/wav') {
        const tag = String.fromCharCode(...bytes.subarray(8, 12));
        if (tag === 'WEBP') return 'image/webp';
        if (tag === 'WAVE') return 'audio/wav';
        continue;
      }
      return m.mime;
    }
  }
  // 文本类：看是否为可打印 UTF-8
  if (looksLikeText(bytes)) return 'text/plain';
  return null;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(512, bytes.length));
  if (sample.length === 0) return false;
  let printable = 0;
  for (const b of sample) {
    // 允许 \t \n \r 与可打印 ASCII；高于 0x7f 视为可能是 UTF-8 多字节
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 0x80) printable += 1;
  }
  return printable / sample.length > 0.9;
}

/** 该格式能否直接喂给模型。 */
export function isVisionReadable(mime: string | null): boolean {
  return mime !== null && VISION_MIMES.includes(mime);
}

// ═══════════════════════════════════════════════════════════
// 分类：文件名提示 + 内容类型
// ═══════════════════════════════════════════════════════════

/**
 * 文件名里的线索词。
 *
 * ⚠️ 文件名只用于**初判**，不作为内容解释依据 ——
 *    用户可以把收据命名为 `a.png`，也可以把截图命名为 `收据.png`。
 *    所以分类是"提示 + 内容"共同决定，且不确定时**反问用户**。
 */
const NAME_HINTS: readonly { readonly re: RegExp; readonly kind: AttachmentKind }[] = [
  { re: /receipt|发票|收据|账单|小票|invoice/i, kind: 'receipt' },
  { re: /screenshot|截图|屏幕|screen[_-]?shot|捕获/i, kind: 'screenshot' },
  { re: /\.(csv|xlsx?|ods)$/i, kind: 'spreadsheet' },
  { re: /\.(ts|tsx|js|jsx|py|java|go|rs|c|cpp|h|sql|sh|ps1)$/i, kind: 'code' },
  { re: /\.(pdf|docx?|md|txt|rtf|odt)$/i, kind: 'document' },
  { re: /\.(mp3|wav|m4a|flac|ogg|opus)$/i, kind: 'audio' },
];

export interface ClassifyInput {
  readonly filename: string;
  readonly declaredMime: string;
  readonly sizeBytes: number;
  /** 前若干字节（用于魔数识别）；拿不到时传空数组 */
  readonly headBytes?: Uint8Array;
}

export interface ClassifyResult {
  readonly kind: AttachmentKind;
  readonly detectedMime: string | null;
  /** 分类依据（供界面展示与用户纠正）*/
  readonly why: string;
  /** 是否需要反问用户（分类不确定）*/
  readonly needsUserConfirmation: boolean;
}

/**
 * 初判附件类型。
 *
 * ★ 不确定时**如实说不确定**并请求用户确认 ——
 *   方案明确写了"不确定 → 反问用户"。
 *   猜错类型会让任务派给错误的仆人，代价比多问一句大。
 */
export function classifyAttachment(input: ClassifyInput): ClassifyResult {
  const detected = input.headBytes ? detectMime(input.headBytes) : null;
  const lowerName = input.filename.toLowerCase();

  // ① 内容优先：能识别出真实类型时以它为准
  if (detected !== null) {
    // 具体是"截图"还是"收据"要靠文件名提示区分（内容层面都是 png）
    if (detected.startsWith('image/')) {
      const byName = NAME_HINTS.find((h) => h.re.test(lowerName));
      if (byName && (byName.kind === 'receipt' || byName.kind === 'screenshot' || byName.kind === 'code')) {
        return {
          kind: byName.kind,
          detectedMime: detected,
          why: `内容为 ${detected}，文件名提示为「${KIND_LABEL[byName.kind]}」`,
          needsUserConfirmation: false,
        };
      }
      return {
        kind: 'image',
        detectedMime: detected,
        why: `按内容识别为 ${detected}，但图片用途需进一步判断`,
        // ★ 图片可能是收据/截图/代码，用途不明 → 交给模型或用户判断
        needsUserConfirmation: true,
      };
    }

    if (detected === 'application/pdf') {
      return {
        kind: 'document',
        detectedMime: detected,
        why: '按内容识别为 PDF 文档',
        needsUserConfirmation: false,
      };
    }

    if (detected.startsWith('audio/')) {
      return {
        kind: 'audio',
        detectedMime: detected,
        why: `按内容识别为 ${detected} 音频`,
        needsUserConfirmation: false,
      };
    }

    if (detected === 'text/plain') {
      const byName = NAME_HINTS.find((h) => h.re.test(lowerName));
      return {
        kind: byName?.kind ?? 'document',
        detectedMime: detected,
        why: byName
          ? `纯文本，文件名提示为「${KIND_LABEL[byName.kind]}」`
          : '纯文本文件',
        needsUserConfirmation: false,
      };
    }

    return {
      kind: 'unknown',
      detectedMime: detected,
      why: `识别到 ${detected}，但本系统暂不支持该类型`,
      needsUserConfirmation: true,
    };
  }

  // ② 内容认不出 → 退回文件名提示
  const byName = NAME_HINTS.find((h) => h.re.test(lowerName));
  if (byName) {
    return {
      kind: byName.kind,
      detectedMime: null,
      why: `无法按内容识别，依据文件名判定为「${KIND_LABEL[byName.kind]}」（仅供参考）`,
      needsUserConfirmation: true,
    };
  }

  return {
    kind: 'unknown',
    detectedMime: null,
    why: '既无法按内容识别，文件名也没有线索',
    needsUserConfirmation: true,
  };
}

// ═══════════════════════════════════════════════════════════
// 归类：这份附件属于哪个领域
// ═══════════════════════════════════════════════════════════

export interface RouteDecision {
  /**
   * 目标领域；`null` 表示类型不确定、需要先反问用户。
   *
   * ★★ v8（批次G）：字段名从 `servant` 改为 `domain` ——
   *    它装的一直是**领域值**（`'health'` 等），叫 servant 会让读者
   *    以为"附件会被派给某个仆人"。当前架构里没有派发。
   *
   * ⚠️ `'butler'` 这个取值保留：语音先由管家转写，不属于任何领域。
   */
  readonly domain: DomainId | 'butler' | null;
  readonly why: string;
  /** 需要用户确认时才有的反问文本 */
  readonly question?: string;
}

/**
 * 依据附件类型决定交给谁。
 *
 * ⚠️ 这里的映射直接来自方案 § 5.3 的流程图，不是我另起的判据。
 */
export function routeAttachment(args: {
  readonly kind: AttachmentKind;
  readonly needsUserConfirmation: boolean;
}): RouteDecision {
  if (args.needsUserConfirmation) {
    return {
      domain: null,
      why: '类型不确定',
      question:
        `这份「${KIND_LABEL[args.kind]}」是做什么用的？` +
        '（例如：记账用的收据 / 待整理的资料 / 需要改的代码 / 其他）',
    };
  }

  switch (args.kind) {
    case 'receipt':
      return {
        domain: 'health',
        why: '收据账单涉及消费与饮食，归入健康领域（方案 § 5.3 的映射）',
      };
    case 'code':
      return { domain: 'code', why: '代码相关，归入代码领域' };
    case 'spreadsheet':
      return { domain: 'work', why: '表格处理，归入办公领域' };
    case 'document':
      return { domain: 'work', why: '文档资料，归入办公领域（学习类可由用户改派）' };
    case 'audio':
      return {
        domain: 'butler',
        why: '语音先由管家转写，转写文本再进入正常处理流程',
      };
    case 'screenshot':
      return {
        domain: null,
        why: '截图内容未知，需先解析后才能判断归属',
        question: '这张截图是要我做什么？（例如：照着改代码 / 提取里面的信息 / 其他）',
      };
    case 'image':
      return {
        domain: null,
        why: '普通图片用途不明',
        question: '这张图片是想让我做什么？',
      };
    case 'unknown':
      return {
        domain: null,
        why: '未知类型',
        question: '这个文件是要我做什么？',
      };
  }
}

// ═══════════════════════════════════════════════════════════
// 从多模态解析结果生成记忆候选（★ 关键增分点）
// ═══════════════════════════════════════════════════════════

/**
 * 解析结果的统一形状。
 *
 * ⚠️ 模型返回的结构不可控，所以解析后要经过归一化才能进记忆候选。
 */
export interface ParsedAttachment {
  readonly attachmentId: string;
  readonly kind: AttachmentKind;
  /** 结构化抽取结果（键值对，如 { 总价: '58.00', 日期: '2026-10-13' }）*/
  readonly fields: Readonly<Record<string, string>>;
  /** 自由文本摘要 */
  readonly summary: string;
  /** 参与解析的模型 */
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** 从解析结果里提炼的记忆候选（与反思产出的候选同构）。 */
export interface MemoryCandidateFromAttachment {
  readonly kind: 'fact' | 'preference';
  readonly content: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly rationale: string;
}

/**
 * 哪些字段值得进记忆。
 *
 * ★ 这是"多模态信息进记忆"的判据，也是**隐私边界**：
 *   不是解析出什么就记什么 —— 收据上的金额、商家可以记（有复用价值），
 *   但一次性的事务性信息不必记。
 *
 * ⚠️ 默认置信度偏低（0.5）：从一张图推断出的偏好，
 *    证据强度明显弱于用户直接说的话。这正是方案 § 8 的"证据强度"维度。
 */
const MEMORY_WORTHY: readonly {
  readonly field: RegExp;
  readonly kind: 'fact' | 'preference';
  readonly make: (value: string) => string;
  readonly confidence: number;
}[] = [
  { field: /品牌|商家|店铺|brand|merchant/i, kind: 'preference', make: (v) => `常购品牌：${v}`, confidence: 0.5 },
  { field: /品类|分类|category/i, kind: 'preference', make: (v) => `常购买品类：${v}`, confidence: 0.45 },
  { field: /金额|总价|total|amount/i, kind: 'fact', make: (v) => `一次消费金额 ${v}`, confidence: 0.6 },
  { field: /日期|时间|date/i, kind: 'fact', make: (v) => `消费发生在 ${v}`, confidence: 0.6 },
];

export function extractMemoryCandidates(args: {
  readonly parsed: ParsedAttachment;
}): readonly MemoryCandidateFromAttachment[] {
  const out: MemoryCandidateFromAttachment[] = [];

  for (const [key, value] of Object.entries(args.parsed.fields)) {
    const v = value.trim();
    if (v.length === 0 || v.length > 60) continue;
    const rule = MEMORY_WORTHY.find((r) => r.field.test(key));
    if (!rule) continue;
    out.push({
      kind: rule.kind,
      content: rule.make(v),
      confidence: rule.confidence,
      evidence: [`attachment:${args.parsed.attachmentId}`, `field:${key}`],
      rationale: `从「${KIND_LABEL[args.parsed.kind]}」中解析出的字段「${key}」。` +
        '**推断证据弱于用户直接陈述**，故置信度偏低，需用户确认后才生效。',
    });
  }

  return out;
}

// ═══════════════════════════════════════════════════════════
// 上限（防御性）
// ═══════════════════════════════════════════════════════════

/** 单图上限（官方文档：base64 / 外部 URL 为 32 MiB）。 */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** 单次请求体上限（官方文档：48 MiB）—— 内联 base64 会膨胀约 4/3。 */
export const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
/** 一次能附几个文件（官方上限 600，这里取一个克制值）。 */
export const MAX_ATTACHMENTS = 10;

export interface AttachmentLimitCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/** 检查附件是否超限。 */
export function checkLimits(attachments: readonly { readonly sizeBytes: number }[]): AttachmentLimitCheck {
  if (attachments.length > MAX_ATTACHMENTS) {
    return { ok: false, reason: `一次最多附 ${MAX_ATTACHMENTS} 个文件` };
  }
  let total = 0;
  for (const a of attachments) {
    if (a.sizeBytes > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: `单个文件超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB 上限`,
      };
    }
    // base64 内联会膨胀约 4/3
    total += Math.ceil(a.sizeBytes * (4 / 3));
  }
  if (total > MAX_REQUEST_BYTES) {
    return {
      ok: false,
      reason: `附件总量过大（内联后约 ${Math.round(total / 1024 / 1024)} MiB，上限 ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MiB）`,
    };
  }
  return { ok: true };
}
