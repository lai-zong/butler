/**
 * DeepSeek 流式适配器 —— 把 SSE 分片转成我们的流式分片
 *
 * 设计依据：方案 § 13.3（字符级流式 + 增量翻译）、官方 Chat Completions 文档
 *
 * ★ 关键点（来自官方文档的实测与阅读）：
 *   ① `stream: true` 时返回 **data-only SSE**，以 `data: [DONE]` 终止
 *   ② 思考内容在 `delta.reasoning_content`，正式回答在 `delta.content`
 *      —— **两者分开**，这正是"翻译英文思考"能成立的前提
 *   ③ `stream_options.include_usage` 打开后，**最后一个内容分片**带 usage
 *      （文档明确说：不会单独发一个 usage-only 分片）
 *   ④ 必须处理 `finish_reason === 'length'` —— 被截断的输出不能被当成完整结果
 *
 * ⚠️ 本文件是唯一碰 fetch/SSE 的地方（ADR 0004）。
 */

import { ModelError } from '../../core/ports/model.js';
import type { ModelUsage } from '../../core/ports/model.js';
import type { ModelStreamChunk, ModelStreamPort, StreamCall } from '../../core/ports/stream.js';
import type { DeepSeekConfig } from './deepseek.js';
import { capabilitiesOf } from './deepseek.js';
import { toApiMessages } from './convert.js';

/** 官方文档给的 finish_reason 取值。 */
type ApiFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'insufficient_system_resource'
  | 'aborted';

interface StreamDelta {
  readonly role?: string;
  readonly content?: string | null;
  readonly reasoning_content?: string | null;
  readonly tool_calls?: readonly {
    readonly index?: number;
    readonly id?: string;
    readonly type?: string;
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }[];
}

interface StreamChunk {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly {
    readonly index?: number;
    readonly delta?: StreamDelta;
    readonly finish_reason?: ApiFinishReason | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  } | null;
  readonly error?: { readonly message?: string };
}

/**
 * 把官方 finish_reason 映射到我们的取值。
 *
 * ⚠️ `content_filter` / `insufficient_system_resource` / `aborted`
 *    都不是"正常结束"，映射成 error —— 让调用方知道要重试或降级，
 *    而不是把半截内容当成完整结果。
 */
export function mapFinishReason(r: ApiFinishReason | null | undefined): 'stop' | 'length' | 'toolCalls' | 'error' {
  switch (r) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'toolCalls';
    case 'length':
      return 'length';
    default:
      return 'error';
  }
}

/**
 * 增量 SSE 解析器。
 *
 * ⚠️ 必须按**行**累积处理：一次网络分片可能含半行，也可能含多行。
 *    直接把每个 chunk 当完整 SSE 事件解析是最常见的错。
 */
export function createSseParser(): (chunk: string) => readonly string[] {
  let buffer = '';
  return (chunk: string): readonly string[] => {
    buffer += chunk;
    const out: string[] = [];

    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);

      // SSE 的注释行与空行跳过；只关心 data:
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload.length > 0) out.push(payload);
      }
      idx = buffer.indexOf('\n');
    }

    return out;
  };
}

export class DeepSeekStream implements ModelStreamPort {
  constructor(private readonly config: DeepSeekConfig) {}

