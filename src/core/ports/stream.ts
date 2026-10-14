/**
 * 流式推理端口
 *
 * 设计依据：方案 § 13.3（字符级流式）、ADR 0004（核心层框架无关）
 *
 * ★ 为什么单独一个端口而不是给 ModelPort 加方法：
 *   流式与一次性调用是**两种消费方式**，不是同一种能力的两个开关。
 *   分开之后：
 *     · 反思、路由这类不在乎延迟的场景继续用 complete()（更简单）
 *     · 只有面向用户的推理流用 stream()
 *     · 不支持流式的模型只需不实现这个端口，不必假装支持
 *
 * ⚠️ 与 ModelPort 的 capabilities.supportsStreaming 呼应：
 *    声明不支持时，调用方应当退化为"一次性拿到全文再按句切分渲染"，
 *    而不是调用本端口然后拿到一个假的分片。
 */

import type { ModelMessage, ModelToolSpec, ModelUsage } from './model.js';

export interface StreamCall {
  readonly purpose: 'chat' | 'reasoning' | 'servant' | 'reflection';
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolSpec[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** 用于取消（用户点了"停止"、或切换了会话） */
  readonly signal?: AbortSignal;
}

/** 流式分片。 */
export type ModelStreamChunk =
  | {
      readonly kind: 'reasoning';
      readonly delta: string;
    }
  | {
      readonly kind: 'text';
      readonly delta: string;
    }
  | {
      readonly kind: 'toolCall';
      /** 工具调用可能分多次到达（参数是拼接出来的） */
      readonly callId: string;
      readonly name: string;
      readonly argsDelta: string;
    }
  | {
      readonly kind: 'done';
      readonly finishReason: 'stop' | 'length' | 'toolCalls' | 'error';
      readonly usage: ModelUsage;
      readonly model: string;
      /** 完整文本（便于调用方不必自己拼） */
      readonly fullText: string;
      /** 完整推理（若有） */
      readonly fullReasoning: string;
    };

export interface ModelStreamPort {
  /**
   * 流式生成。
   *
   * ⚠️ 实现必须保证：
   *   · `done` 分片**恰好一个**，且是最后一个
   *   · 出错时也要发 `done`（finishReason='error'），
   *     否则调用方的 for-await 会挂住
   *   · `signal` 被 abort 时尽快结束并发出 done
   */
  stream(call: StreamCall): AsyncIterable<ModelStreamChunk>;
}

/** 类型守卫：判断一个模型是否支持流式。 */
export function supportsStream(port: unknown): port is ModelStreamPort {
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof (port as { stream?: unknown }).stream === 'function'
  );
}
