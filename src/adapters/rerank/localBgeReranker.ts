/**
 * 本地 BGE reranker（cross-encoder）。
 *
 * 与 embedding 重排不同：它直接对 query × 文档成对打分，精度更高但更慢。
 * 模型文件不存在时明确不可用，调用方回退到 embedding 排序。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { env, AutoModelForSequenceClassification, AutoTokenizer } from '@huggingface/transformers';

import type { RerankScorer } from '../../core/memory/rerank.js';
import type { ScoredMemory } from '../../core/memory/recall.js';

export const LOCAL_RERANKER_MODEL = 'Xenova/bge-reranker-base';
const RELATIVE = join('Xenova', 'bge-reranker-base');

type TensorLike = { tolist(): unknown };
interface TokenizerLike {
  (text: string, opts: Record<string, unknown>): unknown;
}
interface ModelLike {
  (inputs: unknown): Promise<{ logits: TensorLike }>;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class LocalBgeReranker implements RerankScorer {
  readonly name = 'local-bge-reranker';
  private tokenizer: TokenizerLike | null = null;
  private model: ModelLike | null = null;

  constructor(private readonly modelRoot: string) {}

  isAvailable(): boolean {
    return (
      existsSync(join(this.modelRoot, RELATIVE, 'config.json')) &&
      existsSync(join(this.modelRoot, RELATIVE, 'tokenizer.json')) &&
      existsSync(join(this.modelRoot, RELATIVE, 'onnx', 'model_quantized.onnx'))
    );
  }

  private async load(): Promise<{ tokenizer: TokenizerLike; model: ModelLike }> {
    if (!this.isAvailable()) {
      throw new Error(`本地 reranker 模型不存在：${join(this.modelRoot, RELATIVE)}`);
    }
    if (this.tokenizer === null || this.model === null) {
      env.localModelPath = this.modelRoot;
      env.cacheDir = this.modelRoot;
      env.allowRemoteModels = false;
      this.tokenizer = (await AutoTokenizer.from_pretrained(
        LOCAL_RERANKER_MODEL,
      )) as unknown as TokenizerLike;
      this.model = (await AutoModelForSequenceClassification.from_pretrained(
        LOCAL_RERANKER_MODEL,
        { dtype: 'q8' },
      )) as unknown as ModelLike;
    }
    return { tokenizer: this.tokenizer, model: this.model };
  }

  async score(
    query: string,
    candidates: readonly ScoredMemory[],
  ): Promise<ReadonlyMap<string, number>> {
    const scores = await this.scoreTexts(
      query,
      candidates.map((candidate) => candidate.memory.content),
    );
    const out = new Map<string, number>();
    for (let i = 0; i < candidates.length; i += 1) {
      const score = scores[i];
      if (score !== undefined) out.set(candidates[i]!.memory.id, score);
    }
    return out;
  }

  /** 文档知识库使用：只对 query × 文本逐对打分，不需要 MemoryEntry。 */
  async scoreTexts(query: string, texts: readonly string[]): Promise<readonly number[]> {
    const { tokenizer, model } = await this.load();
    const out: number[] = [];
    for (const text of texts) {
      const inputs = tokenizer(query, {
        text_pair: text,
        padding: true,
        truncation: true,
      });
      const result = await model(inputs);
      const logits = result.logits.tolist();
      const first = Array.isArray(logits) ? logits[0] : undefined;
      const value = Array.isArray(first) ? first[0] : first;
      out.push(typeof value === 'number' ? sigmoid(value) : 0);
    }
    return out;
  }
}
