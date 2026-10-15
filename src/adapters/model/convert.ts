/**
 * 消息转换 —— 我们的形状 ↔ OpenAI 兼容协议的形状
 *
 * ★★ 这个文件是被一次**真实缺陷**逼出来的：
 *
 *   `deepseek.ts` 里有一份完整的 `partToApi`（正确处理
 *   text / toolCall / toolResult 三种分片）。
 *   而 `deepseekStream.ts` 里另有一份 `toApiMessage`，
 *   **只处理 text 与 image** —— 工具调用与工具结果会被**静默丢掉**。
 *
 *   ⚠️ 为什么这个缺陷一直没暴露：
 *     流式路径此前只用于"叙述"（单轮、无工具），
 *     所以它丢掉的那两种分片从来不会出现。
 *
 *   ⚠️ 而一旦把 `agentLoop` 切到流式（那是让"工具调用可见"的前提），
 *      它就会**立刻坏掉** —— 而且症状很难懂：
 *      模型收不到工具结果，于是反复调用同一个工具，直到轮次耗尽。
 *
 * ★ 纪律：**同一个转换只写一份**。
 *   两份必然漂移，而漂移的那一份通常是"暂时没被用到"的那一份。
 */

import type { ModelMessage, ModelPart, ModelToolSpec } from '../../core/ports/model.js';

// ═══════════════════════════════════════════════════════════
// 协议形状
// ═══════════════════════════════════════════════════════════

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ApiChoice {
  message: {
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: string;
}

export interface ApiResponse {
  choices?: ApiChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message?: string; type?: string };
}

// ═══════════════════════════════════════════════════════════
// 转换
// ═══════════════════════════════════════════════════════════

/**
 * 一条我们的消息 → 一到多条 API 消息。
 *
 * ★ 为什么是「一到多」：
 *   `toolResult` 在 OpenAI 协议里是**独立的 `role: 'tool'` 消息**，
 *   而不是 assistant 消息里的一个分片。
 *   所以一条含工具结果的消息要拆成两条 API 消息。
 *
 * ⚠️ 顺序有意义：assistant（含 tool_calls）必须**先于**它的 tool 结果，
 *    否则部分实现会报「tool_call_id 找不到对应调用」。
 *
 * ⚠️⚠️ **当前不处理图片**（`ModelImagePart`）。
 *    这是从原实现照搬的现状，不是这一版引入的缺陷 ——
 *    但它是一个**已知缺口**，必须写在这里，否则会被当成"已经支持"：
 *
 *      实测核查（全仓库搜索构造 `kind: 'image'` 消息的地方）→ **0 处**。
 *      也就是说：`attach.ts` 能识别图片 MIME 类型，能力表也声明
 *      `supportsVision: true`，但**没有任何代码路径把图片送进模型**。
 *
 *    「能读图」这个结论来自我当初用原始 HTTP 手工发过一次图，
 *    而**不是**这个适配器具备的能力。
 *
 *    补它需要：① 这里加 image 分支 ② `attach.ts` 的产出接到消息构造处
 *    ③ 一条真实图片的端到端验证。**属于未完成项。**
 */
export function partToApi(msg: ModelMessage): ApiMessage[] {
  const texts: string[] = [];
  const toolCalls: NonNullable<ApiMessage['tool_calls']> = [];
  const toolResults: ApiMessage[] = [];

  for (const p of msg.content as readonly ModelPart[]) {
    switch (p.kind) {
      case 'text':
        texts.push(p.text);
        break;
      case 'image':
        // 见上方说明：当前不发送图片，静默忽略会掩盖缺口 —— 这里留一行
        // 明确的落点，补的时候不会被忘记。
        break;
      case 'toolCall':
        toolCalls.push({
          id: p.callId,
          type: 'function',
          function: { name: p.name, arguments: JSON.stringify(p.args ?? {}) },
        });
        break;
      case 'toolResult':
        toolResults.push({
          role: 'tool',
          tool_call_id: p.callId,
          content: JSON.stringify(p.result ?? null),
        });
        break;
    }
  }

  const out: ApiMessage[] = [];
  const hasBody = texts.length > 0 || toolCalls.length > 0;

  if (hasBody) {
    out.push({
      role: msg.role,
      content: texts.length > 0 ? texts.join('\n') : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  out.push(...toolResults);
  return out;
}

export function toApiMessages(messages: readonly ModelMessage[]): ApiMessage[] {
  return messages.flatMap(partToApi);
}

export function toApiTools(tools: readonly ModelToolSpec[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
