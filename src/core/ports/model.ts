/**
 * 端口 · 模型调用
 *
 * 设计依据：ADR 0004（核心层框架无关）
 *
 * 核心层需要调用大模型，但**不能知道任何厂商**。
 * 这个接口就是那条边界：core 只依赖它，真实实现放在 adapters/model/。
 *
 * ⚠️ 接口刻意不出现 "prompt" "chat completion" "token" 等厂商概念 ——
 *    它们是实现细节，不是领域概念。
 */

import type { ZodType } from 'zod';

// ═══════════════════════════════════════════════════════════
// 会话消息
// ═══════════════════════════════════════════════════════════

export interface ModelTextPart {
  readonly kind: 'text';
  readonly text: string;
}

/**
 * 图片内容块（多模态输入）。
 *
 * ★ 能力以**官方 Models & Pricing 文档**为准（2026-08 版，官方只有两个模型）：
 *   · `deepseek-flash`   ✓ 支持读图
 *   · `deepseek-v4-pro`  ✗ **Not supported**（官方明确写的）
 *
 *   ⚠️ 这里原先写着 `deepseek-chat` ✓ 与 `deepseek-v4-pro`「**静默失效**」——
 *      两处都已更正：
 *        ① `deepseek-chat` 已不在官方清单里，那条观测无法复核，已删；
 *        ② v4-pro 是**官方写了不支持**，不是"静默失效"（那是我的误读）。
 *
 *   ⚠️ 但**"把图静默忽略"这个风险依然真实**：模型不报错、不降级提示，
 *      只是把图忽略了。所以模型配置里必须声明 `supportsVision`，不能靠试。
 *
 * 官方约束（api-docs.deepseek.com/guides/vision）：
 *   · 仅支持 JPEG / PNG / GIF / WebP，且**按文件内容识别**而非扩展名
 *   · 图片只能放在 `user` 消息里，放 system/assistant 会 400
 *   · 单图 ≤ 32 MiB，请求体 ≤ 48 MiB
 *   · 图片按尺寸折算 token，单图上限 1024 token
 */
export interface ModelImagePart {
  readonly kind: 'image';
  /** data: URL（base64 内联）或可公开访问的 http(s) 链接 */
  readonly url: string;
  /** 供界面与审计显示的说明（不参与模型输入） */
  readonly alt?: string;
  /**
   * 细节级别。`low` 会缩到 512×512，更快更省；
   * 读文档/截图里的文字时应当用 `high`。
   */
  readonly detail?: 'low' | 'high' | 'original' | 'auto';
}

export interface ModelToolCallPart {
  readonly kind: 'toolCall';
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ModelToolResultPart {
  readonly kind: 'toolResult';
  readonly callId: string;
  readonly result: unknown;
  readonly isError?: boolean;
}

export type ModelPart = ModelTextPart | ModelImagePart | ModelToolCallPart | ModelToolResultPart;

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: readonly ModelPart[];
}

// 便捷构造器（避免调用方到处写对象字面量）
export const msg = {
  system: (text: string): ModelMessage => ({ role: 'system', content: [{ kind: 'text', text }] }),
  user: (text: string): ModelMessage => ({ role: 'user', content: [{ kind: 'text', text }] }),
  assistant: (text: string): ModelMessage => ({
    role: 'assistant',
    content: [{ kind: 'text', text }],
  }),
  toolResult: (callId: string, result: unknown, isError = false): ModelMessage => ({
    role: 'user',
    content: [{ kind: 'toolResult', callId, result, isError }],
  }),
  /**
   * 带图片的用户消息。
   *
   * ★ 图片**只能放 user 消息**（协议限制），所以刻意不提供 `systemWithImages`。
   * ★ 顺序：文本在前、图片在后 —— 先说要干什么，再看图。
   */
  userWithImages: (
    text: string,
    images: readonly {
      readonly url: string;
      readonly detail?: 'low' | 'high' | 'original' | 'auto';
    }[],
  ): ModelMessage => ({
    role: 'user',
    content: [
      { kind: 'text', text },
      ...images.map((img) => ({
        kind: 'image' as const,
        url: img.url,
        ...(img.detail !== undefined ? { detail: img.detail } : {}),
      })),
    ],
  }),
} as const;

// ═══════════════════════════════════════════════════════════
// 工具声明
// ═══════════════════════════════════════════════════════════

export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema 形态的参数声明 */
  readonly parameters: Readonly<Record<string, unknown>>;
}

// ═══════════════════════════════════════════════════════════
// 调用与结果
// ═══════════════════════════════════════════════════════════