  /**
   * 流式生成。
   *
   * ⚠️ 保证：`done` 分片恰好一个且是最后一个（即使是错误路径）。
   *    否则调用方的 for-await 会挂住等一个永远不来的 done。
   */
  async *stream(call: StreamCall): AsyncIterable<ModelStreamChunk> {
    const model = this.config.model ?? 'deepseek-chat';
    const caps = capabilitiesOf(model);

    // 模型不支持流式时**如实报错**，而不是假装流式（把全文一次吐出）
    if (!caps.supportsStreaming) {
      throw new ModelError(`模型 ${model} 未声明支持流式输出`, 'BAD_OUTPUT');
    }

    /**
     * ★ index → 该调用的真实 id。
     *
     * ⚠️ 必须在整个流上记住：`id` **只在一次调用的第一个分片出现**，
     *    后续分片没有 id。若不记住，就只能给兜底名，
     *    于是同一个调用会有两个 callId（第 1 片真 id、后续片兜底名）。
     */
    const streamCallIds = new Map<number, string>();

    const body: Record<string, unknown> = {
      model,
      // ⚠️ 用共享转换（convert.ts）而不是本文件自己的实现 ——
      //    原先那份**只处理 text 与 image**，会把 toolCall 与 toolResult
      //    静默丢掉。工具循环一旦走流式就会坏（模型收不到工具结果，
      //    于是反复调同一个工具直到轮次耗尽）。
      messages: toApiMessages(call.messages),
      stream: true,
      // 文档：打开后最后一个内容分片会带 usage
      stream_options: { include_usage: true },
      ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
      ...(call.maxOutputTokens !== undefined ? { max_tokens: call.maxOutputTokens } : {}),
      ...(call.tools !== undefined && call.tools.length > 0
        ? {
            tools: call.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    };

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    call.signal?.addEventListener('abort', onAbort);

    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl ?? 'https://api.deepseek.com'}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      call.signal?.removeEventListener('abort', onAbort);
      const aborted = call.signal?.aborted === true;
      yield {
        kind: 'done',
        finishReason: 'error',
        usage: { inputTokens: 0, outputTokens: 0 },
        model,
        fullText: '',
        fullReasoning: '',
      };
      if (aborted) return;
      throw new ModelError(
        `流式请求失败：${err instanceof Error ? err.message : String(err)}`,
        'NETWORK',
      );
    }

    if (!res.ok || res.body === null) {
      const text = await res.text().catch(() => '');
      call.signal?.removeEventListener('abort', onAbort);
      yield {
        kind: 'done',
        finishReason: 'error',
        usage: { inputTokens: 0, outputTokens: 0 },
        model,
        fullText: '',
        fullReasoning: '',
      };
      throw new ModelError(`流式请求返回 HTTP ${res.status}：${text.slice(0, 300)}`, 'NETWORK');
    }

    let fullText = '';
    let fullReasoning = '';
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    let finish: 'stop' | 'length' | 'toolCalls' | 'error' = 'error';
    let sawDone = false;

    const parse = createSseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const payload of parse(decoder.decode(value, { stream: true }))) {
          if (payload === '[DONE]') {
            sawDone = true;
            continue;
          }

          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(payload) as StreamChunk;
          } catch {
            // 解析不了的分片跳过，不中断整条流
            continue;
          }

          if (chunk.error !== undefined) {
            finish = 'error';
            continue;
          }

          // 文档：最后一个内容分片带 usage
          if (chunk.usage != null) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }

          const choice = chunk.choices?.[0];
          if (choice === undefined) continue;

          const delta = choice.delta;
          if (delta?.reasoning_content != null && delta.reasoning_content.length > 0) {
            fullReasoning += delta.reasoning_content;
            yield { kind: 'reasoning', delta: delta.reasoning_content };
          }
          if (delta?.content != null && delta.content.length > 0) {
            fullText += delta.content;
            yield { kind: 'text', delta: delta.content };
          }
          for (const tc of delta?.tool_calls ?? []) {
            /**
             * ★★ 两个**实测得出的**协议细节，都必须处理：
             *
             *   ① `index` 每个分片都带 —— 它是唯一稳定的聚合键，必须透传。
             *   ② `id` 只在第一个分片出现 —— 所以要按 index 记住它，
             *      后续分片沿用它。
             *
             *   ⚠️ 原先写的是 `tc.id ?? \`call_${index}\``：同一个调用会
             *      拿到两个不同的 callId（第 1 片真 id、后续片兜底名）。
             *      按 callId 聚合时一次调用被拆成两个 ——
             *      一个只有名字没参数、一个只有参数没名字，
             *      **两者都通不过参数校验**。
             *      症状是「工具调用参数全空、模型反复重试到轮次耗尽」，
             *      而从现象几乎推不回这个原因。
             */
            const index = tc.index ?? 0;
            if (tc.id != null && tc.id.length > 0) {
              streamCallIds.set(index, tc.id);
            }
            const callId = streamCallIds.get(index) ?? `call_${String(index)}`;

            yield {
              kind: 'toolCall',
              index,
              callId,
              name: tc.function?.name ?? '',
              argsDelta: tc.function?.arguments ?? '',
            };
          }

          if (choice.finish_reason != null) {
            finish = mapFinishReason(choice.finish_reason);
          }
        }
      }
    } catch (err) {
      finish = 'error';
      // ⚠️ 这里**不抛** —— 先让 done 分片发出去，
      //    否则调用方拿不到已生成内容（方案 § 13.4：流式中断不丢已生成内容）
      yield {
        kind: 'done',
        finishReason: 'error',
        usage,
        model,
        fullText,
        fullReasoning,
      };
      void err;
      call.signal?.removeEventListener('abort', onAbort);
      return;
    } finally {
      call.signal?.removeEventListener('abort', onAbort);
      reader.releaseLock?.();
    }

    if (!sawDone && finish === 'error') {
      // 流没正常收尾且没有 finish_reason —— 视为中断
      finish = 'error';
    }

    yield {
      kind: 'done',
      finishReason: finish,
      usage,
      model,
      fullText,
      fullReasoning,
    };
  }
}
