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

export type ModelPart = ModelTextPart | ModelToolCallPart | ModelToolResultPart;

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
}

/**
 * 调用用途 —— 用于成本归因与模型分级。
 *
 * 方案 § 14「成本控制」要求"路由用小模型"，靠这个字段分流。
 */
export type ModelPurpose =
  | 'routing' // 意图识别与路由 —— 便宜模型即可
  | 'planning' // 任务分解
  | 'servant' // 仆人执行
  | 'reflection' // 反思
  | 'memoryExtraction' // 记忆提取
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

  /** 供日志与审计记录 —— 便于复现（方案 § 5.2 可复现信息） */
  describe(): { readonly provider: string; readonly model: string };
}
