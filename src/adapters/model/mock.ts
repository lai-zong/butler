/**
 * 假模型 —— 用于确定性测试
 *
 * 设计依据：ADR 0004（核心层框架无关）；测试策略见 § 16「测试与部署」
 *
 * 两个用途：
 *   ① **逻辑测试不烧 token** —— 反思、编排这类依赖模型的分支，
 *      用固定响应就能验证"输入构造对不对""隔离有没有生效"。
 *   ② **可重放性验证** —— 同一份脚本必然产出同一串响应，
 *      这是"重放两次结果一致"测试的前提。
 *
 * ⚠️ 它**不能**替代真实模型验证。方案 § 16 明确要求"LLM 输出评测"，
 *    那个必须跑真实模型（见 src/validate/）。这里只验证代码逻辑。
 */

import type {
  ModelCall,
  ModelPort,
  ModelResponse,
  StructuredCall,
  StructuredResult,
} from '../../core/ports/model.js';
import type { ZodType } from 'zod';

export interface ScriptedResponse {
  /** 匹配条件：调用用途 */
  readonly purpose?: ModelCall['purpose'];
  /** 匹配条件：提示词里包含任一关键词 */
  readonly containsAny?: readonly string[];
  /** 命中后返回的内容 */
  readonly respond:
    | { readonly kind: 'json'; readonly value: unknown }
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'error'; readonly message: string };
}

export interface MockModelOptions {
  readonly script: readonly ScriptedResponse[];
  /** 脚本没命中时的兜底响应 */
  readonly fallback?: ScriptedResponse['respond'];
  readonly model?: string;
}

interface RecordedCall {
  readonly purpose: ModelCall['purpose'];
  /** 全部消息拼成的一整段文本 —— 断言"模型看到了什么"用这个 */
  readonly prompt: string;
  readonly systemPrompts: readonly string[];
}

export class MockModel implements ModelPort {
  private readonly script: readonly ScriptedResponse[];
  private readonly fallback: ScriptedResponse['respond'];
  private readonly modelName: string;

  /** 记录每次调用的完整提示词，供断言"输入构造是否合规" */
  readonly calls: RecordedCall[] = [];
  /** 累计用量，便于断言 token 控制 */
  private used = 0;

  constructor(opts: MockModelOptions) {
    this.script = opts.script;
    this.fallback = opts.fallback ?? { kind: 'json', value: {} };
    this.modelName = opts.model ?? 'mock-model';
  }

  describe(): { provider: string; model: string } {
    return { provider: 'mock', model: this.modelName };
  }

  async complete(call: ModelCall): Promise<ModelResponse> {
    const prompt = flatten(call);
    this.calls.push({
      purpose: call.purpose,
      prompt,
      systemPrompts: call.messages.filter((m) => m.role === 'system').map(textOf),
    });
    this.used += promote(prompt);

    const hit = this.match(call, prompt);
    if (hit?.kind === 'error') throw new Error(hit.message);
    if (hit?.kind === 'text') {
      return {
        text: hit.text,
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50 },
        model: this.modelName,
      };
    }
    if (hit?.kind === 'json') {
      return {
        text: JSON.stringify(hit.value),
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50 },
        model: this.modelName,
      };
    }
    // 未命中脚本
    const f = this.fallback;
    if (f.kind === 'error') throw new Error(f.message);
    return {
      text: f.kind === 'text' ? f.text : JSON.stringify(f.value),
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: this.modelName,
    };
  }

  async completeStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    const res = await this.complete(call);
    const parsed: unknown = JSON.parse(res.text);
    const result = call.schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`MockModel 脚本输出不合规（${call.schemaName}）：${issues}`);
    }
    return { value: result.data, attempts: 1, usage: res.usage };
  }

  /** 断言辅助：某个 purpose 的调用发生了多少次。 */
  countByPurpose(purpose: ModelCall['purpose']): number {
    return this.calls.filter((c) => c.purpose === purpose).length;
  }

  /** 断言辅助：所有调用里是否出现过某个字符串。 */
  sawText(needle: string): boolean {
    return this.calls.some((c) => c.prompt.includes(needle));
  }

  totalUsage(): number {
    return this.used;
  }

  private match(call: ModelCall, prompt: string): ScriptedResponse['respond'] | null {
    for (const s of this.script) {
      if (s.purpose !== undefined && s.purpose !== call.purpose) continue;
      if (s.containsAny !== undefined && !s.containsAny.some((k) => prompt.includes(k))) continue;
      return s.respond;
    }
    return null;
  }
}

/** 把一次调用的全部消息拼成可搜索的文本。 */
function flatten(call: ModelCall): string {
  return call.messages
    .map((m) =>
      m.content
        .map((p) => ('text' in p ? p.text : JSON.stringify(p)))
        .join('\n'),
    )
    .join('\n---\n');
}

function textOf(m: ModelCall['messages'][number]): string {
  return m.content.map((p) => ('text' in p ? p.text : '')).join('\n');
}

/** 粗略估算 token（4 字符 ≈ 1 token），仅用于相对比较。 */
function promote(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 便捷构造：一个直接返回 JSON 的脚本条目。 */
export function respondJson(value: unknown, purpose?: ModelCall['purpose']): ScriptedResponse {
  return { respond: { kind: 'json', value }, ...(purpose !== undefined ? { purpose } : {}) };
}

/** 便捷构造：按关键词匹配的脚本条目。 */
export function respondJsonWhen(
  containsAny: readonly string[],
  value: unknown,
  purpose?: ModelCall['purpose'],
): ScriptedResponse {
  return {
    containsAny,
    respond: { kind: 'json', value },
    ...(purpose !== undefined ? { purpose } : {}),
  };
}

/** 便捷构造：模型调用失败（用于测降级路径）。 */
export function respondError(message: string, purpose?: ModelCall['purpose']): ScriptedResponse {
  return { respond: { kind: 'error', message }, ...(purpose !== undefined ? { purpose } : {}) };
}

/** 类型辅助：把 schema 类型暴露出去，便于测试里显式标注。 */
export type AnySchema = ZodType<unknown>;
