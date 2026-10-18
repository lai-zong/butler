/**
 * 流式结构化输出 —— 让「模型干活的过程」可见，同时保住结构化契约
 *
 * ★★ 要解决的问题：
 *
 *   `completeStructured` 与流式**天然冲突**：
 *     · 结构化要 `response_format: {type:'json_object'}` + 收完才能解析
 *     · 流式要边收边推
 *   而界面要的正是"仆人干活时能看到它在想什么、调什么工具"。
 *
 * ★ 解法：**契约不变，传输改成流**。
 *   · 请求仍带 `response_format: json_object`（保证模型输出 JSON）
 *   · 但用 stream 收 —— 分片照常推给界面
 *   · 收完再解析 + Zod 校验 + 重试（逻辑与 `completeStructured` 一致）
 *
 *   ⚠️ 界面看到的是**逐字长出来的 JSON**。这**不是** dsh/codex 那种
 *      "思考 → 工具 → 回答"的画面 —— 那是工具循环的形态，见下。
 *
 * ★★ 关于"真正的 AI 客户端形态"的如实说明：
 *
 *   dsh / codex 的画面是：模型**自由**发言（不限定 JSON），
 *   在发言中发起工具调用，工具结果回喂，模型继续发言，循环到收敛。
 *
 *   而本项目仆人必须交**结构化报告**，所以第一版仆人路径只能是
 *   "JSON 逐字长出来"。要出现真正的"思考 + 工具"画面，
 *   **必须在工具循环里让模型自由发言** —— 那是下一步（`agentLoop` 流式化）。
 *
 *   这里先把"流式 + 工具调用"的能力做出来并验证，
 *   因为它同时是两条路径的共同底座。
 */

import type { ZodType } from 'zod';

import type { ClockPort } from '../ports/clock.js';
import { msg, type ModelMessage } from '../ports/model.js';
import type { ModelStreamPort, StreamCall } from '../ports/stream.js';
import { ModelError } from '../ports/model.js';

// ═══════════════════════════════════════════════════════════
// 形状
// ═══════════════════════════════════════════════════════════

/** 流式过程中推给界面的状态。 */
export interface StructuredStreamState {
  /** 思考原文（累计）—— 可能为空（实测模型按任务难度分配思考量） */
  readonly reasoning: string;
  /** 正文原文（累计）—— 结构化场景下是正在长出来的 JSON */
  readonly text: string;
  /** 已拼接的工具调用（累计） */
  readonly toolCalls: readonly {
    readonly callId: string;
    readonly name: string;
    readonly args: string;
  }[];
  /** 是否是"重新生成"（重试时告诉界面：上一次的输出作废了） */
  readonly attempt: number;
  readonly done: boolean;
}

export interface StreamStructuredArgs<T> {
  readonly port: ModelStreamPort;
  readonly clock: ClockPort;
  readonly schema: ZodType<T>;
  readonly schemaName: string;
  readonly messages: readonly ModelMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly maxRetries?: number;
  /** 每次分片更新时回调（供 SSE 推送） */
  readonly onUpdate?: (s: StructuredStreamState) => void;
  /** 取消信号 */
  readonly signal?: AbortSignal;
}

export interface StreamStructuredResult<T> {
  readonly value: T;
  readonly reasoning: string;
  readonly rawText: string;
  readonly attempts: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly finishReason: 'stop' | 'length' | 'toolCalls' | 'error';
}

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════

/** 默认重试次数（与 `DeepSeekModel` 的 `maxStructuredRetries` 一致）。 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * 流式地拿一个结构化结果。
 *
 * ★ 与 `completeStructured` 的三点一致性（刻意对齐，避免两套行为）：
 *   ① 请求带 `response_format: json_object` 的等价约束（用 system 指令表达）
 *   ② 重试时**回喂上次输出**（只说"不合规"模型只能瞎猜）
 *   ③ 检测截断（`finishReason === 'length'`）并告知模型要精简
 *
 * ⚠️ 与 `completeStructured` 的一处**必然差异**：
 *   流式请求**不能**带 `response_format`（某些实现与 stream 不兼容），
 *   所以 JSON 约束靠 system 指令 + 提取兜底。
 *   代价是首次命中率可能略低，靠重试补。
 */
