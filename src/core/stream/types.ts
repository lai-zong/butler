/**
 * 流式推理与增量翻译 —— 数据模型
 *
 * 设计依据：方案 § 13.3（流式呈现规范）、§ 12 评分表
 *          （"大模型集成质量 8%" 明确点名 **英文思考按句边界增量翻译**）
 *
 * ★ 方案对"增量"的定义非常具体，这是本模块存在的理由：
 *
 *   | ❌ | 等英文完整生成 → 整段翻译 → 渲染 | **这不叫流式** |
 *   | ✅ | **按句边界切分，第一句到边界即开始翻译** | 中文与英文同步增长 |
 *
 *   ⚠️ 注意最后一句："中文与英文**同步增长**"——
 *      这意味着翻译必须**边收边译**，而不是收完再译。
 *      整段翻译即使渲染时逐字显示，也是假的流式。
 *
 * ⚠️ 分层：本文件与 `translate.ts` 是**纯逻辑**（可确定性测试）；
 *    真实模型的流式实现在 adapters/model/。
 */

// ═══════════════════════════════════════════════════════════
// 流式分片
// ═══════════════════════════════════════════════════════════

/**
 * 流式分片的种类。
 *
 * ★ `reasoning` 与 `text` 分开是关键：
 *   模型的"思考过程"与"正式回答"是两种东西。
 *   原始功能里说的"翻译英文思考"针对的是 **reasoning**，
 *   而不是回答本身 —— 回答本来就该是用户的语言。
 *
 *   实测依据：`deepseek-flash` 把推理放在单独的 `reasoning_content` 字段里
 *   （能力表里的 supportsThinking 就是为此声明的）。
 *   有些模型则把推理混在正文里，那种情况下没有 reasoning 分片。
 */
export type StreamPartKind = 'reasoning' | 'text';

export interface StreamDelta {
  readonly kind: StreamPartKind;
  /** 本次增量 */
  readonly delta: string;
  /** 累计到目前的全文（便于渲染方直接用） */
  readonly accumulated: string;
}

/** 流结束时的总结。 */
export interface StreamFinish {
  readonly kind: StreamPartKind;
  readonly full: string;
  readonly finishReason: 'stop' | 'length' | 'error';
  /** 分片数（用于评估流式是否真的在流） */
  readonly chunks: number;
  /** 首次分片到结束的耗时（毫秒） */
  readonly durationMs: number;
  /** 首字延迟 —— 流式体验的关键指标 */
  readonly firstChunkMs: number;
}

// ═══════════════════════════════════════════════════════════
// 句边界切分
// ═══════════════════════════════════════════════════════════

/**
 * 句末标点。
 *
 * ⚠️ 英文的 `.` 要特别小心：小数（`3.14`）、缩写（`e.g.`）、
 *    省略号（`...`）都不是句末。用"后面跟空白或结束"来约束。
 */
const SENTENCE_END = /[.!?;:。！？；：]/;

/** 无标点时的强制切分长度（方案：约 40—60 字符）。 */
export const FORCE_SPLIT_CHARS = 50;

/** 强制切分前至少要有这么多字符，避免碎片太多。 */
export const MIN_FORCE_SPLIT = 40;

export interface SentenceSegmenter {
  /** 喂入增量，返回**本次新增的完整句子**（可能为空数组） */
  push(delta: string): readonly string[];
  /** 流结束时取出残余（不成句的部分） */
  flush(): string;
  /** 已累积但尚未成句的内容 */
  pending(): string;
}

/**
 * 按句边界切分流式文本。
 *
 * ★ 这是"增量翻译"的核心：只有切出完整句子才能开始译，
 *   否则会译出半句话再返工。
 *
 * 两个切分依据（方案明确要求）：
 *   ① 句末标点
 *   ② 无标点时按约 40—60 字符强制切分
 *      —— 否则一段没有标点的长文本会把翻译一直卡住
 */
export function createSegmenter(opts?: {
  readonly forceSplitChars?: number;
  readonly minForceSplit?: number;
}): SentenceSegmenter {
  const forceAt = opts?.forceSplitChars ?? FORCE_SPLIT_CHARS;
  const minForce = opts?.minForceSplit ?? MIN_FORCE_SPLIT;

  let buffer = '';

  return {
    push(delta: string): readonly string[] {
      if (delta.length === 0) return [];
      buffer += delta;

      const out: string[] = [];
      let consumed = 0;

      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === undefined || !SENTENCE_END.test(ch)) continue;

        // ⚠️ 英文句点的排除规则
        if (ch === '.') {
          const prev = buffer[i - 1];
          const next = buffer[i + 1];
          // 省略号：前一个或后一个还是点
          if (prev === '.' || next === '.') continue;
          // 小数：前后都是数字
          if (prev !== undefined && next !== undefined && /\d/.test(prev) && /\d/.test(next)) continue;
          // 还没到流末尾时，句点后必须是空白/换行才算句末
          // （`e.g. ` 会误判，但那种情况下句子很短，代价可接受）
          if (next !== undefined && !/\s/.test(next)) continue;
        }

        const sentence = buffer.slice(consumed, i + 1).trim();
        if (sentence.length > 0) out.push(sentence);
        consumed = i + 1;
      }

      // ② 强制切分：缓冲里没有句末标点但已经很长
      if (consumed === 0 && buffer.length >= forceAt) {
        // 优先在空白处切，避免切断单词
        const window = buffer.slice(0, forceAt + 20);
        const breakAt = Math.max(
          window.lastIndexOf(' '),
          window.lastIndexOf('，'),
          window.lastIndexOf(','),
        );
        const cut = breakAt >= minForce ? breakAt + 1 : forceAt;
        const piece = buffer.slice(0, cut).trim();
        if (piece.length > 0) out.push(piece);
        consumed = cut;
      }

      if (consumed > 0) buffer = buffer.slice(consumed);
      return out;
    },

    flush(): string {
      const rest = buffer.trim();
      buffer = '';
      return rest;
    },

    pending(): string {
      return buffer;
    },
  };
}
