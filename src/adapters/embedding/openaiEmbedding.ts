/**
 * OpenAI-compatible embeddings 适配器。
 *
 * 只依赖 /embeddings 协议；不把厂商 SDK 带进核心层。
 * 维度校验是刻意的：不同模型/不同维度的向量不能混用。
 */

import type { EmbeddingPort } from '../../core/ports/embedding.js';

export interface OpenAIEmbeddingConfig {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly dimensions: number;
  readonly timeoutMs?: number;
}

interface EmbeddingResponse {
  readonly data?: unknown;
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey.trim().length > 0) headers.Authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

export class OpenAIEmbedding implements EmbeddingPort {
  readonly model: string;
  private readonly endpoint: string;
  private readonly config: OpenAIEmbeddingConfig;

  constructor(config: OpenAIEmbeddingConfig) {
    this.config = config;
    this.model = config.model;
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: authHeaders(this.config.apiKey),
        body: JSON.stringify({
          model: this.config.model,
          input: texts,
          dimensions: this.config.dimensions,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new Error(`无法连接嵌入端点 ${this.endpoint}：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `嵌入请求失败（HTTP ${response.status}）${detail.length > 0 ? `：${detail.slice(0, 240)}` : ''}`,
      );
    }

    const body = (await response.json()) as EmbeddingResponse;
    const rows = Array.isArray(body.data) ? body.data : null;
    if (rows === null || rows.length !== texts.length) {
      throw new Error('嵌入端点返回的向量数量与输入不一致');
    }

    const out: (readonly number[])[] = [];
    for (let i = 0; i < rows.length; i++) {
      const item = rows[i] as { embedding?: unknown; index?: unknown } | null;
      const index = typeof item?.index === 'number' ? item.index : i;
      const vector = item?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error(`嵌入端点返回了空向量（第 ${i + 1} 条）`);
      }
      if (vector.length !== this.config.dimensions) {
        throw new Error(
          `嵌入维度不匹配：配置为 ${this.config.dimensions}，端点返回 ${vector.length}`,
        );
      }
      const numeric = vector.map((x) => (typeof x === 'number' ? x : Number(x)));
      if (numeric.some((x) => !Number.isFinite(x))) {
        throw new Error(`嵌入向量包含非数字值（第 ${i + 1} 条）`);
      }
      out[index] = numeric;
    }
    if (out.some((row) => row === undefined)) throw new Error('嵌入端点返回的向量索引不完整');
    return out;
  }
}