export async function streamStructured<T>(
  args: StreamStructuredArgs<T>,
): Promise<StreamStructuredResult<T>> {
  const maxRetries = args.maxRetries ?? DEFAULT_MAX_RETRIES;
  let attempts = 0;
  let lastError = '';
  let lastRaw = '';

  while (attempts <= maxRetries) {
    attempts += 1;

    const correction =
      lastError.length > 0 && lastRaw.length > 0
        ? `\n\n上次你的输出不合规，请修正。\n【校验错误】${lastError}\n` +
          `【你上次的输出（截断）】\n${lastRaw.slice(0, 600)}`
        : '';

    /**
     * ⚠️ JSON 约束用 system 指令表达，而不是 `response_format`。
     *
     *   理由：流式 + `response_format` 的兼容性因实现而异，
     *   而"收完再解析并重试"这条路本来就兜住了不合规的输出。
     *   宁可多一次重试，也不要一个会偶发失败的请求。
     */
    const messages: ModelMessage[] = [
      ...args.messages,
      msg.system(
        `你必须只输出一个 JSON 对象，符合 ${args.schemaName} 的结构。` +
          `不要输出 markdown 代码块（不要 \`\`\`json 包裹）、不要任何解释文字。` +
          `直接从 { 开始。${correction}`,
      ),
    ];

    const call: StreamCall = {
      purpose: 'execution',
      messages,
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
      ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    };

    let reasoning = '';
    let text = '';
    let finishReason: StreamStructuredResult<T>['finishReason'] = 'stop';
    const usage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls = new Map<string, { name: string; args: string }>();

    const push = (done: boolean): void => {
      try {
        args.onUpdate?.({
          reasoning,
          text,
          toolCalls: [...toolCalls.entries()].map(([callId, v]) => ({
            callId,
            name: v.name,
            args: v.args,
          })),
          attempt: attempts,
          done,
        });
      } catch {
        // 界面出错不影响取结果
      }
    };

    try {
      for await (const chunk of args.port.stream(call)) {
        switch (chunk.kind) {
          case 'reasoning':
            reasoning += chunk.delta;
            push(false);
            break;
          case 'text':
            text += chunk.delta;
            push(false);
            break;
          case 'toolCall': {
            const prev = toolCalls.get(chunk.callId) ?? { name: '', args: '' };
            toolCalls.set(chunk.callId, {
              name: chunk.name.length > 0 ? chunk.name : prev.name,
              args: prev.args + chunk.argsDelta,
            });
            push(false);
            break;
          }
          case 'done':
            finishReason = chunk.finishReason;
            usage.inputTokens = chunk.usage.inputTokens;
            usage.outputTokens = chunk.usage.outputTokens;
            break;
        }
      }
    } catch (err) {
      if (args.signal?.aborted === true) {
        // ⚠️ ModelError 没有 'ABORTED' 码 —— 取消归入 UNKNOWN，
        //    但消息里说清是取消，便于调用方与上层区分处理
        throw new ModelError('流式结构化输出被取消（用户中断或切换会话）', 'UNKNOWN');
      }
      throw err instanceof ModelError
        ? err
        : new ModelError(
            `流式结构化输出失败：${err instanceof Error ? err.message : String(err)}`,
            'NETWORK',
          );
    }

    lastRaw = text;
    push(true);

    // ── 截断检测（与 completeStructured 一致的处理）──
    if (finishReason === 'length') {
      lastError =
        `你的输出被长度上限截断了（已用满 ${args.maxOutputTokens ?? 2048} tokens）。` +
        `请大幅精简：只保留结论与关键依据，不要写计算过程和逐条推导。`;
      if (attempts > maxRetries) {
        throw new ModelError(
          `流式结构化输出重试 ${attempts} 次后仍被长度上限截断。` +
            `请提高 maxOutputTokens 或精简 schema 要求。`,
          'BAD_OUTPUT',
        );
      }
      continue;
    }

    // ── 解析 + 校验 ──
    const parsed = extractJson(text);
    if (parsed === null) {
      lastError = '输出不是合法 JSON（无法从正文中提取出 JSON 对象）。';
      if (attempts > maxRetries) {
        throw new ModelError(
          `流式结构化输出重试 ${attempts} 次后仍无法解析为 JSON。` +
            `原始输出开头：${text.slice(0, 200)}`,
          'BAD_OUTPUT',
        );
      }
      continue;
    }

    const check = args.schema.safeParse(parsed);
    if (!check.success) {
      lastError = check.error.issues
        .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
        .join('；');
      if (attempts > maxRetries) {
        throw new ModelError(
          `流式结构化输出重试 ${attempts} 次后仍不合规：${lastError}`,
          'BAD_OUTPUT',
        );
      }
      continue;
    }

    return {
      value: check.data,
      reasoning,
      rawText: text,
      attempts,
      usage,
      finishReason,
    };
  }

  // 循环必然在上面 return 或 throw，这里只是类型收尾
  throw new ModelError(`流式结构化输出重试 ${attempts} 次后失败：${lastError}`, 'BAD_OUTPUT');
}

// ═══════════════════════════════════════════════════════════
// JSON 提取
// ═══════════════════════════════════════════════════════════

/**
 * 从模型输出里提取 JSON 对象。
 *
 * ★ 为什么需要"提取"而不是直接 `JSON.parse`：
 *   即使 system 里明确说了"不要 ```json 包裹"，模型仍会时不时加上
 *   （这是实测常见的）。直接 parse 会失败，然后白白重试一次。
 *
 * ⚠️ 顺序很重要：先试直接 parse（最理想的情况），
 *    失败了再去掉代码块围栏，最后才做花括号配对扫描。
 *    反过来做会把本该一次成功的解析变慢。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // ① 直接 parse
  const direct = tryParse(trimmed);
  if (direct !== null) return direct;

  // ② 去掉 ```json ... ``` 围栏
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    const inner = tryParse(fenced[1].trim());
    if (inner !== null) return inner;
  }

  // ③ 扫描第一个平衡的 {...}（处理"前面有一段解释文字"的情况）
  const start = trimmed.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return tryParse(trimmed.slice(start, i + 1));
      }
    }
  }

  return null;
}

function tryParse(s: string): unknown {
  if (s.length === 0) return null;
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    return null;
  }
}
