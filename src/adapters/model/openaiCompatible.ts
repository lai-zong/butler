/**
 * OpenAI 兼容模型适配器
 *
 * ★ 为什么不复制一份 DeepSeek 适配器：
 *   DeepSeek 的 HTTP 协议本身就是 OpenAI 兼容的；重复实现会分叉
 *   工具调用、结构化输出、超时等行为。这里只替换 provider 元信息。
 *
 * ⚠️ 这不是“所有厂商自动可用”：模型能力、思考字段、流式分片仍可能不同；
 *    当前只承诺 OpenAI 兼容的**非流式**主模型调用。
 */

import { DeepSeekModel, type DeepSeekConfig } from './deepseek.js';
import { ModelError, type ModelDescription } from '../../core/ports/model.js';

export function openAIConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DeepSeekConfig {
  const apiKey = env['OPENAI_API_KEY'];
  if (!apiKey || apiKey.trim() === '') {
    throw new ModelError(
      '缺少 OPENAI_API_KEY；使用 OpenAI 兼容端点时请配置该变量。',
      'AUTH',
    );
  }
  return {
    apiKey,
    baseUrl: env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
    model: env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
    timeoutMs: Number(env['MODEL_TIMEOUT_MS'] ?? 90_000),
    maxStructuredRetries: 2,
  };
}

export class OpenAICompatibleModel extends DeepSeekModel {
  constructor(
    cfg: DeepSeekConfig,
    private readonly providerName = 'openai-compatible',
  ) {
    // OpenAI 兼容端点不认 DeepSeek 的 thinking / reasoning_effort 字段；
    // 发送它们可能被 400 拒绝，或被不支持的实现静默忽略。
    super({ ...cfg, thinkingParam: false });
  }

  override describe(): ModelDescription {
    return { ...super.describe(), provider: this.providerName };
  }
}
