/**
 * 适配器 · DeepSeek 模型
 *
 * 这是 `core/ports/model.ts` 的真实实现。**唯一允许接触模型厂商 API 的地方。**
 *
 * 依赖注入而非全局单例：密钥从构造函数传入，便于测试与审计。
 * 核心层永远看不到这个文件。
 */

import { ModelError } from '../../core/ports/model.js';
import type {
  ModelCall,
  ModelMessage,
  ModelPart,
  ModelPort,
  ModelResponse,
  ModelToolSpec,
  ModelUsage,
  StructuredCall,
  StructuredResult,
} from '../../core/ports/model.js';

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════

export interface DeepSeekConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  /** 单次请求超时（毫秒） */
  readonly timeoutMs?: number;
  /** 结构化输出的最大重试次数 */
  readonly maxStructuredRetries?: number;
}

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** 从环境变量读取配置。**缺失必填项时直接抛错**，不静默降级。 */
export function deepSeekConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DeepSeekConfig {
  const apiKey = env['DEEPSEEK_API_KEY'];
  if (!apiKey || apiKey.trim() === '') {
    throw new ModelError(
      '缺少 DEEPSEEK_API_KEY。请复制 .env.example 为 .env.local 并填入密钥。',
      'AUTH',
    );
  }
  return {
    apiKey,
    baseUrl: env['DEEPSEEK_BASE_URL'] ?? DEFAULT_DEEPSEEK_BASE_URL,
    model: env['DEEPSEEK_MODEL'] ?? DEFAULT_DEEPSEEK_MODEL,
    timeoutMs: Number(env['MODEL_TIMEOUT_MS'] ?? 90_000),
    maxStructuredRetries: 2,
  };
}

// ═══════════════════════════════════════════════════════════
// 与 OpenAI 兼容协议的映射
// ═══════════════════════════════════════════════════════════

interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface ApiChoice {
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

interface ApiResponse {
  choices?: ApiChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message?: string; type?: string };
}