export interface ModelCall {
  readonly purpose: ModelPurpose;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolSpec[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /**
   * 思考模式开关（官方 API：`{"thinking":{"type":"enabled|disabled"}}`）。
   *
   * ★★ 为什么需要这个字段 —— 一条实测到的真实故障：
   *
   *   `deepseek-flash` **默认开启思考模式**（effort=high）。
   *   而思考产生的内容**也算在 `max_tokens` 里**，于是：
   *
   *     maxOutputTokens=1024 的结构化调用 → 思考吃掉大部分预算
   *     → JSON 被截断 → 重试 3 次仍截断 → **整个任务失败**
   *
   *   实测复现：`validate:1` 在 `decompose`（1024 token）处
   *   报「结构化输出重试 3 次后仍被长度上限截断」。
   *
   * ★ 另一条官方限制：**思考模式下 `temperature` 不生效**
   *   （"setting these parameters will not trigger an error but will also have no effect"）。
   *   所以对需要稳定 JSON 的调用，开思考反而让我们精心调的 temperature 白设。
   *
   * ★ 因此按用途分开：
   *   · 结构化产出（路由/分解/提取/监督）→ `disabled`：要的是确定性的 JSON
   *   · 工具执行（servant）              → `enabled`：需要推理才能正确用工具
   *   · 叙述（narration）                → `enabled`：**我们就是要让用户看到思考**
   */
  readonly thinking?: 'enabled' | 'disabled';
  /**
   * 思考强度（官方 API：`reasoning_effort`）。默认 `high`。
   *
   * ⚠️ 官方映射：`minimal`/`low` → low · `medium`/`high` → high · `max`/`ultra` → max
   */
  readonly reasoningEffort?: 'low' | 'high' | 'max';
}

/**
 * 调用用途 —— 用于成本归因与模型分级。
 *
 * 方案 § 14「成本控制」要求"路由用小模型"，靠这个字段分流。
 */
export type ModelPurpose =
  | 'routing' // 意图识别与路由 —— 便宜模型即可
  | 'planning' // 任务分解
  | 'execution' // 管家自己执行（原 servant，v8 改名）
  | 'reflection' // 反思
  | 'memoryExtraction' // 记忆提取
  | 'attachmentParse' // 附件解析（图片/文本 → 结构化键值；E1）
  | 'compaction' // 上下文摘要压缩（把更老的历史压成摘要）
  | 'translation'; // 英文思考增量翻译

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCallPart[];
  readonly finishReason: 'stop' | 'toolCalls' | 'length' | 'error';
  readonly usage: ModelUsage;
  readonly model: string;
}

export interface StructuredCall<T> extends ModelCall {
  /** 输出必须通过此 schema 校验；失败由适配器负责重试 */
  readonly schema: ZodType<T>;
  readonly schemaName: string;
}

export interface StructuredResult<T> {
  readonly value: T;
  readonly usage: ModelUsage;
  readonly attempts: number;
}

/** 模型调用失败（超时、限流、网络、输出不合规且重试耗尽）。 */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly code: 'TIMEOUT' | 'RATE_LIMIT' | 'NETWORK' | 'BAD_OUTPUT' | 'AUTH' | 'UNKNOWN',
    readonly attempts = 1,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

// ═══════════════════════════════════════════════════════════
// 端口
// ═══════════════════════════════════════════════════════════

export interface ModelPort {
  /** 自由文本 / 工具调用 */
  complete(call: ModelCall): Promise<ModelResponse>;

  /**
   * 结构化输出：返回前先用 schema 校验。
   *
   * **这是"输出稳定可控"的实现落点**（方案 § 12 大模型集成质量 8%）：
   * 校验失败必须重试，重试次数由实现决定；不得把未校验的结果返回给 core。
   */
  completeStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>>;

  /**
   * 模型能力声明。
   *
   * ★ 为什么必须显式声明（而不是"试试看"）：
   *   实测发现 `deepseek-v4-pro` 收到图片时**不报错** ——
   *   HTTP 200，只在正文里回一句"抱歉，我无法查看这张图片"。
   *   不做能力检查的话，这个降级会无声发生：用户以为 AI 看了图，
   *   实际它把图整个忽略了，而任务照常"成功"。
   *
   *   所以要**在发请求之前**就知道能不能发图。
   */
  describe(): ModelDescription;
}

/**
 * 模型能力。
 *
 * ⚠️ 保守默认：**不知道的能力一律按不支持处理**。
 *    宁可少用一项能力，也不要让"静默失效"发生。
 */
export interface ModelCapabilities {
  /** 能否接收图片（多模态输入）*/
  readonly supportsVision: boolean;
  /** 能否做流式输出 */
  readonly supportsStreaming: boolean;
  /** 能否做工具调用 */
  readonly supportsTools: boolean;
  /**
   * 是否把"思考过程"与"正式回答"分开返回。
   *
   * 对应原始功能「翻译英文思考」：
   * 有的模型单独给一个 reasoning 字段，有的把推理混在正文里。
   * 声明出来才知道该从哪儿取。
   */
  readonly supportsThinking: boolean;
}

/** 保守默认值：不知道的能力一律按「不支持」处理。 */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = {
  supportsVision: false,
  supportsStreaming: false,
  supportsTools: false,
  supportsThinking: false,
};

/** 供日志与审计记录 —— 便于复现（方案 § 5.2 可复现信息） */
export interface ModelDescription {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
}
