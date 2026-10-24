/**
 * 本地 bge 中文 embedding 适配器。
 *
 * 模型：Xenova/bge-base-zh-v1.5（q8，768 维）
 * 缓存：应用数据目录/models/Xenova/bge-base-zh-v1.5
 *
 * ⚠️ 只在适配器层 import transformers/ONNX；核心 recall 只接收相似度。
 * 模型不存在时明确报错，调用方回退到字面召回 —— 不伪造向量。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { EmbeddingPort } from '../../core/ports/embedding.js';

type TensorLike = { tolist(): unknown };

interface Extractor {
  (texts: readonly string[], opts: { pooling: 'mean'; normalize: boolean }): Promise<TensorLike>;
}

export const LOCAL_EMBEDDING_MODEL = 'Xenova/bge-base-zh-v1.5';
const RELATIVE = join('Xenova', 'bge-base-zh-v1.5');

export class LocalBgeEmbedding implements EmbeddingPort {
  readonly model = LOCAL_EMBEDDING_MODEL;
  private extractor: Promise<Extractor> | null = null;

  constructor(private readonly modelRoot: string) {}

  /** 模型文件是否齐全。 */
  isAvailable(): boolean {
    return (
      existsSync(join(this.modelRoot, RELATIVE, 'config.json')) &&
      existsSync(join(this.modelRoot, RELATIVE, 'tokenizer.json')) &&
      existsSync(join(this.modelRoot, RELATIVE, 'onnx', 'model_quantized.onnx'))
    );
  }

  private async load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      if (!this.isAvailable()) {
        throw new Error(`本地 embedding 模型不存在：${join(this.modelRoot, RELATIVE)}`);
      }
      const { env, pipeline } = await import('@huggingface/transformers');
      // 只允许本地文件；缺失时不要静默联网下载 98MB。
      env.localModelPath = this.modelRoot;
      env.cacheDir = this.modelRoot;
      env.allowRemoteModels = false;
      const p = await pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL, { dtype: 'q8' });
      return p as unknown as Extractor;
    })();
    return this.extractor;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    const rows = out.tolist();
    if (!Array.isArray(rows)) throw new Error('embedding 输出不是二维数组');
    return rows.map((row) => {
      if (!Array.isArray(row)) throw new Error('embedding 行不是数组');
      return row.map((x) => (typeof x === 'number' ? x : Number(x)));
    });
  }
}