function partToApi(msg: ModelMessage): ApiMessage[] {
  const texts: string[] = [];
  const toolCalls: ApiMessage['tool_calls'] = [];
  const toolResults: ApiMessage[] = [];

  for (const p of msg.content as readonly ModelPart[]) {
    switch (p.kind) {
      case 'text':
        texts.push(p.text);
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
  const hasBody = texts.length > 0 || (toolCalls && toolCalls.length > 0);
  if (hasBody) {
    out.push({
      role: msg.role,
      content: texts.length > 0 ? texts.join('\n') : null,
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  out.push(...toolResults);
  return out;
}

function toApiMessages(messages: readonly ModelMessage[]): ApiMessage[] {
  return messages.flatMap(partToApi);
}

function toApiTools(tools: readonly ModelToolSpec[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function mapError(status: number, body: ApiResponse | null): ModelError {
  const detail = body?.error?.message ?? `HTTP ${status}`;
  if (status === 401 || status === 403) return new ModelError(`鉴权失败：${detail}`, 'AUTH');
  if (status === 429) return new ModelError(`限流：${detail}`, 'RATE_LIMIT');
  if (status >= 500) return new ModelError(`服务端错误：${detail}`, 'NETWORK');
  return new ModelError(`请求失败：${detail}`, 'UNKNOWN');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════
// 适配器
// ═══════════════════════════════════════════════════════════

export class DeepSeekModel implements ModelPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxStructuredRetries: number;

  constructor(cfg: DeepSeekConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL;
    this.model = cfg.model ?? DEFAULT_DEEPSEEK_MODEL;
    this.timeoutMs = cfg.timeoutMs ?? 90_000;
    this.maxStructuredRetries = cfg.maxStructuredRetries ?? 2;
  }

  describe(): { provider: string; model: string } {
    return { provider: 'deepseek', model: this.model };
  }

  // ── 自由文本 / 工具调用 ──

  async complete(call: ModelCall): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toApiMessages(call.messages),
    };
    if (call.temperature !== undefined) body['temperature'] = call.temperature;
    if (call.maxOutputTokens !== undefined) body['max_tokens'] = call.maxOutputTokens;
    const tools = toApiTools(call.tools);
    if (tools) body['tools'] = tools;

    const data = await this.request(body);
    const choice = data.choices?.[0];
    if (!choice) throw new ModelError('响应中没有 choices', 'BAD_OUTPUT');

    const toolCalls = (choice.message.tool_calls ?? []).map((tc) => {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        // 参数不是合法 JSON —— 保留原始字符串，由调用方决定如何处理
        args = { __raw: tc.function.arguments };
      }
      return { kind: 'toolCall' as const, callId: tc.id, name: tc.function.name, args };
    });

    const finishReason: ModelResponse['finishReason'] =
      toolCalls.length > 0
        ? 'toolCalls'
        : choice.finish_reason === 'length'
          ? 'length'
          : 'stop';

    return {
      text: choice.message.content ?? '',
      toolCalls,
      finishReason,
      usage: this.readUsage(data),
      model: this.model,
    };
  }

  // ── 结构化输出（校验 + 重试）──

  async completeStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    let attempts = 0;
    let lastError = '';
    let lastRaw = '';

    while (attempts <= this.maxStructuredRetries) {
      attempts += 1;

      // 把 schema 描述附在末尾，提高首次命中率
      const schemaHint = this.describeSchema(call.schemaName, call.schema);

      // ⚠️ 关键：重试时必须把「模型上次输出了什么」回喂给它。
      // 只说"不合规"模型只能瞎猜，实测会连续失败三次。
      const correction =
        lastError && lastRaw
          ? `\n\n上次你的输出不合规，请修正。\n【校验错误】${lastError}\n` +
            `【你上次的输出（截断）】\n${lastRaw.slice(0, 600)}`
          : '';

      const messages: ModelMessage[] = [
        ...call.messages,
        {
          role: 'system',
          content: [
            {
              kind: 'text',
              text:
                `你必须只输出一个 JSON 对象，字段为 ${call.schemaName} 的规范。` +
                `不要输出 markdown 代码块、不要任何解释文字。\n${schemaHint}${correction}`,
            },
          ],
        },
      ];

      const body: Record<string, unknown> = {
        model: this.model,
        messages: toApiMessages(messages),
        response_format: { type: 'json_object' },
        max_tokens: call.maxOutputTokens ?? 2048,
      };
      if (call.temperature !== undefined) body['temperature'] = call.temperature;

      const data = await this.request(body);
      const choice = data.choices?.[0];
      const raw = choice?.message.content ?? '';
      const finishReason = choice?.finish_reason ?? 'stop';
      lastRaw = raw;

      // ⚠️ 输出被 max_tokens 截断时，JSON 必然是残缺的。
      // 直接判定为截断并重试（并告知模型要精简），
      // 比让它以"不是合法 JSON"的名义瞎猜有效得多。
      if (finishReason === 'length') {
        lastError = `你的输出被长度上限截断了（已用满 ${body['max_tokens']} tokens）。请大幅精简：只保留结论与关键依据，不要写计算过程和逐条推导。`;
        if (attempts > this.maxStructuredRetries) {
          throw new ModelError(
            `结构化输出重试 ${attempts} 次后仍被长度上限截断。请提高 maxOutputTokens 或精简 schema 要求。`,
            'BAD_OUTPUT',
            attempts,
          );
        }
        await sleep(200 * attempts);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(this.stripCodeFence(raw));
      } catch {
        lastError = '不是合法 JSON';
        if (attempts > this.maxStructuredRetries) {
          throw new ModelError(
            `结构化输出重试 ${attempts} 次后仍不是合法 JSON：${raw.slice(0, 200)}`,
            'BAD_OUTPUT',
            attempts,
          );
        }
        await sleep(200 * attempts);
        continue;
      }

      const result = call.schema.safeParse(parsed);
      if (result.success) {
        return { value: result.data, usage: this.readUsage(data), attempts };
      }

      lastError = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');

      if (attempts > this.maxStructuredRetries) {
        throw new ModelError(
          `结构化输出重试 ${attempts} 次后仍不合规：${lastError}`,
          'BAD_OUTPUT',
          attempts,
        );
      }
      await sleep(200 * attempts);
    }

    // 理论上不可达
    throw new ModelError(`结构化输出失败：${lastError}`, 'BAD_OUTPUT', attempts);
  }

  // ── 内部 ──

  private async request(body: Record<string, unknown>): Promise<ApiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const code =
        err instanceof Error && err.name === 'AbortError'
          ? 'TIMEOUT'
          : ((err as { cause?: { code?: string } }).cause?.code ?? 'NETWORK');
      throw new ModelError(
        `请求失败（${String(code)}）：${err instanceof Error ? err.message : String(err)}`,
        code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK',
      );
    } finally {
      clearTimeout(timer);
    }

    let data: ApiResponse;
    try {
      data = (await res.json()) as ApiResponse;
    } catch {
      throw new ModelError(`响应不是合法 JSON（HTTP ${res.status}）`, 'BAD_OUTPUT');
    }

    if (!res.ok) throw mapError(res.status, data);
    return data;
  }

  private readUsage(data: ApiResponse): ModelUsage {
    return {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }

  /** 模型有时仍会包 ```json 围栏，稳妥剥离 */
  private stripCodeFence(text: string): string {
    const t = text.trim();
    if (!t.startsWith('```')) return t;
    return t
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
  }

  /**
   * 把 Zod schema 转成简短说明附给模型。
   *
   * 只做浅层描述（字段名 + 可选标记），不追求完整 JSON Schema ——
   * 因为 response_format: json_object 已保证是 JSON，
   * 这里的说明只是提高首次命中率、减少重试成本。
   *
   * 实现说明：Zod v3 的 shape 是函数、v4 的 shape 是对象，两种都要兼容；
   * 且刻意用 try/catch 兜底 —— 这个提示是**优化**而非**必需**，
   * 拿不到字段清单时不应该让整个调用失败。
   */
  private describeSchema(name: string, schema: unknown): string {
    try {
      const def = (schema as { _def?: { shape?: unknown } })?._def;
      if (!def) return '';

      const shape = def.shape;
      let keys: string[] = [];

      if (typeof shape === 'function') {
        // Zod v3
        keys = Object.keys((shape as () => Record<string, unknown>)());
      } else if (shape && typeof shape === 'object') {
        // Zod v4
        keys = Object.keys(shape as Record<string, unknown>);
      }

      if (keys.length === 0) return '';
      return `字段清单（${name}）：\n${keys.map((k) => `  - ${k}`).join('\n')}`;
    } catch {
      // 拿不到字段清单不影响正确性 —— schema 校验仍会兜住
      return '';
    }
  }
}
